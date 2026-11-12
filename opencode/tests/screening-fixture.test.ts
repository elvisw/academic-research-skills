import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  parseExpectedIds,
  planScreening,
  roleOf,
  runScreening,
  type ScreeningPort,
} from "../src/screening.ts";
import {
  discoverInterpreter,
  runPythonFile,
} from "../src/script-runner.ts";
import type { ModelRef } from "../src/setup.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const ROLE_MODEL: ModelRef = { providerID: "fixture", model: "model" };
const ROLE_MODELS = Object.fromEntries(
  ["A", "B", "ADJ", "QC", "FTA", "FTB", "FTADJ"].map((role) => [
    role,
    ROLE_MODEL,
  ]),
);
const AVAILABLE = [{ providerID: "fixture", id: "model" }];

interface Fixture {
  root: string;
  work: string;
  emit: string;
  config: string;
  protocol: string;
  taContext: string;
  ftContext: string;
}

async function emitFixture(relativeEmit = false): Promise<Fixture> {
  const interpreter = await discoverInterpreter();
  if (!interpreter) throw new Error("no Python interpreter");
  const root = mkdtempSync(join(tmpdir(), "ars-real-fixture-"));
  const work = join(root, "work");
  const emit = join(root, "emit");
  const result = await runPythonFile({
    interpreter,
    script: join(here, "fixtures", "emit_screening_fixture.py"),
    argv: [
      "--repo",
      repoRoot,
      "--work",
      work,
      "--emit",
      emit,
      ...(relativeEmit ? ["--relative-emit"] : []),
    ],
    cwd: repoRoot,
    env: process.env,
    timeoutMs: 60_000,
  });
  if (result.code !== 0) {
    throw new Error(`fixture generator failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout.trim()) as {
    ta_context: string;
    ft_context: string;
    config: string;
    protocol: string;
  };
  return {
    root,
    work,
    emit,
    config: parsed.config,
    protocol: parsed.protocol,
    taContext: parsed.ta_context,
    ftContext: parsed.ft_context,
  };
}

interface FakePort extends ScreeningPort {
  created: string[];
  models: { providerID: string; model: string }[];
  prompts: { sessionID: string; text: string }[];
  removed: string[];
}

function fakePort(reply: (prompt: string) => string): FakePort {
  const created: string[] = [];
  const models: { providerID: string; model: string }[] = [];
  const prompts: { sessionID: string; text: string }[] = [];
  const removed: string[] = [];
  const current = new Map<string, { providerID: string; id: string }>();
  return {
    created,
    models,
    prompts,
    removed,
    async create() {
      const id = `ses-${created.length + 1}`;
      created.push(id);
      return id;
    },
    async switchAgent() {},
    async switchModel(sessionID, ref) {
      models.push({ providerID: ref.providerID, model: ref.model });
      current.set(sessionID, { providerID: ref.providerID, id: ref.model });
    },
    async sessionModel(sessionID) {
      return current.get(sessionID);
    },
    async prompt(sessionID, text) {
      prompts.push({ sessionID, text });
    },
    async wait() {},
    async lastAssistantText(sessionID) {
      const prompt = prompts.filter((entry) => entry.sessionID === sessionID).at(-1);
      return reply(prompt?.text ?? "");
    },
    async remove(sessionID) {
      removed.push(sessionID);
    },
  };
}

function decisionsFor(
  prompt: string,
  decisions: Record<string, { d: string; code: string }>,
): string {
  const ids = parseExpectedIds(prompt) ?? [];
  return JSON.stringify({
    decisions: ids.map((id) => ({
      id,
      d: decisions[id]?.d ?? "include",
      code: decisions[id]?.code ?? "INC",
      why: "fixture decision",
    })),
  });
}

test("a relative production export resolves prompts from a foreign cwd", async () => {
  const fixture = await emitFixture(true);
  try {
    for (const stage of ["ta", "ft"] as const) {
      const emitDir = join(fixture.emit, stage);
      const index = JSON.parse(
        readFileSync(join(emitDir, "index.json"), "utf8"),
      ) as { prompt_file: string }[];
      assert.ok(index.length > 0);
      assert.ok(
        index.every((entry) => !isAbsolute(entry.prompt_file)),
        "the production exporter stores a relative out_dir verbatim",
      );
      const plan = planScreening({
        stage,
        workDir: fixture.work,
        emitDir,
        roleModels: ROLE_MODELS,
        availableModels: AVAILABLE,
      });
      assert.deepEqual(plan.missingFiles, [], stage);
      assert.ok(
        plan.entries.every(
          (entry) =>
            isAbsolute(entry.prompt_file) && existsSync(entry.prompt_file),
        ),
        `${stage} prompts resolve inside the emit directory`,
      );
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("real Python TA/ADJ/QC prompts dispatch with routed role models and merge", async (t) => {
  const interpreter = await discoverInterpreter();
  if (!interpreter) {
    t.skip("no real Python interpreter on this machine");
    return;
  }
  const fixture = await emitFixture();
  const out = join(fixture.work, "opencode_results.json");
  try {
    const plan = planScreening({
      stage: "ta",
      workDir: fixture.work,
      emitDir: join(fixture.emit, "ta"),
      roleModels: ROLE_MODELS,
      availableModels: AVAILABLE,
    });
    assert.equal(plan.contextID, fixture.taContext);
    assert.equal(plan.calls, 4);
    assert.equal(plan.maxCalls, 8);
    assert.deepEqual(plan.roleCounts, { A: 1, B: 1, ADJ: 1, QC: 1 });
    assert.deepEqual(plan.missingModels, []);
    assert.deepEqual(plan.missingFiles, []);

    const port = fakePort((prompt) => {
      if (prompt.includes("REVIEWER A")) {
        return decisionsFor(prompt, {
          R00001: { d: "include", code: "INC" },
          R00002: { d: "include", code: "INC" },
        });
      }
      if (prompt.includes("REVIEWER B")) {
        return decisionsFor(prompt, {
          R00001: { d: "exclude", code: "E1" },
          R00002: { d: "include", code: "INC" },
        });
      }
      if (prompt.includes("THIRD REVIEWER")) {
        return decisionsFor(prompt, {
          R00001: { d: "include", code: "INC" },
        });
      }
      return decisionsFor(prompt, {
        R00002: { d: "include", code: "INC" },
      });
    });

    const result = await runScreening({
      plan,
      workDir: fixture.work,
      outFile: out,
      port,
      approve: true,
      roleModels: ROLE_MODELS,
      availableModels: AVAILABLE,
    });
    assert.equal(result.calls, 4);
    assert.deepEqual(result.pending, []);
    assert.equal(port.created.length, 4);
    assert.deepEqual(
      port.models,
      Array.from({ length: 4 }, () => ROLE_MODEL),
    );
    assert.deepEqual(
      result.results.map((entry) => roleOf(entry.label)).sort(),
      ["A", "ADJ", "B", "QC"],
    );

    // The real merge script must consume the adapter's output.
    const merge = await runPythonFile({
      interpreter,
      script: join(repoRoot, "sr-screener", "scripts", "merge_decisions.py"),
      argv: [
        "--work",
        fixture.work,
        "--from",
        out,
        "--config",
        fixture.config,
        "--protocol",
        fixture.protocol,
        "--stage",
        "ta",
      ],
      cwd: repoRoot,
      env: process.env,
      timeoutMs: 60_000,
    });
    assert.equal(
      merge.code,
      0,
      `merge_decisions failed:\n${merge.stdout}\n${merge.stderr}`,
    );
    const decisions = JSON.parse(
      readFileSync(join(fixture.work, "decisions.json"), "utf8"),
    ) as Record<string, { final?: { d?: string } }>;
    assert.equal(decisions.R00001?.final?.d, "include");
    const audit = JSON.parse(
      readFileSync(out.replace(/\.json$/, ".audit.json"), "utf8"),
    ) as { context_id: string; max_calls: number; pending: unknown[] };
    assert.equal(audit.context_id, fixture.taContext);
    assert.equal(audit.max_calls, 8);
    assert.deepEqual(audit.pending, []);
    assert.equal(decisions.R00002?.final?.d, "include");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("real Python FT prompts dispatch with routed role models", async (t) => {
  const interpreter = await discoverInterpreter();
  if (!interpreter) {
    t.skip("no real Python interpreter on this machine");
    return;
  }
  const fixture = await emitFixture();
  try {
    const plan = planScreening({
      stage: "ft",
      workDir: fixture.work,
      emitDir: join(fixture.emit, "ft"),
      roleModels: ROLE_MODELS,
      availableModels: AVAILABLE,
    });
    assert.equal(plan.contextID, fixture.ftContext);
    assert.equal(plan.calls, 3);
    assert.equal(plan.maxCalls, 6);
    assert.deepEqual(plan.roleCounts, { FTA: 1, FTB: 1, FTADJ: 1 });
    assert.deepEqual(plan.unreadablePdfs, []);

    const port = fakePort((prompt) =>
      decisionsFor(prompt, { R00001: { d: "include", code: "INC" } }),
    );
    const result = await runScreening({
      plan,
      workDir: fixture.work,
      outFile: join(fixture.work, "opencode_ft.json"),
      port,
      approve: true,
      roleModels: ROLE_MODELS,
      availableModels: AVAILABLE,
    });
    assert.deepEqual(result.pending, []);
    assert.deepEqual(
      port.models,
      Array.from({ length: 3 }, () => ROLE_MODEL),
    );
    assert.deepEqual(
      result.results.map((entry) => roleOf(entry.label)).sort(),
      ["FTA", "FTADJ", "FTB"],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
