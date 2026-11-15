/**
 * Real-host probe for the Markdown agent form.
 *
 * Records which definition OpenCode 2.3.0 actually loads when one agent ID
 * exists as project Markdown, project configuration, global Markdown and global
 * configuration, then proves the four installed agents load with the expected
 * contract. The probe
 * states the version it ran on and makes no claim about any other host version.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInstaller } from "../src/install.ts";
import {
  agentDifferences,
  loadNativeAgents,
  type AdapterOptions,
  type HostSnapshot,
  type ModelRef,
  type NativeAgentSpec,
} from "../src/setup.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface StoryOneBaseline {
  agents: Record<
    string,
    {
      description: string;
      bodySha256: string;
      mode: string;
      permissionCount: number;
      frontmatter: string;
    }
  >;
}

const storyOneBaseline = JSON.parse(
  readFileSync(join(repoRoot, "opencode", "tests", "fixtures", "agent-storage-baseline.json"), "utf8"),
) as StoryOneBaseline;

const enabled =
  process.env.ARS_HOST_AGENTS === "1" ||
  process.env.npm_lifecycle_event === "test:host:agents";

/** The real host binary; a launcher proxy would misreport the version. */
function binaryPath(): string {
  return (
    process.env.ARS_OPENCODE_BINARY ||
    (process.platform === "win32" ? "opencode.exe" : "opencode")
  );
}

function hostVersion(binary: string): string {
  const version = execFileSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  }).trim();
  assert.match(
    version,
    /v?2\.3\.\d+/,
    `this probe records 2.3.0 precedence only; it saw ${version}. Set ARS_OPENCODE_BINARY to a 2.3.x host.`,
  );
  return version;
}

