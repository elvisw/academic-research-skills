import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildGuardPayload,
  parseGuardOutput,
  WriteScopeGuard,
} from "../src/guard.ts";
import {
  discoverInterpreter,
  isolatedPythonEnv,
  runPythonFile,
} from "../src/script-runner.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("guard output parser accepts only the source contract", () => {
  assert.deepEqual(
    parseGuardOutput(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "out of scope",
        },
      }),
    ),
    { deny: true, reason: "out of scope" },
  );
  assert.deepEqual(
    parseGuardOutput('{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}'),
    { deny: false },
  );
  assert.equal(
    parseGuardOutput(
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}',
    ),
    null,
  );
  assert.equal(parseGuardOutput("not json"), null);
  assert.equal(parseGuardOutput(""), null);
});

test("payload translation uses trusted IDs and host resources", () => {
  const payload = buildGuardPayload({
    action: "edit",
    resource: "phase1_x/a.md",
    agent: "research-architect-agent",
    projectRoot: "C:/work",
    toolName: "Write",
  });
  assert.deepEqual(payload, {
    cwd: "C:/work",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "phase1_x/a.md" },
    agent_type: "research-architect-agent",
  });
  const shell = buildGuardPayload({
    action: "shell",
    resource: "ls",
    projectRoot: "C:/work",
    toolName: "Bash",
  });
  assert.deepEqual(shell.tool_input, { command: "ls" });
  assert.equal("agent_type" in shell, false);
});

