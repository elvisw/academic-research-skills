import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pluginDefinition from "../index.ts";
import {
  checkPythonModule,
  discoverInterpreter,
  runPythonFile,
} from "../src/script-runner.ts";
import { loadNativeAgents } from "../src/setup.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A small in-memory host. It exercises the real setup path (transforms, hooks,
 * tool registration) without a running OpenCode server.
 */
function fakeHost(
  options: {
    aliases?: Record<string, { providerID: string; model: string }>;
    assertReject?: string;
    existingCommands?: { name: string; description?: string }[];
    sessionAgent?: string;
    sessionGetError?: string;
  } = {},
) {
  const skills: unknown[] = [];
  const commands: {
    name: string;
    description?: string;
    execute: (input: {
      sessionID: string;
      prompt: { text: string; files?: unknown[] };
      delivery: "steer" | "queue";
    }) => Promise<void>;
  }[] = [];
  const tools: { name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }[] = [];
  const prompts: { sessionID: string; text: string; metadata?: unknown }[] = [];
  const synthetic: string[] = [];
  const assertCalls: { action: string; resources: string[]; agent?: string }[] = [];
  const sessionHooks = new Map<string, (event: Record<string, unknown>) => void>();
  let sessionsCreated = 0;
  let permissionHook:
    | ((event: {
        action: string;
        resources: string[];
        agent?: string;
        effect: string;
        message?: string;
      }) => Promise<void>)
    | undefined;
  let shellHook:
    | ((event: { env: Record<string, string | undefined> }) => Promise<void>)
    | undefined;

  const registration = { dispose: async () => {} };
  const ctx = {
    options: {
      repoRoot,
      ...(options.aliases ? { models: { aliases: options.aliases } } : {}),
    },
    location: { directory: repoRoot, project: { canonical: repoRoot } },
    agent: { list: async () => ({ data: [] }) },
    skill: {
      list: async () => ({ data: skills as { id: string; content: string }[] }),
      transform: async (callback: (editor: { add: (skill: unknown) => void }) => void) => {
        callback({ add: (skill) => skills.push(skill) });
        return registration;
      },
    },
    command: {
      list: async () => ({
        data: [...(options.existingCommands ?? []), ...commands],
      }),
      transform: async (
        callback: (editor: {
          add: (command: (typeof commands)[number]) => void;
        }) => void,
      ) => {
        callback({ add: (command) => commands.push(command) });
        return registration;
      },
    },
    tool: {
      transform: async (
        callback: (editor: {
          add: (tool: (typeof tools)[number]) => void;
          namespace: () => void;
          list: () => unknown[];
          get: () => undefined;
          update: () => void;
          remove: () => void;
        }) => void,
      ) => {
        callback({
          add: (tool) => tools.push(tool),
          namespace: () => {},
          list: () => [],
          get: () => undefined,
          update: () => {},
          remove: () => {},
        });
        return registration;
      },
    },
    model: {
      list: async () => ({
        data: [
          { providerID: "anthropic", id: "claude-sonnet-4-5" },
          { providerID: "anthropic", id: "claude-opus-4-1" },
          { providerID: "other", id: "model" },
        ],
      }),
    },
    permission: {
      hook: async (
        name: string,
        callback: typeof permissionHook,
      ) => {
        if (name === "evaluate") permissionHook = callback;
        return registration;
      },
      assert: async (input: {
        action: string;
        resources: readonly string[];
        agent?: string;
      }) => {
        assertCalls.push({
          action: input.action,
          resources: [...input.resources],
          agent: input.agent,
        });
        if (options.assertReject) throw new Error(options.assertReject);
      },
    },
    shell: {
      hook: async (name: string, callback: typeof shellHook) => {
        if (name === "create.before") shellHook = callback;
        return registration;
      },
    },
    event: {
      subscribe: (options: { signal?: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!options.signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        },
      }),
    },
    session: {
      hook: async (
        name: string,
        callback: (event: Record<string, unknown>) => void,
      ) => {
        sessionHooks.set(name, callback);
        return registration;
      },
      prompt: async (input: {
        sessionID: string;
        text: string;
        metadata?: unknown;
      }) => {
        prompts.push(input);
      },
      synthetic: async (input: { text: string }) => {
        synthetic.push(input.text);
      },
      get: async () => {
        if (options.sessionGetError) throw new Error(options.sessionGetError);
        return {
          id: "ses-1",
          agent: options.sessionAgent ?? "build",
          model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
        };
      },
      create: async () => {
        sessionsCreated += 1;
        return { id: `ses-${sessionsCreated + 1}` };
      },
      switchAgent: async () => {},
      switchModel: async () => {},
      wait: async () => {},
      context: async () => {
        const last = prompts.at(-1);
        return last
          ? [
              {
                id: `m-${prompts.length}`,
                type: "user",
                metadata: last.metadata,
              },
            ]
          : [];
      },
      remove: async () => {},
    },
  };

  return {
    ctx,
    skills,
    commands,
    tools,
    prompts,
    synthetic,
    assertCalls,
    sessionHooks,
    sessionsCreated: () => sessionsCreated,
    permissionHook: () => permissionHook,
    shellHook: () => shellHook,
  };
}

