/** Story 1.2: migrate the checked-in pre-Markdown fixtures, not a fresh install. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { digestValue, resolveScope, runInstaller, type Channel, type InstallRequest, type Scope } from "../src/install.ts";
import { agentMarkdownDigest } from "../src/agent-storage.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "legacy-inline");

interface Fixture {
  base: string;
  home: string;
  project: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "ars-migration-"));
  const home = join(base, "home");
  const project = join(base, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return {
    base,
    home,
    project,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      ARS_OPENCODE_STATE_DIR: join(home, ".ars-state"),
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function request(
  fixture: Fixture,
  channel: Channel,
  scope: Scope,
  action: InstallRequest["action"],
): InstallRequest {
  return {
    action,
    channel,
    scope,
    projectRoot: fixture.project,
    packageRoot: repoRoot,
    home: fixture.home,
    env: fixture.env,
    ...(action === "check" ? {} : { apply: true }),
  };
}

function expand<T>(value: T, fixture: Fixture): T {
  const replacements: [string, string][] = [
    ["<package-root>", repoRoot.replaceAll("\\", "/")],
    ["<project-root>", fixture.project.replaceAll("\\", "/")],
    ["<home>", fixture.home.replaceAll("\\", "/")],
  ];
  if (typeof value === "string") {
    let text: string = value;
    for (const [from, to] of replacements) text = text.replaceAll(from, to);
    return text as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, fixture)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, expand(item, fixture)]),
    ) as T;
  }
  return value;
}

interface LegacyFixture {
  channel: Channel;
  scope: Scope;
  configAgents: Record<string, Record<string, unknown>>;
  manifest: Record<string, unknown>;
}

function materialize(fixture: Fixture, channel: Channel, scope: Scope): LegacyFixture {
  // configAgents is the captured pre-Markdown state. manifestAgents digests are
  // intentionally null in the checked-in fixture: digestRule says to recompute
  // them after expanding <package-root>, because the captured digest binds the
  // machine that produced the fixture.
  const source = JSON.parse(
    readFileSync(join(fixtureRoot, `install-${channel}-${scope}.json`), "utf8"),
  ) as LegacyFixture & {
    manifest: Record<string, unknown>;
    manifestAgents: Record<string, { digest: string | null }>;
    manifestFileName: string;
    stateRootRelative: string;
    digestRule: string;
  };
  const configAgents = expand(source.configAgents, fixture);
  const requestValue = request(fixture, channel, scope, "update");
  const paths = resolveScope(requestValue, repoRoot);
  const configPath = expand(
    (source.manifest.configPath as string) ?? (scope === "project"
      ? "<project-root>/opencode.json"
      : "<home>/.config/opencode/opencode.json"),
    fixture,
  );
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", agents: configAgents }, null, 2)}\n`,
    "utf8",
  );
  const manifest = expand(source.manifest, fixture) as Record<string, unknown>;
  manifest.agents = Object.fromEntries(
    Object.keys(configAgents).map((id) => [id, { digest: digestValue(configAgents[id]) }]),
  );
  mkdirSync(paths.stateRoot, { recursive: true });
  writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { channel, scope, configAgents, manifest };
}

function agentIds(legacy: LegacyFixture): string[] {
  return Object.keys(legacy.configAgents);
}

test("project plugin fixture: check, migrate, idempotence", async () => {
  const fixture = makeFixture();
  try {
    const legacy = materialize(fixture, "plugin", "project");
    const beforeConfig = readFileSync(join(fixture.project, "opencode.json"), "utf8");
    const check = await runInstaller(request(fixture, "plugin", "project", "check"));
    assert.equal(check.ok, true, JSON.stringify(check.blockers));
    for (const id of agentIds(legacy)) {
      const entry = check.checks.find((item) => item.id === `agent:${id}`);
      assert.equal(entry?.status, "warn", id);
      assert.match(entry?.detail ?? "", /legacy inline/);
    }

    const updated = await runInstaller(request(fixture, "plugin", "project", "update"));
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.equal(updated.applied, true);
    const config = JSON.parse(readFileSync(join(fixture.project, "opencode.json"), "utf8"));
    assert.deepEqual(Object.keys(config.agents ?? {}), []);
    for (const id of agentIds(legacy)) {
      const target = join(fixture.project, ".opencode", "agents", `${id}.md`);
      assert.ok(existsSync(target), `${id} Markdown`);
      const text = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
      const source = legacy.configAgents[id]!;
      assert.equal(
        text.includes(String(source.system).replace(/\r\n/g, "\n")),
        true,
        `${id} body preserved`,
      );
      assert.equal(text.includes(`description: `), true, `${id} description`);
      assert.equal(text.includes(String(source.description)), true, `${id} description value`);
      assert.equal(text.includes("mode: subagent"), true, `${id} mode`);
      if (source.model) assert.equal(text.includes(`model: ${String(source.model)}`), true, `${id} model`);
      const permissions = (source.permissions ?? []) as { action: string; resource: string; effect: string }[];
      const permissionLines = permissions.map(
        (permission) =>
          `  - action: ${permission.action}\n    resource: ${JSON.stringify(permission.resource)}\n    effect: ${permission.effect}`,
      );
      assert.equal(
        text.includes(permissions.length ? `permissions:\n${permissionLines.join("\n")}` : "permissions:"),
        true,
        `${id} ordered permissions`,
      );
    }
    assert.equal(beforeConfig.includes('"agents"'), true);

    const second = await runInstaller(request(fixture, "plugin", "project", "update"));
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    const after = await runInstaller(request(fixture, "plugin", "project", "check"));
    for (const id of agentIds(legacy)) {
      assert.equal(after.checks.find((item) => item.id === `agent:${id}`)?.status, "ok");
    }
  } finally {
    fixture.cleanup();
  }
});

test("global plugin fixture migrates under the XDG config root", async () => {
  const fixture = makeFixture();
  try {
    const legacy = materialize(fixture, "plugin", "global");
    const updated = await runInstaller(request(fixture, "plugin", "global", "update"));
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.equal(updated.agentsDir, join(fixture.home, ".config", "opencode", "agents").replaceAll("\\", "/"));
    const config = JSON.parse(readFileSync(join(fixture.home, ".config", "opencode", "opencode.json"), "utf8"));
    assert.deepEqual(Object.keys(config.agents ?? {}), []);
    for (const id of agentIds(legacy)) {
      assert.ok(existsSync(join(fixture.home, ".config", "opencode", "agents", `${id}.md`)), id);
    }
    const removed = await runInstaller(request(fixture, "plugin", "global", "uninstall"));
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    for (const id of agentIds(legacy)) {
      assert.equal(existsSync(join(fixture.home, ".config", "opencode", "agents", `${id}.md`)), false, id);
    }
  } finally {
    fixture.cleanup();
  }
});

test("skills project fixture migrates the reviewer and retains it on update", async () => {
  const fixture = makeFixture();
  try {
    materialize(fixture, "skills", "project");
    const updated = await runInstaller(request(fixture, "skills", "project", "update"));
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    const config = JSON.parse(readFileSync(join(fixture.project, "opencode.json"), "utf8"));
    assert.deepEqual(Object.keys(config.agents ?? {}), []);
    const target = join(fixture.project, ".opencode", "agents", "screening-reviewer-agent.md");
    assert.ok(existsSync(target));
    const second = await runInstaller(request(fixture, "skills", "project", "update"));
    assert.equal(second.changed, false);
    assert.ok(existsSync(target));
  } finally {
    fixture.cleanup();
  }
});

test("skills global fixture migrates and uninstalls under the XDG config root", async () => {
  const fixture = makeFixture();
  try {
    materialize(fixture, "skills", "global");
    const updated = await runInstaller(request(fixture, "skills", "global", "update"));
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    const configPath = join(fixture.home, ".config", "opencode", "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(Object.keys(config.agents ?? {}), []);
    const target = join(fixture.home, ".config", "opencode", "agents", "screening-reviewer-agent.md");
    assert.ok(existsSync(target));
    const removed = await runInstaller(request(fixture, "skills", "global", "uninstall"));
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    assert.equal(existsSync(target), false);
  } finally {
    fixture.cleanup();
  }
});

test("a modified inline entry blocks the whole migration", async () => {
  const fixture = makeFixture();
  try {
    materialize(fixture, "plugin", "project");
    const configPath = join(fixture.project, "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.agents["synthesis-agent"].system = "user changed this";
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const before = readFileSync(configPath, "utf8");
    const checked = await runInstaller(request(fixture, "plugin", "project", "check"));
    assert.equal(checked.checks.find((item) => item.id === "agent:synthesis-agent")?.status, "error");
    const updated = await runInstaller(request(fixture, "plugin", "project", "update"));
    assert.equal(updated.ok, false);
    assert.match(updated.blockers.join("\n"), /synthesis-agent/);
    assert.match(updated.blockers.join("\n"), /whole migration is stopped/);
    assert.equal(readFileSync(configPath, "utf8"), before);
    assert.equal(existsSync(join(fixture.project, ".opencode", "agents")), false);
  } finally {
    fixture.cleanup();
  }
});

test("a second channel is refused and does not delete the shared reviewer", async () => {
  const fixture = makeFixture();
  try {
    materialize(fixture, "plugin", "project");
    const migrated = await runInstaller(request(fixture, "plugin", "project", "update"));
    assert.equal(migrated.ok, true, migrated.blockers.join("\n"));
    const reviewer = join(fixture.project, ".opencode", "agents", "screening-reviewer-agent.md");
    assert.ok(existsSync(reviewer));

    const skillsRequest = request(fixture, "skills", "project", "update");
    const skillsPaths = resolveScope(skillsRequest, repoRoot);
    mkdirSync(skillsPaths.stateRoot, { recursive: true });
    writeFileSync(
      skillsPaths.manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        installer: "ars-opencode",
        channel: "skills",
        scope: "project",
        packageRoot: repoRoot.replaceAll("\\", "/"),
        projectRoot: fixture.project.replaceAll("\\", "/"),
        configPath: join(fixture.project, "opencode.json").replaceAll("\\", "/"),
        createdAt: "2026-11-14T00:00:00.000Z",
        updatedAt: "2026-11-14T00:00:00.000Z",
        agents: {
          "screening-reviewer-agent": {
            path: reviewer,
            digest: agentMarkdownDigest(readFileSync(reviewer, "utf8")),
          },
        },
        skills: {},
        pendingRemovals: [],
      }, null, 2)}\n`,
      "utf8",
    );

    const blocked = await runInstaller(request(fixture, "skills", "project", "update"));
    assert.equal(blocked.ok, false);
    assert.match(blocked.blockers.join("\n"), /already owns screening-reviewer-agent/);
    assert.match(blocked.blockers.join("\n"), /Uninstall the other channel first/);
    const blockedInstall = await runInstaller(request(fixture, "skills", "project", "install"));
    assert.equal(blockedInstall.ok, false);
    assert.match(blockedInstall.blockers.join("\n"), /already owns screening-reviewer-agent/);
    const conflictCheck = await runInstaller(request(fixture, "skills", "project", "check"));
    assert.equal(
      conflictCheck.checks.find((item) => item.id === "channel-conflict")?.status,
      "error",
    );
    assert.ok(existsSync(reviewer));

    const removed = await runInstaller(request(fixture, "plugin", "project", "uninstall"));
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    assert.ok(existsSync(reviewer), "the other channel still owns the reviewer");
    const pluginManifest = existsSync(removed.manifestPath)
      ? JSON.parse(readFileSync(removed.manifestPath, "utf8"))
      : { agents: {} };
    assert.equal(pluginManifest.agents["screening-reviewer-agent"], undefined);
    assert.equal(
      removed.operations.some(
        (operation) =>
          operation.kind === "remove" && operation.target.endsWith("screening-reviewer-agent.md"),
      ),
      false,
      "the shared reviewer must not be reported as removed",
    );
  } finally {
    fixture.cleanup();
  }
});

test("an unowned inline entry with different content blocks instead of being shadowed", async () => {
  const fixture = makeFixture();
  try {
    materialize(fixture, "plugin", "project");
    const manifestPath = resolveScope(request(fixture, "plugin", "project", "update"), repoRoot).manifestPath;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.agents["synthesis-agent"];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const configPath = join(fixture.project, "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.agents["synthesis-agent"].description = "user-owned different entry";
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const before = readFileSync(configPath, "utf8");
    const updated = await runInstaller(request(fixture, "plugin", "project", "update"));
    assert.equal(updated.ok, false);
    assert.match(updated.blockers.join("\n"), /unowned|different|refuses/i);
    assert.equal(readFileSync(configPath, "utf8"), before);
    assert.equal(existsSync(join(fixture.project, ".opencode", "agents")), false);
  } finally {
    fixture.cleanup();
  }
});

test("an identical unowned inline entry is reused with a warning and left inline", async () => {
  const fixture = makeFixture();
  try {
    materialize(fixture, "plugin", "project");
    const manifestPath = resolveScope(request(fixture, "plugin", "project", "update"), repoRoot).manifestPath;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.agents["synthesis-agent"];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const updated = await runInstaller(request(fixture, "plugin", "project", "update"));
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.match(updated.warnings.join("\n"), /identical definition/);
    const config = JSON.parse(readFileSync(join(fixture.project, "opencode.json"), "utf8"));
    assert.ok(config.agents["synthesis-agent"]);
    assert.equal(existsSync(join(fixture.project, ".opencode", "agents", "synthesis-agent.md")), false);
  } finally {
    fixture.cleanup();
  }
});

test("a retained reviewer record in the other channel does not deadlock a migration", async () => {
  const fixture = makeFixture();
  try {
    materialize(fixture, "plugin", "project");
    const migrated = await runInstaller(request(fixture, "plugin", "project", "update"));
    assert.equal(migrated.ok, true, migrated.blockers.join("\n"));
    const reviewer = join(fixture.project, ".opencode", "agents", "screening-reviewer-agent.md");
    const skillsRequest = request(fixture, "skills", "project", "update");
    const skillsPaths = resolveScope(skillsRequest, repoRoot);
    mkdirSync(skillsPaths.stateRoot, { recursive: true });
    writeFileSync(
      skillsPaths.manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        installer: "ars-opencode",
        channel: "skills",
        scope: "project",
        packageRoot: repoRoot.replaceAll("\\", "/"),
        projectRoot: fixture.project.replaceAll("\\", "/"),
        configPath: join(fixture.project, "opencode.json").replaceAll("\\", "/"),
        createdAt: "2026-11-14T00:00:00.000Z",
        updatedAt: "2026-11-14T00:00:00.000Z",
        agents: {
          "screening-reviewer-agent": {
            path: reviewer,
            digest: agentMarkdownDigest(readFileSync(reviewer, "utf8")),
            retained: true,
          },
        },
        skills: {},
        pendingRemovals: [],
      }, null, 2)}\n`,
      "utf8",
    );

    const updated = await runInstaller(request(fixture, "plugin", "project", "update"));
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    const removed = await runInstaller(request(fixture, "plugin", "project", "uninstall"));
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    assert.ok(existsSync(reviewer), "the retained record keeps the shared file, not a claim");
  } finally {
    fixture.cleanup();
  }
});

test("a legacy inline-only uninstall removes unchanged owned values and keeps modified ones", async () => {
  const fixture = makeFixture();
  try {
    materialize(fixture, "plugin", "project");
    const configPath = join(fixture.project, "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.agents["synthesis-agent"].description = "user modified before uninstall";
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const result = await runInstaller(request(fixture, "plugin", "project", "uninstall"));
    assert.equal(result.ok, true, result.blockers.join("\n"));
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(Object.keys(after.agents ?? {}), ["synthesis-agent"]);
    assert.ok(result.retained.includes("agents.synthesis-agent"));
    assert.equal(existsSync(join(fixture.project, ".opencode", "agents")), false);
  } finally {
    fixture.cleanup();
  }
});