test("child environment drops ambient CLAUDE_* and sets both roots", () => {
  const env = isolatedPythonEnv({
    packageRoot: "C:/ars",
    projectRoot: "C:/work",
    base: {
      PATH: "/bin",
      CLAUDE_PLUGIN_ROOT: "C:/attacker",
      CLAUDE_PROJECT_DIR: "C:/elsewhere",
      CLAUDE_SESSION_ID: "x",
      HOME: "/home",
    },
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home");
  assert.equal(env.CLAUDE_PLUGIN_ROOT, "C:/ars");
  assert.equal(env.CLAUDE_PROJECT_DIR, "C:/work");
  assert.equal(env.ARS_PLUGIN_ROOT, "C:/ars");
  assert.equal(env.ARS_PROJECT_DIR, "C:/work");
  assert.equal(env.CLAUDE_SESSION_ID, undefined);
});

test("no interpreter means pass-through with a visible degraded status", async () => {
  const guard = new WriteScopeGuard({
    packageRoot: repoRoot,
    projectRoot: repoRoot,
    interpreter: null,
  });
  const decision = await guard.evaluate({
    action: "edit",
    resources: ["phase3_x/a.md"],
    agent: "research-architect-agent",
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.degraded, true);
  assert.match(decision.degradedReason ?? "", /no real Python/);
  assert.equal(guard.status().state, "degraded");
});

test("missing guard script means pass-through", async () => {
  const guard = new WriteScopeGuard({
    packageRoot: repoRoot,
    projectRoot: repoRoot,
    guardScript: join(repoRoot, "scripts", "does-not-exist.py"),
    interpreter: null,
  });
  const status = await guard.probe();
  assert.equal(status.state, "degraded");
  assert.match(status.reason ?? "", /guard script not found/);
});

test("real policy: in-scope writes pass, out-of-scope and shell writes deny", async (t) => {
  const interpreter = await discoverInterpreter();
  if (!interpreter) {
    t.skip("no real Python interpreter on this machine");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "ars-guard-"));
  mkdirSync(join(workspace, "phase1_draft"), { recursive: true });
  mkdirSync(join(workspace, "phase3_analysis"), { recursive: true });
  try {
    const guard = new WriteScopeGuard({
      packageRoot: repoRoot,
      projectRoot: workspace,
      interpreter,
      timeoutMs: 10_000,
    });

    const inScope = await guard.evaluate({
      action: "edit",
      resources: [join(workspace, "phase1_draft", "notes.md")],
      agent: "research-architect-agent",
    });
    assert.equal(inScope.decision, "allow");
    assert.equal(inScope.degraded, false);

    const outOfScope = await guard.evaluate({
      action: "edit",
      resources: [join(workspace, "phase3_analysis", "synthesis.md")],
      agent: "research-architect-agent",
    });
    assert.equal(outOfScope.decision, "deny");
    assert.match(outOfScope.reason ?? "", /may not write/);

    const infra = await guard.evaluate({
      action: "edit",
      resources: [join(repoRoot, "hooks", "hooks.json")],
      agent: "build",
    });
    assert.equal(infra.decision, "deny");
    assert.match(infra.reason ?? "", /enforcement infrastructure/);

    const shell = await guard.evaluate({
      action: "shell",
      resources: ["printf hi > phase3_analysis/x.md"],
      agent: "research-architect-agent",
    });
    assert.equal(shell.decision, "deny");
    assert.match(shell.reason ?? "", /may not use Bash/);

    const mainSession = await guard.evaluate({
      action: "edit",
      resources: [join(workspace, "phase3_analysis", "synthesis.md")],
      agent: "build",
    });
    assert.equal(mainSession.decision, "allow");

    // All targets are checked: one forbidden target denies the whole patch.
    const patch = await guard.evaluate({
      action: "edit",
      resources: [
        join(workspace, "phase1_draft", "ok.md"),
        join(workspace, "phase3_analysis", "bad.md"),
      ],
      agent: "research-architect-agent",
    });
    assert.equal(patch.decision, "deny");
    assert.equal(guard.status().state, "active");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("guard timeout and malformed output degrade instead of blocking", async (t) => {
  const interpreter = await discoverInterpreter();
  if (!interpreter) {
    t.skip("no real Python interpreter on this machine");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "ars-guard-"));
  try {
    const slow = join(workspace, "slow.py");
    writeFileSync(slow, "import time\ntime.sleep(5)\n", "utf8");
    const slowGuard = new WriteScopeGuard({
      packageRoot: repoRoot,
      projectRoot: workspace,
      interpreter,
      guardScript: slow,
      timeoutMs: 200,
    });
    const timedOut = await slowGuard.evaluate({
      action: "edit",
      resources: [join(workspace, "x.md")],
      agent: "research-architect-agent",
    });
    assert.equal(timedOut.decision, "allow");
    assert.equal(timedOut.degraded, true);
    assert.match(timedOut.degradedReason ?? "", /timed out/);

    const noise = join(workspace, "noise.py");
    writeFileSync(noise, "print('hello')\n", "utf8");
    const noisyGuard = new WriteScopeGuard({
      packageRoot: repoRoot,
      projectRoot: workspace,
      interpreter,
      guardScript: noise,
      timeoutMs: 5_000,
    });
    const unparseable = await noisyGuard.evaluate({
      action: "edit",
      resources: [join(workspace, "x.md")],
      agent: "research-architect-agent",
    });
    assert.equal(unparseable.decision, "allow");
    assert.equal(unparseable.degraded, true);
    assert.match(unparseable.degradedReason ?? "", /unparseable/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("move/delete targets and user files with infra names follow the source scope", async (t) => {
  const interpreter = await discoverInterpreter();
  if (!interpreter) {
    t.skip("no real Python interpreter on this machine");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "ars-guard-"));
  mkdirSync(join(workspace, "phase1_draft"), { recursive: true });
  mkdirSync(join(workspace, "hooks"), { recursive: true });
  try {
    const guard = new WriteScopeGuard({
      packageRoot: repoRoot,
      projectRoot: workspace,
      interpreter,
      timeoutMs: 10_000,
    });

    // A patch that moves a file out of the owned phase is refused, because all
    // resource targets are checked before the host mutates anything.
    const move = await guard.evaluate({
      action: "edit",
      resources: [
        join(workspace, "phase1_draft", "draft.md"),
        join(workspace, "phase2_other", "draft.md"),
      ],
      agent: "research-architect-agent",
    });
    assert.equal(move.decision, "deny");

    // A delete inside the owned phase is a normal in-scope target.
    const deletion = await guard.evaluate({
      action: "edit",
      resources: [join(workspace, "phase1_draft", "obsolete.md")],
      agent: "research-architect-agent",
    });
    assert.equal(deletion.decision, "allow");

    // A user file merely named like plugin infrastructure is not plugin
    // infrastructure, and the main session may write it.
    const userInfraName = await guard.evaluate({
      action: "edit",
      resources: [join(workspace, "hooks", "hooks.json")],
      agent: "build",
    });
    assert.equal(userInfraName.decision, "allow");

    // A malformed empty target is a schema-drift deny, not a pass-through.
    const emptyTarget = await guard.evaluate({
      action: "edit",
      resources: [""],
      agent: "research-architect-agent",
    });
    assert.equal(emptyTarget.decision, "deny");
    assert.match(emptyTarget.reason ?? "", /no top-level file_path/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("missing targets degrade visibly without being confused with a missing interpreter", async () => {
  const guard = new WriteScopeGuard({
    packageRoot: repoRoot,
    projectRoot: repoRoot,
    interpreter: null,
  });
  const noTargets = await guard.evaluate({
    action: "edit",
    resources: [],
    agent: "research-architect-agent",
  });
  assert.equal(noTargets.decision, "allow");
  assert.equal(noTargets.degraded, true);
  assert.match(noTargets.degradedReason ?? "", /no edit targets/);

  const noPython = await guard.evaluate({
    action: "edit",
    resources: ["phase1_x/a.md"],
    agent: "research-architect-agent",
  });
  assert.match(noPython.degradedReason ?? "", /no real Python interpreter/);
});

test("nothing is inspected for non-mutation actions", async () => {
  const guard = new WriteScopeGuard({
    packageRoot: repoRoot,
    projectRoot: repoRoot,
    interpreter: null,
  });
  const read = await guard.evaluate({
    action: "read",
    resources: ["anything"],
    agent: "research-architect-agent",
  });
  assert.deepEqual(read, { decision: "allow", degraded: false });
});

test("real CLI wrappers import their sibling modules", async () => {
  const interpreter = await discoverInterpreter({ timeoutMs: 3_000 });
  assert.ok(interpreter, "a real Python interpreter is required for this test");
  const result = await runPythonFile({
    interpreter,
    script: join(repoRoot, "scripts", "ars_mark_read.py"),
    argv: ["--help"],
    cwd: repoRoot,
    env: isolatedPythonEnv({ packageRoot: repoRoot, projectRoot: repoRoot }),
    timeoutMs: 30_000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /usage:/);
});

test("an unreadable manifest is a visible degradation, not active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ars-guard-manifest-"));
  const scripts = join(dir, "scripts");
  const project = join(dir, "project");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(project, { recursive: true });
  copyFileSync(
    join(repoRoot, "scripts", "ars_write_scope_guard.py"),
    join(scripts, "ars_write_scope_guard.py"),
  );
  try {
    const guard = new WriteScopeGuard({
      packageRoot: dir,
      projectRoot: project,
      guardScript: join(scripts, "ars_write_scope_guard.py"),
    });
    await guard.probe();
    const decision = await guard.evaluate({
      action: "edit",
      resources: [join(project, "phase1_x", "a.md")],
      agent: "research-architect-agent",
    });
    assert.equal(decision.decision, "allow");
    assert.equal(decision.degraded, true);
    assert.match(decision.degradedReason ?? "", /manifest/);
    assert.equal(guard.status().state, "degraded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