test("setup registers the whole catalog and the hooks on a V2 host", async () => {
  const host = fakeHost();
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);

  assert.equal(host.skills.length, 5);
  assert.equal(host.commands.length, 16);
  assert.deepEqual(
    host.tools.map((tool) => tool.name).sort(),
    ["ars_opencode_status", "ars_run_script", "ars_screening"],
  );
  assert.ok(host.commands.some((command) => command.name === "ars-full"));
  assert.ok(host.commands.some((command) => command.name === "ars-mark-read"));
  assert.equal(typeof host.permissionHook(), "function");
  assert.equal(typeof host.shellHook(), "function");

  await cleanup();
});

test("setup refuses a command collision instead of a partial install", async () => {
  const host = fakeHost({
    existingCommands: [{ name: "ars-full", description: "local command" }],
  });
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  await assert.rejects(
    () => setup(host.ctx),
    /refused to register because the installation check failed/,
  );
  assert.equal(host.skills.length, 0);
  assert.equal(host.commands.length, 0);
  assert.equal(host.tools.length, 0);
});

test("the status tool lists agents and returns one complete fragment at a time", async () => {
  const host = fakeHost();
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);
  try {
    const tool = host.tools.find(
      (candidate) => candidate.name === "ars_opencode_status",
    );
    assert.ok(tool);
    const specs = loadNativeAgents(repoRoot, repoRoot, {}, []).agents;
    assert.equal(specs.length, 4);

    const plain = (await tool.execute({}, {
      sessionID: "ses-1",
      agent: "build",
    })) as { content: string; metadata: { ok: boolean; agents: string[] } };
    assert.match(plain.content, /command ars-full is owned by this adapter/);
    assert.doesNotMatch(
      plain.content,
      /command ars-full already exists outside this adapter/,
    );
    assert.match(plain.content, /Read-only check/);
    assert.equal(plain.metadata.ok, false);
    assert.deepEqual(
      plain.metadata.agents,
      specs.map((agent) => agent.id),
    );
    assert.doesNotMatch(plain.content, /ARS_FRAGMENT_JSON/);
    for (const spec of specs) {
      assert.equal(
        plain.content.includes(spec.system),
        false,
        `the summary must not carry ${spec.id}'s full system`,
      );
      assert.match(plain.content, new RegExp(spec.id));
    }

    for (const spec of specs) {
      const result = (await tool.execute(
        { agent: spec.id },
        { sessionID: "ses-1", agent: "build" },
      )) as { content: string; metadata: { agent: string } };
      assert.equal(result.metadata.agent, spec.id);
      assert.ok(
        result.content.length < 50_000,
        `${spec.id} fragment is ${result.content.length} characters`,
      );
      assert.match(result.content, /model: inherit|model: \{/);
      const start = result.content.indexOf("<<<ARS_FRAGMENT_JSON\n");
      const end = result.content.indexOf("\nARS_FRAGMENT_JSON>>>");
      assert.ok(start !== -1 && end > start, `${spec.id} fragment JSON block`);
      const fragment = JSON.parse(
        result.content.slice(start + "<<<ARS_FRAGMENT_JSON\n".length, end),
      ) as {
        plugins: unknown[];
        agents: Record<
          string,
          {
            system: string;
            permissions: unknown[];
            model?: unknown;
          }
        >;
      };
      assert.ok(Array.isArray(fragment.plugins) && fragment.plugins.length === 1);
      const entry = fragment.agents[spec.id];
      assert.ok(entry, `fragment carries agents.${spec.id}`);
      assert.equal(entry.system, spec.system);
      assert.ok(Array.isArray(entry.permissions) && entry.permissions.length > 0);
    }
  } finally {
    await cleanup();
  }
});