interface Fixture {
  base: string;
  home: string;
  project: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "ars-agents-host-"));
  const home = join(base, "home");
  const project = join(base, "project");
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  const tempDir = join(base, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(ARS_|OPENCODE_|HIAGENT_|GIT_|PYTHON|NODE_OPTIONS|NODE_PATH|BUN_)/i.test(key) ||
      /KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|SSH|PROXY/i.test(key)
    ) {
      delete env[key];
    }
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    ProgramData: join(home, "ProgramData"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMP: tempDir,
    TEMP: tempDir,
    TMPDIR: tempDir,
    ARS_OPENCODE_STATE_DIR: join(home, ".ars-state"),
  });
  return {
    base,
    home,
    project,
    env,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

interface HostAgent {
  id: string;
  description?: string;
  mode?: NativeAgentSpec["mode"] | "primary" | "all";
  system?: string;
  model?: { id: string; providerID: string; variant?: string };
  permissions?: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[];
}

/** Convert the host's `{ id, providerID, variant }` shape to the adapter's ModelRef. */
function hostSnapshotAgent(agent: HostAgent): HostSnapshot["agents"][number] {
  const model: ModelRef | undefined = agent.model
    ? {
        providerID: agent.model.providerID,
        model: agent.model.id,
        ...(agent.model.variant ? { variant: agent.model.variant } : {}),
      }
    : undefined;
  return {
    id: agent.id,
    system: agent.system,
    mode: agent.mode,
    model,
    permissions: agent.permissions,
  };
}

function debugAgents(binary: string, fixture: Fixture): HostAgent[] {
  const output = execFileSync(binary, ["--standalone", "debug", "agents"], {
    cwd: fixture.project,
    env: fixture.env,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  return JSON.parse(output) as HostAgent[];
}

/** Plugin registration and Markdown discovery can lag the config write on 2.3.0. */
async function debugAgentsUntil(
  binary: string,
  fixture: Fixture,
  ids: readonly string[],
): Promise<HostAgent[]> {
  let agents: HostAgent[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    agents = debugAgents(binary, fixture);
    if (ids.every((id) => agents.some((agent) => agent.id === id))) return agents;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return agents;
}

function writeAgentFile(path: string, description: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `---\ndescription: ${description}\nmode: subagent\n---\n\n${body}\n`,
    "utf8",
  );
}

function readProjectConfig(fixture: Fixture): Record<string, unknown> {
  const path = join(fixture.project, "opencode.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeProjectConfig(fixture: Fixture, config: Record<string, unknown>): void {
  writeFileSync(
    join(fixture.project, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

test("real host: project Markdown > project config > global Markdown > global config", {
  skip: enabled ? false : "invoke npm run test:host:agents; a skip is not acceptance",
  timeout: 5 * 60_000,
}, (t) => {
  const binary = binaryPath();
  const version = hostVersion(binary);
  const fixture = makeFixture();
  try {
    const id = "precedence-probe";
    const projectMarkdown = join(fixture.project, ".opencode", "agents", `${id}.md`);
    const globalMarkdown = join(
      fixture.home,
      ".config",
      "opencode",
      "agents",
      `${id}.md`,
    );
    writeAgentFile(globalMarkdown, "global-markdown", "global markdown body");
    writeAgentFile(projectMarkdown, "project-markdown", "project markdown body");
    writeProjectConfig(fixture, {
      agents: {
        [id]: {
          description: "project-config",
          mode: "subagent",
          system: "project config body",
        },
      },
    });
    const globalConfigPath = join(fixture.home, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(globalConfigPath), { recursive: true });
    writeFileSync(
      globalConfigPath,
      `${JSON.stringify(
        {
          agents: {
            [id]: {
              description: "global-config",
              mode: "subagent",
              system: "global config body",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const observed: {
      projectMarkdown: string;
      projectConfig: string;
      globalMarkdown: string;
      globalConfigOnly: string;
      globalConfigShadowed: string;
    } = {
      projectMarkdown: "",
      projectConfig: "",
      globalMarkdown: "",
      globalConfigOnly: "",
      globalConfigShadowed: "",
    };

    const first = debugAgents(binary, fixture).find((agent) => agent.id === id);
    assert.ok(first, "the probe agent must be loaded");
    observed.projectMarkdown = first.description ?? "";
    assert.equal(observed.projectMarkdown, "project-markdown");
    assert.equal(first.system, "project markdown body");

    rmSync(projectMarkdown);
    const second = debugAgents(binary, fixture).find((agent) => agent.id === id);
    assert.ok(second);
    observed.projectConfig = second.description ?? "";
    assert.equal(observed.projectConfig, "project-config");
    assert.equal(second.system, "project config body");

    const config = readProjectConfig(fixture);
    delete (config.agents as Record<string, unknown>)[id];
    writeProjectConfig(fixture, config);
    const third = debugAgents(binary, fixture).find((agent) => agent.id === id);
    assert.ok(third);
    observed.globalMarkdown = third.description ?? "";
    assert.equal(observed.globalMarkdown, "global-markdown");
    assert.equal(third.system, "global markdown body");

    // Remove project config; global Markdown must now outrank global config.
    writeProjectConfig(fixture, {
      agents: {},
    });
    rmSync(globalMarkdown);
    const configOnly = debugAgents(binary, fixture).find((agent) => agent.id === id);
    assert.ok(configOnly);
    observed.globalConfigOnly = configOnly.description ?? "";
    assert.equal(observed.globalConfigOnly, "global-config", "global config is readable on its own");
    assert.equal(configOnly.system, "global config body");

    writeAgentFile(globalMarkdown, "global-markdown", "global markdown body");
    const fourth = debugAgents(binary, fixture).find((agent) => agent.id === id);
    assert.ok(fourth);
    observed.globalConfigShadowed = fourth.description ?? "";
    assert.equal(
      observed.globalConfigShadowed,
      "global-markdown",
      "global Markdown outranks global config",
    );
    assert.equal(fourth.system, "global markdown body");

    // Evidence is written outside the disposable fixture so it survives cleanup.
    const evidenceRoot = join(tmpdir(), "opencode", "ars-agents-host-evidence");
    mkdirSync(evidenceRoot, { recursive: true });
    const evidencePath = join(
      evidenceRoot,
      `agents-precedence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          host: version,
          recordedAt: new Date().toISOString(),
          probeAgent: id,
          order: [
            "project-markdown",
            "project-config",
            "global-markdown",
            "global-config",
          ],
          observed,
          note:
            "At the first observation one agent ID is defined in all four places; the loaded description is recorded after each source is removed, and global Markdown is re-added over global config.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    assert.ok(readFileSync(evidencePath, "utf8").includes(version));
    console.log(`Retained agent precedence evidence: ${evidencePath}`);
    t.diagnostic(
      `host ${version}: ${Object.entries(observed)
        .map(([source, loaded]) => `${source}=${loaded}`)
        .join(", ")}`,
    );
  } finally {
    fixture.cleanup();
  }
});

function modelMappings(ids: readonly string[]): NonNullable<AdapterOptions["models"]> {
  return {
    agents: Object.fromEntries(
      ids.map((id) => [id, { providerID: "probe", model: "markdown-agent", variant: "high" }]),
    ),
  };
}

function expectedAgentDir(scope: "project" | "global", fixture: Fixture): string {
  return scope === "global"
    ? join(fixture.home, ".config", "opencode", "agents")
    : join(fixture.project, ".opencode", "agents");
}

function systemSha256(system: string): string {
  return createHash("sha256").update(system.replace(/\r\n/g, "\n")).digest("hex");
}

function portableBodySha256(system: string): string {
  return createHash("sha256")
    .update(system.replaceAll(repoRoot.replace(/\\/g, "/"), "<package-root>").replace(/\r\n/g, "\n"))
    .digest("hex");
}

function baselinePermissions(frontmatter: string): { action: string; resource: string; effect: string }[] {
  return [...frontmatter.matchAll(/^ {2}- action: (.+)\n {4}resource: (.+)\n {4}effect: (.+)$/gm)].map(
    (match) => ({ action: match[1]!, resource: JSON.parse(match[2]!) as string, effect: match[3]! }),
  );
}

function containsRules(
  actual: readonly { action: string; resource: string; effect: string }[],
  expected: readonly { action: string; resource: string; effect: string }[],
): boolean {
  return actual.some((_, start) =>
    expected.every(
      (rule, offset) =>
        actual[start + offset]?.action === rule.action &&
        actual[start + offset]?.resource === rule.resource &&
        actual[start + offset]?.effect === rule.effect,
    ),
  );
}

function assertInstalledContract(
  expected: readonly NativeAgentSpec[],
  hostAgents: readonly HostAgent[],
  projectRoot: string,
): void {
  assert.equal(expected.length, 4);
  for (const spec of expected) {
    const loaded = hostAgents.find((agent) => agent.id === spec.id);
    assert.ok(loaded, `host did not load ${spec.id}`);
    const baseline = storyOneBaseline.agents[spec.id];
    assert.ok(baseline, `${spec.id} story 1 baseline`);
    assert.equal(loaded.description, baseline.description, `${spec.id} description (story 1 baseline)`);
    assert.equal(loaded.mode, baseline.mode, `${spec.id} mode (story 1 baseline)`);
    assert.equal(
      portableBodySha256(loaded.system ?? ""),
      baseline.bodySha256,
      `${spec.id} portable body (story 1 baseline)`,
    );
    const expectedRules = baselinePermissions(baseline.frontmatter);
    assert.equal(expectedRules.length, baseline.permissionCount, `${spec.id} baseline permission count`);
    assert.ok(
      containsRules(loaded.permissions ?? [], expectedRules),
      `${spec.id} ordered permissions (story 1 baseline)`,
    );
    assert.equal(
      systemSha256(loaded.system ?? ""),
      systemSha256(spec.system),
      `${spec.id} body (current adapter)`,
    );
    assert.deepEqual(
      agentDifferences(spec, hostSnapshotAgent(loaded)),
      [],
      `${spec.id} loaded with a different contract`,
    );
    assert.equal(
      loaded.system?.includes(projectRoot.replace(/\\/g, "/")),
      false,
      `${spec.id} system prompt stays project-portable`,
    );
    assert.ok(spec.model, `${spec.id} expected model mapping`);
    assert.deepEqual(hostSnapshotAgent(loaded).model, spec.model, `${spec.id} model`);
  }
}

function writeLoadEvidence(
  scope: "project" | "global",
  version: string,
  agentsDir: string,
  expected: readonly NativeAgentSpec[],
  hostAgents: readonly HostAgent[],
): string {
  const evidenceRoot = join(tmpdir(), "opencode", "ars-agents-host-evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  const evidencePath = join(
    evidenceRoot,
    `agents-loaded-${scope}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        host: version,
        recordedAt: new Date().toISOString(),
        scope,
        agentsDir,
        agents: expected.map((spec) => {
          const loaded = hostAgents.find((agent) => agent.id === spec.id)!;
          return {
            id: spec.id,
            mode: loaded.mode,
            description: loaded.description,
            model: hostSnapshotAgent(loaded).model ?? null,
            permissions: loaded.permissions ?? [],
            systemLength: loaded.system?.length ?? 0,
            systemSha256: systemSha256(loaded.system ?? ""),
          };
        }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`Retained Markdown agent load evidence (${scope}): ${evidencePath}`);
  return evidencePath;
}

test("real host: project plugin installs load the four Markdown agents with model and permissions", {
  skip: enabled ? false : "invoke npm run test:host:agents; a skip is not acceptance",
  timeout: 5 * 60_000,
}, async (t) => {
  const binary = binaryPath();
  const version = hostVersion(binary);
  const fixture = makeFixture();
  try {
    const agentIds = loadNativeAgents(repoRoot, {}, [], { validateModels: false }).agents.map((spec) => spec.id);
    const models = modelMappings(agentIds);
    const installed = await runInstaller({
      action: "install",
      channel: "plugin",
      scope: "project",
      projectRoot: fixture.project,
      packageRoot: repoRoot,
      home: fixture.home,
      env: fixture.env,
      models,
      apply: true,
    });
    assert.equal(installed.ok, true, installed.blockers.join("\n"));
    assert.equal(resolve(installed.agentsDir), resolve(expectedAgentDir("project", fixture)));
    const projectConfig = JSON.parse(readFileSync(installed.configPath, "utf8")) as Record<string, unknown>;
    assert.equal(projectConfig.agents, undefined, "project install must not write inline agents");

    const expected = loadNativeAgents(repoRoot, { models }, [], {
      validateModels: false,
    }).agents;
    for (const spec of expected) {
      assert.ok(existsSync(join(installed.agentsDir, `${spec.id}.md`)), `${spec.id} project Markdown file`);
    }
    const hostAgents = await debugAgentsUntil(
      binary,
      fixture,
      expected.map((spec) => spec.id),
    );
    assertInstalledContract(expected, hostAgents, fixture.project);
    const evidencePath = writeLoadEvidence("project", version, installed.agentsDir, expected, hostAgents);
    assert.ok(readFileSync(evidencePath, "utf8").includes(version));
    t.diagnostic(`host ${version}: project Markdown agents loaded with models`);
  } finally {
    fixture.cleanup();
  }
});

test("real host: global plugin installs load the four Markdown agents with model and permissions", {
  skip: enabled ? false : "invoke npm run test:host:agents; a skip is not acceptance",
  timeout: 5 * 60_000,
}, async (t) => {
  const binary = binaryPath();
  const version = hostVersion(binary);
  const fixture = makeFixture();
  try {
    const agentIds = loadNativeAgents(repoRoot, {}, [], { validateModels: false }).agents.map((spec) => spec.id);
    const models = modelMappings(agentIds);
    const installed = await runInstaller({
      action: "install",
      channel: "plugin",
      scope: "global",
      projectRoot: fixture.project,
      packageRoot: repoRoot,
      home: fixture.home,
      env: fixture.env,
      models,
      apply: true,
    });
    assert.equal(installed.ok, true, installed.blockers.join("\n"));
    assert.equal(resolve(installed.agentsDir), resolve(expectedAgentDir("global", fixture)));
    const globalConfig = JSON.parse(readFileSync(installed.configPath, "utf8")) as Record<string, unknown>;
    assert.equal(globalConfig.agents, undefined, "global install must not write inline agents");

    const expected = loadNativeAgents(repoRoot, { models }, [], {
      validateModels: false,
    }).agents;
    for (const spec of expected) {
      assert.ok(existsSync(join(installed.agentsDir, `${spec.id}.md`)), `${spec.id} global Markdown file`);
    }
    const hostAgents = await debugAgentsUntil(
      binary,
      fixture,
      expected.map((spec) => spec.id),
    );
    assertInstalledContract(expected, hostAgents, fixture.project);
    const evidencePath = writeLoadEvidence("global", version, installed.agentsDir, expected, hostAgents);
    assert.ok(readFileSync(evidencePath, "utf8").includes(version));
    t.diagnostic(`host ${version}: global Markdown agents loaded with models`);
  } finally {
    fixture.cleanup();
  }
});
