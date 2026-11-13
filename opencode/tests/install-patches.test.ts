import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "jsonc-parser";
import {
  InstallError,
  parseModelsArgument,
  runInstaller,
  skillTreeDigest,
  type Channel,
  type InstallReport,
  type InstallRequest,
  type Scope,
} from "../src/install.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Fixture {
  base: string;
  home: string;
  project: string;
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "ars-patch-"));
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
    packageRoot: repoRoot,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function request(
  fixture: Fixture,
  overrides: Partial<InstallRequest> & Pick<InstallRequest, "action" | "channel">,
): InstallRequest {
  return {
    scope: "project" as Scope,
    projectRoot: fixture.project,
    packageRoot: fixture.packageRoot,
    home: fixture.home,
    env: fixture.env,
    ...overrides,
  };
}

function projectConfig(fixture: Fixture): string {
  return join(fixture.project, "opencode.json");
}

function readJsonc(path: string): Record<string, unknown> {
  return parse(readFileSync(path, "utf8"), [], { allowTrailingComma: true }) as Record<
    string,
    unknown
  >;
}

function install(
  fixture: Fixture,
  channel: Channel,
  scope: Scope,
  extra: Partial<InstallRequest> = {},
): Promise<InstallReport> {
  return runInstaller(
    request(fixture, {
      action: "install",
      channel,
      scope,
      apply: true,
      ...extra,
    }),
  );
}

test("non-array plugins and instructions are refused instead of replaced", async () => {
  const fixture = makeFixture();
  try {
    writeFileSync(projectConfig(fixture), '{"plugins":"manual"}\n');
    const plugin = await install(fixture, "plugin", "project");
    assert.equal(plugin.ok, false);
    assert.match(plugin.blockers.join("\n"), /`plugins` is not an array/);
    assert.equal(readFileSync(projectConfig(fixture), "utf8"), '{"plugins":"manual"}\n');

    const skillsFixture = makeFixture();
    try {
      writeFileSync(projectConfig(skillsFixture), '{"instructions":"C:/other.md"}\n');
      const skills = await install(skillsFixture, "skills", "project");
      assert.equal(skills.ok, false);
      assert.match(skills.blockers.join("\n"), /`instructions` is not an array/);
      assert.equal(readFileSync(projectConfig(skillsFixture), "utf8"), '{"instructions":"C:/other.md"}\n');
      assert.equal(existsSync(join(skillsFixture.project, ".opencode", "skills")), false);
    } finally {
      skillsFixture.cleanup();
    }
  } finally {
    fixture.cleanup();
  }
});

test("skills preview writes no skills, instructions, config or state", async () => {
  const fixture = makeFixture();
  try {
    const report = await runInstaller(
      request(fixture, { action: "install", channel: "skills", scope: "project" }),
    );
    assert.equal(report.ok, true, report.blockers.join("\n"));
    assert.equal(report.applied, false);
    assert.equal(existsSync(projectConfig(fixture)), false);
    assert.equal(existsSync(join(fixture.project, ".opencode", "skills")), false);
    assert.equal(existsSync(join(fixture.project, ".opencode", "ars-instructions.md")), false);
    assert.equal(existsSync(fixture.env.ARS_OPENCODE_STATE_DIR!), false);
  } finally {
    fixture.cleanup();
  }
});

test("an owned agent survives via normalized equivalence but remains removable", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project");
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const config = readJsonc(projectConfig(fixture));
    const agents = config.agents as Record<string, Record<string, unknown>>;
    const original = agents["synthesis-agent"]!.system as string;
    agents["synthesis-agent"]!.system = original.replace(/\n/g, " \n");
    writeFileSync(projectConfig(fixture), `${JSON.stringify(config, null, 2)}\n`);

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.equal(updated.retained.includes("agents.synthesis-agent"), false);

    const uninstalled = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(uninstalled.ok, true, uninstalled.blockers.join("\n"));
    const after = readJsonc(projectConfig(fixture));
    assert.equal((after.agents as Record<string, unknown> | undefined)?.["synthesis-agent"], undefined);
  } finally {
    fixture.cleanup();
  }
});

test("update retries a recorded skill removal and clears the marker", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "skills", "project");
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
    const target = join(fixture.project, ".opencode", "skills", "retired-fixture");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "retired\n");
    manifest.skills["retired-fixture"] = { dir: target, digest: skillTreeDigest(target) };
    manifest.pendingRemovals = ["retired-fixture"];
    writeFileSync(first.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "skills", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.deepEqual(updated.failed, []);
    assert.equal(existsSync(target), false);
    const after = JSON.parse(readFileSync(first.manifestPath, "utf8"));
    assert.deepEqual(after.pendingRemovals, []);
  } finally {
    fixture.cleanup();
  }
});

test("a null manifest and an unreadable manifest are refused without a raw TypeError", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project");
    assert.equal(first.ok, true, first.blockers.join("\n"));
    writeFileSync(first.manifestPath, "null");
    await assert.rejects(
      () => runInstaller(request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true })),
      (error: unknown) => error instanceof InstallError && /unsupported schema/.test(error.message),
    );

    writeFileSync(first.manifestPath, "{");
    await assert.rejects(
      () => runInstaller(request(fixture, { action: "update", channel: "plugin", scope: undefined, apply: false })),
      (error: unknown) => error instanceof InstallError && /ownership manifests could not be read/.test(error.message),
    );
  } finally {
    fixture.cleanup();
  }
});