test("an /ars-full invocation renders the source body plus the host note", async () => {
  const host = fakeHost();
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);
  try {
    const full = host.commands.find((command) => command.name === "ars-full");
    assert.ok(full);
    await full.execute({
      sessionID: "ses-1",
      prompt: { text: "write a review about X" },
      delivery: "steer",
    });
    assert.equal(host.prompts.length, 1);
    assert.match(host.prompts[0]?.text ?? "", /academic-pipeline/);
    assert.match(host.prompts[0]?.text ?? "", /User request \/ arguments:/);
    assert.match(host.prompts[0]?.text ?? "", /Academic Research Skills compatibility/);
    assert.match(host.prompts[0]?.text ?? "", /write a review about X/);
    const metadata = host.prompts[0]?.metadata as {
      ars?: { command?: string };
    };
    assert.equal(metadata.ars?.command, "ars-full");
  } finally {
    await cleanup();
  }
});

test("the script tool rejects an unknown script without executing", async () => {
  const host = fakeHost();
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);
  try {
    const tool = host.tools.find((candidate) => candidate.name === "ars_run_script");
    assert.ok(tool);
    const result = (await tool.execute(
      { script: "rm_rf", argv: [] },
      { sessionID: "ses-1", agent: "build" },
    )) as { content: string; metadata: { status: string } };
    assert.equal(result.metadata.status, "rejected");
    assert.match(result.content, /unknown script/);
  } finally {
    await cleanup();
  }
});

test("native ARS agents cannot call the adapter mutation tools", async () => {
  const host = fakeHost();
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);
  try {
    const runScript = host.tools.find(
      (candidate) => candidate.name === "ars_run_script",
    );
    const screening = host.tools.find(
      (candidate) => candidate.name === "ars_screening",
    );
    assert.ok(runScript && screening);
    const specs = loadNativeAgents(repoRoot, repoRoot, {}, []).agents;
    const beforeAsserts = host.assertCalls.length;
    const beforeSessions = host.sessionsCreated();

    for (const spec of specs) {
      const runResult = (await runScript.execute(
        { script: "ars_cache_invalidate", argv: ["10.1000/x"] },
        { sessionID: "ses-1", agent: spec.id },
      )) as { content: string; metadata: { status: string } };
      assert.equal(runResult.metadata.status, "denied", spec.id);
      assert.match(runResult.content, /limited to its source tool list/);

      const screenResult = (await screening.execute(
        { stage: "ta", work: repoRoot, emit: repoRoot },
        { sessionID: "ses-1", agent: spec.id },
      )) as { content: string; metadata: { status: string } };
      assert.equal(screenResult.metadata.status, "denied", spec.id);
      assert.match(screenResult.content, /limited to its source tool list/);
    }

    assert.equal(host.assertCalls.length, beforeAsserts);
    assert.equal(host.sessionsCreated(), beforeSessions);
    assert.equal(host.prompts.length, 0);

    // The main session is not one of the four native agents: it reaches the
    // normal planning path (and stops there because this fixture has no index).
    (host.ctx.agent as {
      list: () => Promise<{ data: { id: string }[] }>;
    }).list = async () => {
      const reviewer = loadNativeAgents(repoRoot, repoRoot, {}, []).agents.find(
        (agent) => agent.id === "screening-reviewer-agent",
      );
      assert.ok(reviewer);
      return {
        data: [
          {
            id: reviewer.id,
            system: reviewer.system,
            mode: reviewer.mode,
            permissions: reviewer.permissions,
            model: reviewer.model,
          },
        ],
      };
    };
    const mainResult = (await screening.execute(
      {
        stage: "ta",
        work: join(tmpdir(), `ars-missing-work-${process.pid}`),
        emit: join(tmpdir(), `ars-missing-emit-${process.pid}`),
      },
      { sessionID: "ses-1", agent: "build" },
    )) as { content: string; metadata: { status: string } };
    assert.equal(mainResult.metadata.status, "blocked");
    assert.match(mainResult.content, /screening index not found/);
    assert.equal(host.sessionsCreated(), beforeSessions);
  } finally {
    await cleanup();
  }
});

test("the shell hook strips ambient Claude roots and sets both trusted roots", async () => {
  const host = fakeHost();
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);
  try {
    const env: Record<string, string | undefined> = {
      PATH: "/bin",
      CLAUDE_PLUGIN_ROOT: "/wrong",
      CLAUDE_SESSION_ID: "x",
    };
    await host.shellHook()?.({ env });
    assert.equal(env.CLAUDE_PLUGIN_ROOT, undefined);
    assert.equal(env.CLAUDE_SESSION_ID, undefined);
    assert.equal(env.PATH, "/bin");
    assert.equal(env.ARS_PLUGIN_ROOT, repoRoot);
    assert.equal(env.ARS_PROJECT_DIR, repoRoot);
    assert.equal(env.PYTHONUTF8, "1");
  } finally {
    await cleanup();
  }
});

test("a command model alias is routed per request and recorded", async () => {
  const host = fakeHost({
    aliases: {
      sonnet: { providerID: "anthropic", model: "claude-opus-4-1" },
    },
  });
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);
  try {
    const command = host.commands.find((entry) => entry.name === "ars-3w");
    assert.ok(command);
    await command.execute({
      sessionID: "ses-1",
      prompt: { text: "compare three papers" },
      delivery: "steer",
    });
    assert.equal(host.prompts.length, 1);
    const metadata = (host.prompts[0]?.metadata as {
      ars?: { mappedModel?: string; routeId?: string };
    }).ars;
    assert.equal(metadata?.mappedModel, "anthropic/claude-opus-4-1");
    assert.match(metadata?.routeId ?? "", /^ars-route-ses-1-/);
    const hook = host.sessionHooks.get("experimental.model.resolve");
    assert.ok(hook, "the adapter registered the model resolve hook");
    const event = {
      sessionID: "ses-1",
      kind: "primary",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    };
    await hook(event);
    assert.deepEqual(event.model, {
      providerID: "anthropic",
      id: "claude-opus-4-1",
    });
    const continuation = {
      sessionID: "ses-1",
      kind: "primary",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    };
    await hook(continuation);
    assert.deepEqual(continuation.model, {
      providerID: "anthropic",
      id: "claude-opus-4-1",
    });
  } finally {
    await cleanup();
  }
});

test("idle cleanup allows two finished commands in one session", async () => {
  const host = fakeHost({
    aliases: {
      sonnet: { providerID: "anthropic", model: "claude-opus-4-1" },
    },
  });
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);
  try {
    const command = host.commands.find((entry) => entry.name === "ars-3w");
    const hook = host.sessionHooks.get("experimental.model.resolve");
    const idle = host.sessionHooks.get("experimental.idle");
    assert.ok(command && hook && idle);
    const run = async () => {
      await command.execute({
        sessionID: "ses-1",
        prompt: { text: "compare three papers" },
        delivery: "steer",
      });
      const event = {
        sessionID: "ses-1",
        kind: "primary",
        model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      };
      await hook(event);
      assert.deepEqual(event.model, {
        providerID: "anthropic",
        id: "claude-opus-4-1",
      });
      await idle({ sessionID: "ses-1", background: [] });
    };

    await run();
    await run();
    assert.equal(host.prompts.length, 2);
  } finally {
    await cleanup();
  }
});

test("screening blocks a reviewer whose installed contract differs", async () => {
  const host = fakeHost();
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);
  try {
    const reviewer = loadNativeAgents(repoRoot, repoRoot, {}, []).agents.find(
      (agent) => agent.id === "screening-reviewer-agent",
    );
    assert.ok(reviewer);
    (host.ctx.agent as {
      list: () => Promise<{ data: unknown[] }>;
    }).list = async () => ({
      data: [
        {
          id: reviewer.id,
          system: `${reviewer.system}\nTAMPERED`,
          mode: reviewer.mode,
          permissions: reviewer.permissions,
          model: reviewer.model,
        },
      ],
    });
    const screening = host.tools.find(
      (candidate) => candidate.name === "ars_screening",
    );
    assert.ok(screening);
    const result = (await screening.execute(
      { stage: "ta", work: repoRoot, emit: repoRoot },
      { sessionID: "ses-1", agent: "build" },
    )) as { content: string; metadata: { status: string } };
    assert.equal(result.metadata.status, "blocked");
    assert.match(result.content, /installed with different system/);
    assert.equal(host.sessionsCreated(), 0);
    assert.equal(host.prompts.length, 0);

    (host.ctx.agent as {
      list: () => Promise<{ data: unknown[] }>;
    }).list = async () => ({
      data: [
        {
          id: reviewer.id,
          system: reviewer.system,
          mode: reviewer.mode,
          permissions: [
            ...reviewer.permissions,
            { action: "edit", resource: "*", effect: "allow" },
          ],
          model: reviewer.model,
        },
      ],
    });
    const wrongPermissions = (await screening.execute(
      { stage: "ta", work: repoRoot, emit: repoRoot },
      { sessionID: "ses-1", agent: "build" },
    )) as { content: string; metadata: { status: string } };
    assert.equal(wrongPermissions.metadata.status, "blocked");
    assert.match(
      wrongPermissions.content,
      /installed with different permissions/,
    );
    assert.equal(host.sessionsCreated(), 0);
    assert.equal(host.prompts.length, 0);
  } finally {
    await cleanup();
  }
});