test("a UTF-8 BOM configuration is accepted and rewritten without the BOM", async () => {
  const fixture = makeFixture();
  try {
    writeFileSync(projectConfig(fixture), "\uFEFF{}\n");
    const report = await install(fixture, "plugin", "project");
    assert.equal(report.ok, true, report.blockers.join("\n"));
    const text = readFileSync(projectConfig(fixture), "utf8");
    assert.equal(text.charCodeAt(0), 0x7b);
    assert.equal((parse(text) as Record<string, unknown>).agents !== undefined, true);
  } finally {
    fixture.cleanup();
  }
});

test("an empty lock names the file and the manual recovery", async () => {
  const fixture = makeFixture();
  try {
    const stateRoot = fixture.env.ARS_OPENCODE_STATE_DIR!;
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, "install.lock"), "");
    await assert.rejects(
      () => install(fixture, "plugin", "project"),
      (error: unknown) =>
        error instanceof InstallError &&
        /install\.lock/.test(error.message) &&
        /delete/.test(error.message),
    );
  } finally {
    fixture.cleanup();
  }
});

test("installing into the ARS checkout is refused unless explicitly allowed", async () => {
  const fixture = makeFixture();
  try {
    await assert.rejects(
      () =>
        runInstaller(
          request(fixture, {
            action: "install",
            channel: "plugin",
            projectRoot: repoRoot,
            packageRoot: repoRoot,
          }),
        ),
      (error: unknown) => error instanceof InstallError && /inside the ARS checkout/.test(error.message),
    );
  } finally {
    fixture.cleanup();
  }
});

test("a file at the skill target is a blocker, not a raw ENOTDIR", async () => {
  const fixture = makeFixture();
  try {
    const skillsDir = join(fixture.project, ".opencode", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "academic-paper"), "not a directory\n");
    const report = await runInstaller(
      request(fixture, { action: "install", channel: "skills", scope: "project" }),
    );
    assert.equal(report.ok, false);
    assert.match(report.blockers.join("\n"), /is not a directory/);
  } finally {
    fixture.cleanup();
  }
});

test("preview refuses a state directory inside the project", async () => {
  const fixture = makeFixture();
  try {
    const report = runInstaller(
      request(fixture, {
        action: "install",
        channel: "plugin",
        scope: "project",
        env: { ...fixture.env, ARS_OPENCODE_STATE_DIR: join(fixture.project, ".ars-state") },
      }),
    );
    await assert.rejects(report, (error: unknown) => error instanceof InstallError && /inside|Git worktree/.test(error.message));
  } finally {
    fixture.cleanup();
  }
});

test("a whitespace-only model variant is rejected", () => {
  assert.throws(
    () =>
      parseModelsArgument(
        '{"aliases":{"sonnet":{"providerID":"p","model":"m","variant":"  "}}}',
        process.cwd(),
      ),
    /variant must be a non-empty string/,
  );
});

test("a user-modified plugin entry is retained by update and uninstall", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project");
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const config = readJsonc(projectConfig(fixture));
    const entry = (config.plugins as Record<string, unknown>[])[0]!;
    (entry.options as Record<string, unknown>).repoRoot = "C:/user-pinned-checkout";
    writeFileSync(projectConfig(fixture), `${JSON.stringify(config, null, 2)}\n`);

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.ok(updated.retained.includes("plugins[ARS]"));
    const afterUpdate = readJsonc(projectConfig(fixture));
    const updatedEntry = (afterUpdate.plugins as Record<string, unknown>[])[0]!;
    assert.equal((updatedEntry.options as Record<string, unknown>).repoRoot, "C:/user-pinned-checkout");
    assert.equal(JSON.parse(readFileSync(first.manifestPath, "utf8")).pluginRetained, true);

    const uninstalled = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(uninstalled.ok, true, uninstalled.blockers.join("\n"));
    const afterUninstall = readJsonc(projectConfig(fixture));
    assert.equal((afterUninstall.plugins as unknown[]).length, 1);
    assert.ok(existsSync(first.manifestPath));
  } finally {
    fixture.cleanup();
  }
});

test("a bare-string manual plugin registration is reused without claiming ownership", async () => {
  const fixture = makeFixture();
  try {
    const manual = join(fixture.packageRoot, "opencode").replace(/\\/g, "/");
    writeFileSync(projectConfig(fixture), `${JSON.stringify({ plugins: [manual] }, null, 2)}\n`);
    const report = await install(fixture, "plugin", "project");
    assert.equal(report.ok, true, report.blockers.join("\n"));
    assert.ok(report.operations.some((operation) => operation.kind === "reuse" && operation.target === "plugins[ARS]"));
    const config = readJsonc(projectConfig(fixture));
    assert.deepEqual(config.plugins, [manual]);
    const manifest = JSON.parse(readFileSync(report.manifestPath, "utf8"));
    assert.equal(manifest.pluginDigest, undefined);

    const uninstalled = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(uninstalled.ok, true, uninstalled.blockers.join("\n"));
    assert.deepEqual(readJsonc(projectConfig(fixture)).plugins, [manual]);
  } finally {
    fixture.cleanup();
  }
});