test("an unmapped or cross-provider command alias blocks before the prompt", async () => {
  const unmappedHost = fakeHost();
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  let cleanup = await setup(unmappedHost.ctx);
  try {
    const command = unmappedHost.commands.find(
      (entry) => entry.name === "ars-3w",
    );
    assert.ok(command);
    await command.execute({
      sessionID: "ses-1",
      prompt: { text: "compare three papers" },
      delivery: "steer",
    });
    assert.equal(unmappedHost.prompts.length, 0);
    assert.match(unmappedHost.synthetic[0] ?? "", /no OpenCode mapping/);
  } finally {
    await cleanup();
  }

  const crossHost = fakeHost({
    aliases: { sonnet: { providerID: "other", model: "model" } },
  });
  cleanup = await setup(crossHost.ctx);
  try {
    const command = crossHost.commands.find((entry) => entry.name === "ars-3w");
    assert.ok(command);
    await command.execute({
      sessionID: "ses-1",
      prompt: { text: "compare three papers" },
      delivery: "steer",
    });
    assert.equal(crossHost.prompts.length, 0);
    assert.match(crossHost.synthetic[0] ?? "", /only redirect a request within/);
  } finally {
    await cleanup();
  }
});

test("ars_run_script requires a passport, blocks read-only agents and checks targets", async (t) => {
  const interpreter = await discoverInterpreter();
  if (!interpreter) {
    t.skip("no real Python interpreter on this machine");
    return;
  }
  const host = fakeHost();
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);
  const previous = process.env.ARS_VERIFICATION_CACHE_PATH;
  const cache = join(
    tmpdir(),
    `ars-cache-${process.pid}-${Date.now()}.db`,
  );
  for (const path of [cache, `${cache}-wal`, `${cache}-shm`]) {
    rmSync(path, { force: true });
  }
  process.env.ARS_VERIFICATION_CACHE_PATH = cache;
  try {
    const tool = host.tools.find((candidate) => candidate.name === "ars_run_script");
    assert.ok(tool);

    const missing = (await tool.execute(
      { script: "ars_mark_read", argv: ["smith2024", "--scope", "full_text"] },
      { sessionID: "ses-1", agent: "build", messageID: "m1", id: "c1" },
    )) as { metadata: { status: string } };
    assert.equal(missing.metadata.status, "blocked");
    assert.equal(host.assertCalls.length, 0);

    const readOnly = (await tool.execute(
      { script: "ars_cache_invalidate", argv: ["10.1000/x"] },
      {
        sessionID: "ses-1",
        agent: "screening-reviewer-agent",
        messageID: "m1",
        id: "c1",
      },
    )) as { metadata: { status: string } };
    assert.equal(readOnly.metadata.status, "denied");
    assert.equal(host.assertCalls.length, 0);

    const success = (await tool.execute(
      { script: "ars_cache_invalidate", argv: ["10.1000/x"] },
      { sessionID: "ses-1", agent: "build", messageID: "m1", id: "c1" },
    )) as { content: string; metadata: { status: string } };
    assert.equal(success.metadata.status, "executed");
    assert.match(success.content, /exit: 0/);
    assert.equal(existsSync(cache), true, "the CLI created the cache database");
    assert.equal(host.assertCalls.length, 2);
    assert.deepEqual(
      host.assertCalls.map((call) => call.action),
      ["external_directory", "edit"],
    );
    for (const target of [cache, `${cache}-wal`, `${cache}-shm`]) {
      assert.ok(
        host.assertCalls[1]?.resources.some(
          (resource) =>
            resource.replace(/\\/g, "/") === target.replace(/\\/g, "/"),
        ),
        `permission check covers ${target}`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.ARS_VERIFICATION_CACHE_PATH;
    else process.env.ARS_VERIFICATION_CACHE_PATH = previous;
    for (const path of [cache, `${cache}-wal`, `${cache}-shm`]) {
      rmSync(path, { force: true });
    }
    await cleanup();
  }
});

test("a host permission deny stops a script command before execution", async () => {
  const host = fakeHost({ assertReject: "blocked by test policy" });
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);
  const previous = process.env.ARS_VERIFICATION_CACHE_PATH;
  const cache = join(tmpdir(), `ars-denied-cache-${process.pid}.db`);
  rmSync(cache, { force: true });
  process.env.ARS_VERIFICATION_CACHE_PATH = cache;
  try {
    const command = host.commands.find(
      (entry) => entry.name === "ars-cache-invalidate",
    );
    assert.ok(command);
    await command.execute({
      sessionID: "ses-1",
      prompt: { text: "10.1000/x" },
      delivery: "steer",
    });
    assert.match(host.synthetic[0] ?? "", /host permission denied/);
    assert.match(host.synthetic[0] ?? "", /blocked by test policy/);
    assert.equal(existsSync(cache), false, "denied call has no DB side effect");
  } finally {
    if (previous === undefined) delete process.env.ARS_VERIFICATION_CACHE_PATH;
    else process.env.ARS_VERIFICATION_CACHE_PATH = previous;
    rmSync(cache, { force: true });
    await cleanup();
  }
});

test("a fresh-copy CLI leaves no local bytecode and imports its sibling modules", async (t) => {
  const interpreter = await discoverInterpreter();
  if (!interpreter) {
    t.skip("no real Python interpreter on this machine");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "ars-cli-copy-"));
  const cache = join(dir, "verification.db");
  try {
    copyFileSync(
      join(repoRoot, "scripts", "ars_cache_invalidate.py"),
      join(dir, "ars_cache_invalidate.py"),
    );
    copyFileSync(
      join(repoRoot, "scripts", "verification_cache.py"),
      join(dir, "verification_cache.py"),
    );
    const result = await runPythonFile({
      interpreter,
      script: join(dir, "ars_cache_invalidate.py"),
      argv: ["10.1000/x"],
      cwd: dir,
      env: {
        ...process.env,
        ARS_VERIFICATION_CACHE_PATH: cache,
        PYTHONPATH: join(dir, "ignored-ambient-path"),
      },
      timeoutMs: 30_000,
      allowUserSite: true,
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(existsSync(cache), true);
    assert.equal(existsSync(join(dir, "__pycache__")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI flags keep ambient PYTHONPATH out and user site available", async (t) => {
  const interpreter = await discoverInterpreter();
  if (!interpreter) {
    t.skip("no real Python interpreter on this machine");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "ars-flags-"));
  try {
    const probe = join(dir, "probe.py");
    writeFileSync(
      probe,
      "import json, sys\nprint(json.dumps({'user_site_disabled': sys.flags.no_user_site, 'bytecode': sys.dont_write_bytecode}))\n",
      "utf8",
    );
    for (const [allowUserSite, expected] of [
      [true, 0],
      [false, 1],
    ] as const) {
      const result = await runPythonFile({
        interpreter,
        script: probe,
        cwd: dir,
        env: { ...process.env, PYTHONPATH: join(dir, "ignored") },
        timeoutMs: 30_000,
        allowUserSite,
      });
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout) as {
        user_site_disabled: number;
        bytecode: boolean;
      };
      assert.equal(parsed.user_site_disabled, expected);
      assert.equal(parsed.bytecode, true);
    }
    const missing = await checkPythonModule({
      interpreter,
      module: "ars_definitely_missing_dependency",
      cwd: dir,
      env: process.env,
      timeoutMs: 30_000,
      allowUserSite: true,
    });
    assert.match(missing ?? "", /ars_definitely_missing_dependency/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the permission hook resolves an omitted actor from the session", async (t) => {
  const interpreter = await discoverInterpreter();
  if (!interpreter) {
    t.skip("no real Python interpreter on this machine");
    return;
  }
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  type PermissionEvent = {
    action: string;
    resources: string[];
    agent?: string;
    effect: string;
    message?: string;
  };
  const eventFor = (agent?: string): PermissionEvent => ({
    action: "edit",
    resources: [join(repoRoot, "phase1_omitted_actor", "a.md")],
    ...(agent ? { agent } : {}),
    effect: "allow",
  });

  const resolvedHost = fakeHost({ sessionAgent: "synthesis-agent" });
  let cleanup = await setup(resolvedHost.ctx);
  try {
    const hook = resolvedHost.permissionHook();
    assert.ok(hook);
    const omitted = eventFor();
    await hook(omitted);
    assert.equal(omitted.effect, "deny");
    assert.match(omitted.message ?? "", /may not write/);

    // An explicit host actor wins over the session selection.
    const explicit = eventFor("build");
    await hook(explicit);
    assert.equal(explicit.effect, "allow");
  } finally {
    await cleanup();
  }

  const buildHost = fakeHost({ sessionAgent: "build" });
  cleanup = await setup(buildHost.ctx);
  try {
    const hook = buildHost.permissionHook();
    assert.ok(hook);
    const main = eventFor();
    await hook(main);
    assert.equal(main.effect, "allow");
    assert.equal(main.message, undefined);
  } finally {
    await cleanup();
  }

  const failedHost = fakeHost({ sessionGetError: "lookup exploded" });
  cleanup = await setup(failedHost.ctx);
  try {
    const hook = failedHost.permissionHook();
    assert.ok(hook);
    const failed = eventFor();
    await hook(failed);
    assert.equal(failed.effect, "deny");
    assert.match(failed.message ?? "", /trusted agent identity is unavailable/);
    assert.match(failed.message ?? "", /lookup exploded/);
  } finally {
    await cleanup();
  }
});

test("the registered permission hook denies an out-of-phase write and shell", async (t) => {
  const interpreter = await discoverInterpreter();
  if (!interpreter) {
    t.skip("no real Python interpreter on this machine");
    return;
  }
  const host = fakeHost();
  const setup = pluginDefinition.setup as (ctx: unknown) => Promise<() => Promise<void>>;
  const cleanup = await setup(host.ctx);
  try {
    const hook = host.permissionHook();
    assert.ok(hook);

    const writeEvent = {
      action: "edit",
      resources: [join(repoRoot, "phase1_should_not_exist", "a.md")],
      agent: "synthesis-agent",
      effect: "allow",
    } as { action: string; resources: string[]; agent?: string; effect: string; message?: string };
    await hook(writeEvent);
    assert.equal(writeEvent.effect, "deny");
    assert.match(writeEvent.message ?? "", /may not write/);

    const shellEvent = {
      action: "shell",
      resources: ["printf hi > phase3_x/a.md"],
      agent: "synthesis-agent",
      effect: "allow",
    } as { action: string; resources: string[]; agent?: string; effect: string; message?: string };
    await hook(shellEvent);
    assert.equal(shellEvent.effect, "deny");
    assert.match(shellEvent.message ?? "", /may not use Bash/);

    const mainEvent = {
      action: "edit",
      resources: [join(repoRoot, "phase1_main", "a.md")],
      agent: "build",
      effect: "allow",
    } as { action: string; resources: string[]; agent?: string; effect: string; message?: string };
    await hook(mainEvent);
    assert.equal(mainEvent.effect, "allow");
    assert.equal(mainEvent.message, undefined);

    // The adapter never turns a host ask or deny into anything else.
    const askEvent = {
      action: "edit",
      resources: [join(repoRoot, "phase1_main", "a.md")],
      agent: "build",
      effect: "ask",
    } as { action: string; resources: string[]; agent?: string; effect: string; message?: string };
    await hook(askEvent);
    assert.equal(askEvent.effect, "ask");
    assert.equal(askEvent.message, undefined);

    const denyEvent = {
      action: "edit",
      resources: [join(repoRoot, "phase1_main", "a.md")],
      agent: "build",
      effect: "deny",
    } as { action: string; resources: string[]; agent?: string; effect: string; message?: string };
    await hook(denyEvent);
    assert.equal(denyEvent.effect, "deny");
  } finally {
    await cleanup();
  }
});
