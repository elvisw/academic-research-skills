import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "jsonc-parser";
import {
  InstallError,
  formatInstallReport,
  parseModelsArgument,
  runInstaller,
  skillTreeDigest,
  type Channel,
  type InstallReport,
  type InstallRequest,
  type Scope,
} from "../src/install.ts";
import { legacyAgentSystem, loadNativeAgents } from "../src/setup.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Fixture {
  base: string;
  home: string;
  project: string;
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  cleanup: () => void;
}

function makeFixture(options: { packageRootCopy?: boolean } = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "ars-install-"));
  const home = join(base, "home");
  const project = join(base, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    ARS_OPENCODE_STATE_DIR: join(home, ".ars-state"),
  };
  let packageRoot = repoRoot;
  if (options.packageRootCopy) {
    packageRoot = join(base, "checkout");
    for (const relative of [".claude-plugin", "commands", "agents", "shared/references"]) {
      cpSync(join(repoRoot, relative), join(packageRoot, relative), {
        recursive: true,
      });
    }
    for (const name of [
      "academic-paper",
      "academic-paper-reviewer",
      "academic-pipeline",
      "deep-research",
      "sr-screener",
    ]) {
      cpSync(join(repoRoot, name), join(packageRoot, name), {
        recursive: true,
        filter: (source) => !/[\\/](__pycache__|\.pytest_cache)([\\/]|$)/.test(source),
      });
    }
  }
  return {
    base,
    home,
    project,
    env,
    packageRoot,
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

function readJsonc(path: string): Record<string, unknown> {
  return parse(readFileSync(path, "utf8"), [], {
    allowTrailingComma: true,
  }) as Record<string, unknown>;
}

function globalConfig(fixture: Fixture): string {
  return join(fixture.home, ".config", "opencode", "opencode.json");
}

function projectConfig(fixture: Fixture): string {
  return join(fixture.project, "opencode.json");
}

async function install(
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
      projectRoot: scope === "global" ? fixture.project : fixture.project,
      ...extra,
    }),
  );
}

test("Windows case-only project spelling keeps one lifecycle identity", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    const alternate = process.platform === "win32" ? fixture.project.toUpperCase() : join(fixture.project, ".");
    const updated = await runInstaller(request(fixture, { action: "update", channel: "plugin", projectRoot: alternate, apply: true }));
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.equal(updated.manifestPath, first.manifestPath);
    const removed = await runInstaller(request(fixture, { action: "uninstall", channel: "plugin", projectRoot: alternate, apply: true }));
    assert.equal(removed.ok, true);
    assert.equal(Object.keys(readJsonc(projectConfig(fixture)).agents as object).length, 0);
  } finally { fixture.cleanup(); }
});

test("an XDG root change cannot reuse another configuration's ownership", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "global", { apply: true });
    const original = readFileSync(first.configPath, "utf8");
    const xdg = join(fixture.home, "other-config");
    const other = join(xdg, "opencode", "opencode.json");
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, original);
    await assert.rejects(() => runInstaller(request(fixture, {
      action: "uninstall", channel: "plugin", scope: "global", apply: true,
      env: { ...fixture.env, XDG_CONFIG_HOME: xdg },
    })), /ownership.*config|bound.*config|stale/i);
    assert.equal(readFileSync(first.configPath, "utf8"), original);
    assert.equal(readFileSync(other, "utf8"), original);
    assert.ok(existsSync(first.manifestPath));
  } finally { fixture.cleanup(); }
});

test("an edit is refused when a duplicate property would make it ineffective", async () => {
  for (const text of [
    '{"plugins":["first"],"plugins":["last"]}',
    String.raw`{"plu\u0067ins":["first"],"plugins":["last"]}`,
  ]) {
    const fixture = makeFixture();
    try {
      writeFileSync(projectConfig(fixture), text);
      await assert.rejects(
        () => install(fixture, "plugin", "project", { apply: true }),
        /effective value|more than once/i,
      );
      assert.equal(readFileSync(projectConfig(fixture), "utf8"), text);
      assert.equal(existsSync(fixture.env.ARS_OPENCODE_STATE_DIR!), false);
    } finally { fixture.cleanup(); }
  }
});

test("a duplicate property outside the edited keys is preserved, not rewritten", async () => {
  const fixture = makeFixture();
  try {
    const text = '{"providers":{"p":{"name":"first","name":"last"}}}';
    writeFileSync(projectConfig(fixture), text);
    const result = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(result.ok, true, result.blockers.join("\n"));
    const written = readFileSync(projectConfig(fixture), "utf8");
    assert.match(written, /"name": "first"/);
    assert.match(written, /"name": "last"/);
  } finally { fixture.cleanup(); }
});

test("rollback keeps referenced assets and private backups after a concurrent config edit", async () => {
  const fixture = makeFixture();
  const originalRename = fs.renameSync;
  try {
    const preview = await install(fixture, "skills", "project");
    const config = projectConfig(fixture);
    let edited = false;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      const result = originalRename(from, to);
      if (!edited && resolve(String(to)) === resolve(config)) {
        const data = readJsonc(config);
        data.user_concurrent_edit = "preserved";
        writeFileSync(config, JSON.stringify(data));
        // A real filesystem obstruction makes the later manifest write fail.
        mkdirSync(preview.manifestPath, { recursive: true });
        edited = true;
      }
      return result;
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    const result = await install(fixture, "skills", "project", { apply: true });
    assert.equal(edited, true);
    assert.equal(result.ok, false);
    assert.equal(readJsonc(config).user_concurrent_edit, "preserved");
    assert.ok(existsSync(preview.instructionsPath!));
    for (const name of ["academic-paper", "academic-paper-reviewer", "academic-pipeline", "deep-research", "sr-screener"]) assert.ok(existsSync(join(preview.skillsDir!, name, "SKILL.md")));
    assert.ok(result.warnings.some((w) => /rollback.*(stopped|incomplete)/i.test(w)));
    assert.ok(result.backupDir && existsSync(result.backupDir));
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    fixture.cleanup();
  }
});

test("model profile errors never echo credential values or accept credential fields", () => {
  const fixture = makeFixture();
  try {
    const secret = "DUMMY_SECRET";
    const invalid = `{"x":${secret}}`;
    const file = join(fixture.base, "models.json");
    writeFileSync(file, invalid);
    for (const value of [invalid, file, JSON.stringify({ aliases: { sonnet: { providerID: "p", model: "m", apiKey: secret } } })]) {
      assert.throws(() => parseModelsArgument(value, fixture.base), (error: unknown) => error instanceof InstallError && !error.message.includes(secret));
    }
  } finally { fixture.cleanup(); }
});

test("native skill diagnostics cover flat, grouped, configured and hidden source shapes", async () => {
  const fixture = makeFixture();
  try {
    const claude = join(fixture.project, ".claude", "skills");
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, "deep-research.md"), "---\nname: flat\n---\n");
    const agents = join(fixture.project, ".agents", "skills");
    mkdirSync(join(agents, "teams", "academic-paper"), { recursive: true });
    writeFileSync(join(agents, "teams", "academic-paper", "SKILL.md"), "---\nname: grouped\n---\n");
    mkdirSync(join(agents, ".hidden", "sr-screener"), { recursive: true });
    writeFileSync(join(agents, ".hidden", "sr-screener", "SKILL.md"), "hidden");
    mkdirSync(join(agents, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(agents, "node_modules", "pkg", "SKILL.md"), "dependency");
    mkdirSync(join(fixture.project, "extra", "academic-pipeline"), { recursive: true });
    writeFileSync(join(fixture.project, "extra", "academic-pipeline", "SKILL.md"), "configured");
    writeFileSync(join(fixture.project, "extra", "sr-screener.md"), "---\nname: flat-configured\n---\n");
    writeFileSync(
      projectConfig(fixture),
      JSON.stringify({ skills: ["./extra", "https://example.invalid/catalog.json"] }),
    );
    const report = await install(fixture, "skills", "project");
    const text = report.warnings.join("\n").replace(/\\/g, "/");
    assert.match(text, /\.claude\/skills\/deep-research\.md/);
    assert.match(text, /\.agents\/skills\/teams\/academic-paper/);
    assert.match(text, /deep-research\.md.*does not predict which copy/s);
    assert.match(text, /extra\/academic-pipeline.*does not predict which copy/s);
    assert.match(text, /sr-screener\.md.*does not predict/s);
    assert.doesNotMatch(text, /keeps precedence|loads instead/);
    assert.doesNotMatch(text, /\.hidden/);
    assert.doesNotMatch(text, /node_modules/);
    assert.match(text, /https:\/\/example\.invalid\/catalog\.json.*not fetch/s);

    const repo = join(fixture.base, "repo");
    const nested = join(repo, "a", "b", "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, ".opencode", "skills", "academic-paper"), { recursive: true });
    writeFileSync(join(repo, ".opencode", "skills", "academic-paper", "SKILL.md"), "ancestor");
    const nestedReport = await runInstaller(
      request(fixture, {
        action: "install",
        channel: "skills",
        scope: "project",
        projectRoot: nested,
      }),
    );
    const nestedText = nestedReport.warnings.join("\n").replace(/\\/g, "/");
    assert.match(
      nestedText,
      /\.opencode\/skills\/academic-paper.*also defines.*does not predict/s,
      "a farther ancestor must be reported without a precedence claim",
    );
  } finally {
    fixture.cleanup();
  }
});

test("plugin preview writes nothing; apply writes once and a second apply changes nothing", async () => {
  const fixture = makeFixture();
  try {
    const preview = await install(fixture, "plugin", "project");
    assert.equal(preview.ok, true);
    assert.equal(preview.applied, false);
    assert.equal(existsSync(projectConfig(fixture)), false);
    assert.equal(existsSync(preview.manifestPath), false);
    assert.equal(existsSync(join(fixture.project, ".opencode", "skills")), false);

    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    assert.equal(first.applied, true);
    const config = readJsonc(projectConfig(fixture));
    assert.equal((config.plugins as unknown[]).length, 1);
    assert.deepEqual(
      Object.keys(config.agents as Record<string, unknown>).sort(),
      [
        "report-compiler-agent",
        "research-architect-agent",
        "screening-reviewer-agent",
        "synthesis-agent",
      ],
    );
    assert.equal(existsSync(first.manifestPath), true);
    assert.equal(
      existsSync(join(fixture.project, ".opencode", "skills")),
      false,
      "the plugin channel must not require a second skills installation",
    );

    const before = readFileSync(projectConfig(fixture), "utf8");
    const second = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    assert.equal(second.applied, false);
    assert.equal(readFileSync(projectConfig(fixture), "utf8"), before);
  } finally {
    fixture.cleanup();
  }
});

test("global JSONC keeps comments, Unicode and unrelated secrets; backups stay outside the project", async () => {
  const fixture = makeFixture();
  try {
    const path = globalConfig(fixture);
    mkdirSync(dirname(path), { recursive: true });
    const original = `{
  // keep this comment — 中文说明
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["./user-instructions.md"],
  "providers": { "example": { "apiKey": "dummy-secret-value" } }
}
`;
    writeFileSync(path, original, "utf8");
    const report = await install(fixture, "plugin", "global", { apply: true });
    assert.equal(report.ok, true, report.blockers.join("\n"));
    const text = readFileSync(path, "utf8");
    assert.match(text, /keep this comment — 中文说明/);
    assert.match(text, /dummy-secret-value/);
    assert.match(text, /user-instructions\.md/);
    const config = readJsonc(path);
    assert.equal((config.plugins as unknown[]).length, 1);
    assert.equal(Object.keys(config.agents as Record<string, unknown>).length, 4);

    assert.ok(report.backupDir);
    assert.ok(
      report.backupDir!.replace(/\\/g, "/").startsWith(
        join(fixture.home, ".ars-state").replace(/\\/g, "/"),
      ),
    );
    assert.doesNotMatch(report.backupDir!, /project/i);
    assert.equal(formatInstallReport(report).includes("dummy-secret-value"), false);

    // One global profile serves every project; a second location does not
    // regenerate or embed either project path.
    const other = join(fixture.base, "other-project");
    mkdirSync(other, { recursive: true });
    const otherReport = await install(fixture, "plugin", "global", {
      apply: true,
      projectRoot: other,
    });
    assert.equal(otherReport.changed, false);
    const agentsText = JSON.stringify(readJsonc(path).agents);
    assert.equal(agentsText.includes(fixture.project.replace(/\\/g, "/")), false);
    assert.equal(agentsText.includes(other.replace(/\\/g, "/")), false);
    assert.match(agentsText, /project-portable/);
  } finally {
    fixture.cleanup();
  }
});

test("skills project copies five complete trees, one reviewer and routing instructions", async () => {
  const fixture = makeFixture();
  try {
    const report = await install(fixture, "skills", "project", { apply: true });
    assert.equal(report.ok, true, report.blockers.join("\n"));
    const skillsDir = join(fixture.project, ".opencode", "skills");
    for (const name of [
      "academic-paper",
      "academic-paper-reviewer",
      "academic-pipeline",
      "deep-research",
      "sr-screener",
    ]) {
      assert.ok(existsSync(join(skillsDir, name, "SKILL.md")), name);
    }
    // Resources and scripts come with the directory, not just SKILL.md.
    assert.ok(existsSync(join(skillsDir, "sr-screener", "scripts", "merge_decisions.py")));
    assert.ok(existsSync(join(skillsDir, "academic-paper", "references", "academic_writing_style.md")));
    assert.equal(existsSync(join(skillsDir, "sr-screener", "scripts", "__pycache__")), false);

    const config = readJsonc(projectConfig(fixture));
    assert.equal(config.plugins, undefined, "skills channel installs no plugin");
    assert.deepEqual(Object.keys(config.agents as Record<string, unknown>), [
      "screening-reviewer-agent",
    ]);
    assert.deepEqual(config.instructions, [".opencode/ars-instructions.md"]);

    const instructions = readFileSync(
      join(fixture.project, ".opencode", "ars-instructions.md"),
      "utf8",
    );
    assert.match(instructions, /project routing/);
    assert.match(instructions, /\/ars-\*/);
    assert.match(instructions, /does not register the `\/ars-\*`/);

    const before = readFileSync(projectConfig(fixture), "utf8");
    const second = await install(fixture, "skills", "project", { apply: true });
    assert.equal(second.changed, false);
    assert.equal(readFileSync(projectConfig(fixture), "utf8"), before);

    const check = await runInstaller(
      request(fixture, { action: "check", channel: "skills", scope: "project" }),
    );
    assert.equal(check.ok, true);
    assert.ok(check.checks.some((entry) => entry.id === "skill:sr-screener" && entry.status === "ok"));
    assert.equal(check.applied, false);
  } finally {
    fixture.cleanup();
  }
});

test("global skills has a compatibility note but no implicit plugin startup routing", async () => {
  const fixture = makeFixture();
  try {
    const report = await install(fixture, "skills", "global", { apply: true });
    assert.equal(report.ok, true, report.blockers.join("\n"));
    const skillsDir = join(fixture.home, ".config", "opencode", "skills");
    assert.ok(existsSync(join(skillsDir, "deep-research", "SKILL.md")));
    const config = readJsonc(globalConfig(fixture));
    assert.equal(config.plugins, undefined);
    assert.deepEqual(Object.keys(config.agents as Record<string, unknown>), [
      "screening-reviewer-agent",
    ]);
    const instructionEntry = (config.instructions as string[])[0] ?? "";
    assert.ok(existsSync(instructionEntry));
    const text = readFileSync(instructionEntry, "utf8");
    assert.match(text, /global compatibility/);
    assert.doesNotMatch(text, /project routing/);
    assert.doesNotMatch(text, /Start the ARS pipeline|run \/ars-full/);
    assert.match(text, /does not add\s+plugin startup routing/);
  } finally {
    fixture.cleanup();
  }
});

test("update replaces an owned bundle as a unit and retires only unchanged owned leftovers", async () => {
  const fixture = makeFixture({ packageRootCopy: true });
  try {
    const first = await install(fixture, "skills", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const skillsDir = join(fixture.project, ".opencode", "skills");

    // Source-side change: remove a resource inside an owned, unchanged tree.
    rmSync(join(fixture.packageRoot, "deep-research", "examples"), {
      recursive: true,
      force: true,
    });
    writeFileSync(
      join(fixture.packageRoot, "academic-pipeline", "SKILL.md"),
      `${readFileSync(join(fixture.packageRoot, "academic-pipeline", "SKILL.md"), "utf8")}\n<!-- updated -->\n`,
      "utf8",
    );
    // User-side change: keep this whole bundle.
    writeFileSync(
      join(skillsDir, "academic-paper", "SKILL.md"),
      `${readFileSync(join(skillsDir, "academic-paper", "SKILL.md"), "utf8")}\n<!-- mine -->\n`,
      "utf8",
    );
    // A previously owned skill that no longer exists in the fixture source.
    const manifestPath = first.manifestPath;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      skills: Record<string, { dir: string; digest: string }>;
    };
    const retiredDir = join(skillsDir, "retired-skill");
    mkdirSync(retiredDir, { recursive: true });
    writeFileSync(join(retiredDir, "SKILL.md"), "retired\n", "utf8");
    manifest.skills["retired-skill"] = {
      dir: retiredDir,
      digest: skillTreeDigest(retiredDir),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    const update = await runInstaller(
      request(fixture, { action: "update", channel: "skills", scope: "project", apply: true }),
    );
    assert.equal(update.ok, true, update.blockers.join("\n"));
    assert.ok(update.retained.some((item) => item === "skills.academic-paper"));
    assert.match(
      readFileSync(join(skillsDir, "academic-paper", "SKILL.md"), "utf8"),
      /<!-- mine -->/,
    );
    assert.match(
      readFileSync(join(skillsDir, "academic-pipeline", "SKILL.md"), "utf8"),
      /<!-- updated -->/,
    );
    assert.equal(existsSync(join(skillsDir, "deep-research", "examples")), false);
    assert.equal(existsSync(retiredDir), false);
  } finally {
    fixture.cleanup();
  }
});

test("uninstall removes unchanged owned assets and keeps modified bundles with their instructions", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "skills", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const skillsDir = join(fixture.project, ".opencode", "skills");
    const instructionPath = join(fixture.project, ".opencode", "ars-instructions.md");
    writeFileSync(
      join(skillsDir, "academic-paper", "SKILL.md"),
      "user-edited bundle\n",
      "utf8",
    );
    writeFileSync(instructionPath, "user-edited instructions\n", "utf8");

    const uninstall = await runInstaller(
      request(fixture, { action: "uninstall", channel: "skills", scope: "project", apply: true }),
    );
    assert.equal(uninstall.ok, true, uninstall.blockers.join("\n"));
    assert.ok(existsSync(join(skillsDir, "deep-research", "SKILL.md")) === false);
    assert.ok(existsSync(join(skillsDir, "academic-paper", "SKILL.md")));
    assert.equal(readFileSync(join(skillsDir, "academic-paper", "SKILL.md"), "utf8"), "user-edited bundle\n");
    assert.ok(existsSync(instructionPath));
    assert.equal(readFileSync(instructionPath, "utf8"), "user-edited instructions\n");
    const config = readJsonc(projectConfig(fixture));
    assert.deepEqual(config.instructions, [".opencode/ars-instructions.md"]);
    assert.ok(existsSync(first.manifestPath), "ownership records survive a partial uninstall");
    assert.ok(uninstall.retained.includes("skills.academic-paper"));
    assert.ok(uninstall.retained.includes("instructions"));

    const again = await runInstaller(
      request(fixture, { action: "uninstall", channel: "skills", scope: "project", apply: true }),
    );
    assert.equal(again.ok, true);
    assert.ok(existsSync(join(skillsDir, "academic-paper", "SKILL.md")));
    assert.ok(existsSync(instructionPath));
  } finally {
    fixture.cleanup();
  }
});

test("plugin uninstall removes only unchanged owned entries and deletes the manifest", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const uninstall = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(uninstall.ok, true, uninstall.blockers.join("\n"));
    const config = readJsonc(projectConfig(fixture));
    assert.equal((config.plugins as unknown[] | undefined)?.length ?? 0, 0);
    assert.equal(Object.keys((config.agents as Record<string, unknown>) ?? {}).length, 0);
    assert.equal(existsSync(first.manifestPath), false);

    // A user-edited agent entry is retained, not removed.
    const second = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(second.ok, true);
    const path = projectConfig(fixture);
    const configAfter = readJsonc(path);
    const agents = configAfter.agents as Record<string, Record<string, unknown>>;
    agents["synthesis-agent"]!.system = "my own edits";
    writeFileSync(path, JSON.stringify(configAfter, null, 2) + "\n", "utf8");
    const partial = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(partial.ok, true);
    const left = readJsonc(path);
    assert.ok((left.agents as Record<string, unknown>)["synthesis-agent"]);
    assert.equal((left.agents as Record<string, unknown>)["report-compiler-agent"], undefined);
    assert.equal(existsSync(second.manifestPath), true);
    assert.ok(partial.retained.includes("agents.synthesis-agent"));
  } finally {
    fixture.cleanup();
  }
});

test("legacy templates are adopted only with --adopt-legacy", async () => {
  const fixture = makeFixture();
  try {
    const path = projectConfig(fixture);
    const { agents } = loadNativeAgents(fixture.packageRoot, {}, []);
    const synthesis = agents.find((agent) => agent.id === "synthesis-agent");
    assert.ok(synthesis);
    const legacyConfig = {
      $schema: "https://opencode.ai/config.json",
      plugins: [resolve(fixture.packageRoot, "opencode")],
      agents: {
        "synthesis-agent": {
          description: synthesis.description,
          mode: synthesis.mode,
          system: legacyAgentSystem(
            fixture.packageRoot,
            fixture.project,
            synthesis.system,
          ),
          permissions: synthesis.permissions,
        },
      },
    };
    writeFileSync(path, JSON.stringify(legacyConfig, null, 2) + "\n", "utf8");
    const refused = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(refused.ok, false);
    assert.ok(refused.blockers.some((blocker) => /adopt-legacy/.test(blocker)));
    const untouched = readJsonc(path);
    assert.match(
      ((untouched.agents as Record<string, Record<string, string>>)["synthesis-agent"]!)
        .system as string,
      /user's current project root/,
    );

    const adopted = await install(fixture, "plugin", "project", {
      apply: true,
      adoptLegacy: true,
    });
    assert.equal(adopted.ok, true, adopted.blockers.join("\n"));
    const config = readJsonc(path);
    const system = ((config.agents as Record<string, Record<string, string>>)["synthesis-agent"]!)
      .system as string;
    assert.doesNotMatch(system, /user's current project root/);
    assert.match(system, /project-portable/);
    assert.equal((config.plugins as unknown[]).length, 1);
    assert.equal(typeof (config.plugins as unknown[])[0], "object");
  } finally {
    fixture.cleanup();
  }
});

test("malformed JSONC aborts without touching the file", async () => {
  const fixture = makeFixture();
  try {
    const path = projectConfig(fixture);
    const broken = `{ "plugins": [ // comment\n  "x"\n`;
    writeFileSync(path, broken, "utf8");
    await assert.rejects(
      () => install(fixture, "plugin", "project", { apply: true }),
      (error: unknown) =>
        error instanceof InstallError && /not valid JSONC/.test(error.message),
    );
    assert.equal(readFileSync(path, "utf8"), broken);
  } finally {
    fixture.cleanup();
  }
});

test("a failed configuration write rolls back skill copies made by the same run", async () => {
  const fixture = makeFixture();
  try {
    const report = await install(fixture, "skills", "project", {
      apply: true,
      testHooks: { failAt: "config" },
    });
    assert.equal(report.ok, false);
    assert.equal(report.applied, false);
    for (const name of [
      "academic-paper",
      "academic-paper-reviewer",
      "academic-pipeline",
      "deep-research",
      "sr-screener",
    ]) {
      assert.equal(
        existsSync(join(fixture.project, ".opencode", "skills", name)),
        false,
        name,
      );
    }
    assert.equal(existsSync(projectConfig(fixture)), false);
    assert.equal(existsSync(report.manifestPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("a failed skill removal is recorded and retried", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "skills", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const failed = await runInstaller(
      request(fixture, {
        action: "uninstall",
        channel: "skills",
        scope: "project",
        apply: true,
        testHooks: { failAt: "removal" },
      }),
    );
    assert.equal(failed.ok, true, failed.blockers.join("\n"));
    assert.ok(failed.warnings.some((warning) => /could not remove/.test(warning)));
    assert.ok(existsSync(join(fixture.project, ".opencode", "skills", "deep-research", "SKILL.md")));
    const kept = readJsonc(projectConfig(fixture));
    assert.deepEqual(Object.keys(kept.agents as Record<string, unknown>), [
      "screening-reviewer-agent",
    ]);
    assert.deepEqual(kept.instructions, [".opencode/ars-instructions.md"]);
    const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8")) as {
      pendingRemovals: string[];
      skills: Record<string, unknown>;
    };
    assert.equal(manifest.pendingRemovals.length, 5);
    assert.equal(Object.keys(manifest.skills).length, 5);

    const retried = await runInstaller(
      request(fixture, {
        action: "uninstall",
        channel: "skills",
        scope: "project",
        apply: true,
      }),
    );
    assert.equal(retried.ok, true, retried.blockers.join("\n"));
    assert.equal(
      existsSync(join(fixture.project, ".opencode", "skills", "deep-research", "SKILL.md")),
      false,
    );
    assert.equal(existsSync(first.manifestPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("preview reports an existing opposite-channel installation without deleting it", async () => {
  const fixture = makeFixture();
  try {
    const skills = await install(fixture, "skills", "project", { apply: true });
    assert.equal(skills.ok, true);
    const preview = await install(fixture, "plugin", "project");
    assert.ok(preview.warnings.some((warning) => /native skill copies also exist/.test(warning)));
    assert.equal(existsSync(join(fixture.project, ".opencode", "skills", "deep-research", "SKILL.md")), true);

    const clean = makeFixture();
    try {
      const plugin = await install(clean, "plugin", "project", { apply: true });
      assert.equal(plugin.ok, true);
      const skillsPreview = await install(clean, "skills", "project");
      assert.ok(
        skillsPreview.warnings.some((warning) => /plugin entry for this checkout also exists/.test(warning)),
      );
    } finally {
      clean.cleanup();
    }
  } finally {
    fixture.cleanup();
  }
});

test("a held installer lock blocks a concurrent apply", async () => {
  const fixture = makeFixture();
  try {
    const stateRoot = fixture.env.ARS_OPENCODE_STATE_DIR as string;
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, "install.lock"), `${process.pid} ${Date.now()}`, "utf8");
    await assert.rejects(
      () => install(fixture, "plugin", "project", { apply: true }),
      (error: unknown) =>
        error instanceof InstallError && /another ARS installation holds/.test(error.message),
    );
    assert.equal(existsSync(projectConfig(fixture)), false);
  } finally {
    fixture.cleanup();
  }
});

test("check is read-only, reports disk state and creates no state directory", async () => {
  const fixture = makeFixture();
  try {
    const report = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    assert.equal(report.ok, true);
    assert.equal(existsSync(join(fixture.home, ".ars-state")), false);
    assert.equal(existsSync(projectConfig(fixture)), false);
    assert.ok(report.checks.some((check) => check.id === "plugin-entry"));
    assert.ok(
      report.checks.some(
        (check) => check.id === "disk-only" && /do not prove the host loaded/.test(check.detail),
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test("model mappings are plugin-only and are written into the plugin options", async () => {
  const fixture = makeFixture();
  try {
    await assert.rejects(
      () =>
        install(fixture, "skills", "project", {
          apply: true,
          models: { aliases: { sonnet: { providerID: "p", model: "m" } } },
        }),
      (error: unknown) =>
        error instanceof InstallError && /--models is not supported/.test(error.message),
    );
    const models = parseModelsArgument(
      '{"aliases":{"sonnet":{"providerID":"p","model":"m"}},"agents":{"synthesis-agent":{"providerID":"p","model":"m2","variant":"high"}}}',
      process.cwd(),
    );
    const report = await install(fixture, "plugin", "project", {
      apply: true,
      models,
    });
    assert.equal(report.ok, true, report.blockers.join("\n"));
    const config = readJsonc(projectConfig(fixture));
    const entry = (config.plugins as Record<string, unknown>[])[0]!;
    const options = entry.options as Record<string, unknown>;
    assert.deepEqual(options.models, models);
    const agents = config.agents as Record<string, Record<string, unknown>>;
    assert.deepEqual(agents["synthesis-agent"]!.model, {
      providerID: "p",
      model: "m2",
      variant: "high",
    });
  } finally {
    fixture.cleanup();
  }
});

test("project scope refuses multiple configuration files instead of guessing", async () => {
  const fixture = makeFixture();
  try {
    writeFileSync(projectConfig(fixture), "{}\n", "utf8");
    mkdirSync(join(fixture.project, ".opencode"), { recursive: true });
    writeFileSync(join(fixture.project, ".opencode", "opencode.json"), "{}\n", "utf8");
    await assert.rejects(
      () => install(fixture, "plugin", "project", { apply: true }),
      (error: unknown) =>
        error instanceof InstallError && /ambiguous project configuration/.test(error.message),
    );
  } finally {
    fixture.cleanup();
  }
});

test("V01 persisted model mappings survive update and check without --models", async () => {
  const fixture = makeFixture();
  try {
    const models = {
      aliases: { sonnet: { providerID: "probe", model: "chosen" } },
      agents: {
        "synthesis-agent": { providerID: "probe", model: "agent-choice" },
      },
    };
    const first = await install(fixture, "plugin", "project", { apply: true, models });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    const config = readJsonc(projectConfig(fixture));
    const entry = (config.plugins as Record<string, unknown>[])[0]!;
    assert.deepEqual((entry.options as Record<string, unknown>).models, models);
    const agents = config.agents as Record<string, Record<string, unknown>>;
    assert.deepEqual(agents["synthesis-agent"]!.model, {
      providerID: "probe",
      model: "agent-choice",
    });
    const check = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const modelCheck = check.checks.find((item) => item.id === "models");
    assert.equal(modelCheck?.status, "ok");
    assert.match(modelCheck?.detail ?? "", /agents\.synthesis-agent/);
    assert.match(modelCheck?.detail ?? "", /aliases\.sonnet/);

    // An explicit partial mapping changes only what it names.
    const partial = await runInstaller(
      request(fixture, {
        action: "update",
        channel: "plugin",
        scope: "project",
        apply: true,
        models: { aliases: { haiku: { providerID: "probe", model: "small" } } },
      }),
    );
    assert.equal(partial.ok, true, partial.blockers.join("\n"));
    const merged = readJsonc(projectConfig(fixture));
    const mergedOptions = ((merged.plugins as Record<string, unknown>[])[0]!
      .options as Record<string, unknown>);
    const mergedModels = mergedOptions.models as Record<string, Record<string, unknown>>;
    assert.deepEqual(mergedModels.aliases, {
      sonnet: { providerID: "probe", model: "chosen" },
      haiku: { providerID: "probe", model: "small" },
    });
    assert.deepEqual(mergedModels.agents, models.agents);
  } finally {
    fixture.cleanup();
  }
});

test("V02 a retained agent stays retained across repeated updates", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true);
    const path = projectConfig(fixture);
    const config = readJsonc(path);
    (config.agents as Record<string, Record<string, unknown>>)["synthesis-agent"]!.description =
      "user-edited-description";
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
    const once = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(once.ok, true, once.blockers.join("\n"));
    assert.ok(once.retained.includes("agents.synthesis-agent"));
    const twice = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(twice.ok, true, twice.blockers.join("\n"));
    assert.ok(twice.retained.includes("agents.synthesis-agent"));
    const after = readJsonc(path);
    assert.equal(
      (after.agents as Record<string, Record<string, unknown>>)["synthesis-agent"]!.description,
      "user-edited-description",
    );
  } finally {
    fixture.cleanup();
  }
});

test("V03 reused instructions are never claimed or deleted by uninstall", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "skills", "project", { apply: true });
    assert.equal(first.ok, true);
    const instruction = join(fixture.project, ".opencode", "ars-instructions.md");
    const originalInstruction = readFileSync(instruction, "utf8");

    // Same files, a fresh private ownership directory: everything must be
    // reused, not silently adopted.
    const freshEnv = {
      ...fixture.env,
      ARS_OPENCODE_STATE_DIR: join(fixture.base, "fresh-state"),
    };
    const reused = await runInstaller(
      request(fixture, {
        action: "install",
        channel: "skills",
        scope: "project",
        apply: true,
        env: freshEnv,
      }),
    );
    assert.equal(reused.ok, true, reused.blockers.join("\n"));
    assert.equal(existsSync(reused.manifestPath), false, "nothing was owned");
    if (existsSync(reused.manifestPath)) {
      const manifest = JSON.parse(readFileSync(reused.manifestPath, "utf8")) as {
        instructions?: unknown;
      };
      assert.equal(manifest.instructions, undefined);
    }

    const removed = await runInstaller(
      request(fixture, {
        action: "uninstall",
        channel: "skills",
        scope: "project",
        apply: true,
        env: freshEnv,
      }),
    );
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    assert.equal(readFileSync(instruction, "utf8"), originalInstruction);
    assert.ok(existsSync(join(fixture.project, ".opencode", "skills", "deep-research", "SKILL.md")));
    const config = readJsonc(projectConfig(fixture));
    assert.deepEqual(config.instructions, [".opencode/ars-instructions.md"]);
  } finally {
    fixture.cleanup();
  }
});

test("V05/V06 a failed final config rename keeps the original and stages outside the VCS", async () => {
  const fixture = makeFixture();
  try {
    const configPath = projectConfig(fixture);
    const dummy = "FAKE_SECRET_FOR_STAGING_ONLY";
    writeFileSync(configPath, JSON.stringify({ user_owned: dummy }, null, 2) + "\n", "utf8");
    execFileSync("git", ["init", "-q", fixture.project], { windowsHide: true });

    const originalRename = fs.renameSync;
    let stageVisible = false;
    let stageHadSecret = false;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (resolve(String(to)) === resolve(configPath)) {
        stageHadSecret = readFileSync(String(from), "utf8").includes(dummy);
        const listed = execFileSync(
          "git",
          ["-C", fixture.project, "ls-files", "--others", "--exclude-standard"],
          { encoding: "utf8", windowsHide: true },
        );
        stageVisible = listed.includes(String(from).split(/[\\/]/).pop() ?? "");
        throw new Error("test: actual final config rename failed");
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    let report: InstallReport;
    try {
      report = await install(fixture, "plugin", "project", { apply: true });
    } finally {
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    }
    assert.equal(report!.ok, false);
    assert.equal(report!.applied, false);
    const survived = readFileSync(configPath, "utf8");
    assert.match(survived, new RegExp(dummy));
    assert.equal(stageHadSecret, true, "the staged document carried the same user content");
    assert.equal(stageVisible, false, "staging must stay outside git-visible project files");
  } finally {
    fixture.cleanup();
  }
});

test("V05 a failed directory swap restores the previous skill tree", async () => {
  const fixture = makeFixture({ packageRootCopy: true });
  try {
    const first = await install(fixture, "skills", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const installed = join(fixture.project, ".opencode", "skills", "deep-research");
    const before = readFileSync(join(installed, "SKILL.md"), "utf8");
    writeFileSync(
      join(fixture.packageRoot, "deep-research", "SKILL.md"),
      `${readFileSync(join(fixture.packageRoot, "deep-research", "SKILL.md"), "utf8")}\n<!-- source update -->\n`,
      "utf8",
    );

    const originalRename = fs.renameSync;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (resolve(String(to)) === resolve(installed) && String(from).includes(".ars-tmp-")) {
        throw new Error("test: actual directory swap failed");
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    let report: InstallReport;
    try {
      report = await runInstaller(
        request(fixture, { action: "update", channel: "skills", scope: "project", apply: true }),
      );
    } finally {
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    }
    assert.equal(report!.ok, false);
    assert.equal(readFileSync(join(installed, "SKILL.md"), "utf8"), before);
  } finally {
    fixture.cleanup();
  }
});

test("V07 a live lock is not stolen by age; a dead owner is recoverable", async () => {
  const fixture = makeFixture();
  try {
    const state = fixture.env.ARS_OPENCODE_STATE_DIR as string;
    mkdirSync(state, { recursive: true });
    const lock = join(state, "install.lock");
    writeFileSync(lock, `${process.pid} ${Date.now() - 11 * 60_000} live-owner`, "utf8");
    await assert.rejects(
      () => install(fixture, "plugin", "project", { apply: true }),
      (error: unknown) =>
        error instanceof InstallError && /another ARS installation holds/.test(error.message),
    );
    assert.equal(existsSync(projectConfig(fixture)), false);

    // A dead owner is stale even when the timestamp is recent, and release
    // only ever removes the caller's token.
    writeFileSync(lock, "999999 1 dead-owner", "utf8");
    const recovered = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(recovered.ok, true, recovered.blockers.join("\n"));
    assert.equal(existsSync(lock), false, "apply releases its own lock");
  } finally {
    fixture.cleanup();
  }
});

test("V08 a failed instruction removal keeps ownership, reference and retry state", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "skills", "project", { apply: true });
    assert.equal(first.ok, true);
    const instruction = join(fixture.project, ".opencode", "ars-instructions.md");
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = ((file: fs.PathLike) => {
      if (resolve(String(file)) === resolve(instruction)) {
        throw Object.assign(new Error("test: instruction is locked"), { code: "EPERM" });
      }
      return originalUnlink(file);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    let failed: InstallReport;
    try {
      failed = await runInstaller(
        request(fixture, { action: "uninstall", channel: "skills", scope: "project", apply: true }),
      );
    } finally {
      fs.unlinkSync = originalUnlink;
      syncBuiltinESMExports();
    }
    assert.equal(failed!.ok, false);
    assert.ok(failed!.failed.includes("instructions"));
    assert.ok(existsSync(instruction));
    assert.ok(existsSync(first.manifestPath));
    const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8")) as {
      instructions?: { path: string };
    };
    assert.equal(manifest.instructions?.path.replace(/\\/g, "/"), instruction.replace(/\\/g, "/"));
    const config = readJsonc(projectConfig(fixture));
    assert.deepEqual(config.instructions, [".opencode/ars-instructions.md"]);

    const retried = await runInstaller(
      request(fixture, { action: "uninstall", channel: "skills", scope: "project", apply: true }),
    );
    assert.equal(retried.ok, true, retried.blockers.join("\n"));
    assert.equal(existsSync(instruction), false);
    assert.equal(existsSync(first.manifestPath), false);
    const after = readJsonc(projectConfig(fixture));
    assert.equal((after.instructions as string[] | undefined)?.length ?? 0, 0);
  } finally {
    fixture.cleanup();
  }
});

test("V04 legacy adoption refuses user-modified permissions", async () => {
  const fixture = makeFixture();
  try {
    const path = projectConfig(fixture);
    const { agents } = loadNativeAgents(fixture.packageRoot, {}, [], {
      validateModels: false,
    });
    const reviewer = agents.find((agent) => agent.id === "screening-reviewer-agent");
    assert.ok(reviewer);
    const userRule = { action: "edit", resource: "*", effect: "allow" as const };
    writeFileSync(
      path,
      JSON.stringify(
        {
          agents: {
            "screening-reviewer-agent": {
              description: reviewer.description,
              mode: reviewer.mode,
              system: legacyAgentSystem(
                fixture.packageRoot,
                fixture.project,
                reviewer.system,
              ),
              permissions: [...reviewer.permissions, userRule],
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const refused = await install(fixture, "plugin", "project", {
      apply: true,
      adoptLegacy: true,
    });
    assert.equal(refused.ok, false);
    assert.ok(refused.blockers.some((blocker) => /unowned entry/.test(blocker)));
    const kept = readJsonc(path);
    assert.ok(
      (kept.agents as Record<string, Record<string, unknown>>)["screening-reviewer-agent"]!
        .permissions instanceof Array,
    );
    assert.ok(
      (
        ((kept.agents as Record<string, Record<string, unknown>>)["screening-reviewer-agent"]!
          .permissions as { action: string; effect: string }[])
      ).some((rule) => rule.action === "edit" && rule.effect === "allow"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("a reused instruction file can acquire only an owned config reference", async () => {
  const fixture = makeFixture();
  try {
    await install(fixture, "skills", "project", { apply: true });
    const config = readJsonc(projectConfig(fixture));
    config.instructions = [];
    writeFileSync(projectConfig(fixture), JSON.stringify(config));
    fixture.env.ARS_OPENCODE_STATE_DIR = join(fixture.home, "fresh-state");
    const reused = await install(fixture, "skills", "project", { apply: true });
    assert.equal(reused.ok, true, reused.blockers.join("\n"));
    const manifest = JSON.parse(readFileSync(reused.manifestPath, "utf8"));
    assert.equal(manifest.instructions.fileOwned, false);
    assert.equal(manifest.instructions.configReferenceAdded, true);
    assert.deepEqual(readJsonc(projectConfig(fixture)).instructions, [".opencode/ars-instructions.md"]);
    const removed = await runInstaller(request(fixture, { action: "uninstall", channel: "skills", apply: true }));
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    assert.ok(existsSync(reused.instructionsPath!));
    assert.equal((readJsonc(projectConfig(fixture)).instructions as unknown[]).length, 0);
  } finally { fixture.cleanup(); }
});

test("backup state inside a parent worktree is refused before mutation", async () => {
  const fixture = makeFixture();
  try {
    execFileSync("git", ["init", "-q", fixture.base], { windowsHide: true });
    await assert.rejects(() => install(fixture, "plugin", "project", { apply: true }), /inside a Git worktree/);
    assert.equal(existsSync(projectConfig(fixture)), false);
    assert.equal(existsSync(fixture.env.ARS_OPENCODE_STATE_DIR!), false);
  } finally { fixture.cleanup(); }
});

test("an empty lock is not stolen while its owner may still be writing it", async () => {
  const fixture = makeFixture();
  try {
    const state = fixture.env.ARS_OPENCODE_STATE_DIR!;
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "install.lock"), "");
    await assert.rejects(() => install(fixture, "plugin", "project", { apply: true }), /another ARS installation holds/);
    assert.equal(existsSync(projectConfig(fixture)), false);
    assert.equal(readFileSync(join(state, "install.lock"), "utf8"), "");
  } finally { fixture.cleanup(); }
});

test("cross-filesystem private staging fails without replacing the original", async () => {
  const fixture = makeFixture();
  const originalRename = fs.renameSync;
  try {
    const config = projectConfig(fixture);
    const original = '{"keep":"DUMMY_PRIVATE_VALUE"}\n';
    writeFileSync(config, original);
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (resolve(String(to)) === resolve(config)) throw Object.assign(new Error("different devices"), { code: "EXDEV" });
      return originalRename(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    const result = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(result.ok, false);
    assert.match(result.blockers.join("\n"), /cannot cross filesystems atomically/);
    assert.equal(readFileSync(config, "utf8"), original);
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    fixture.cleanup();
  }
});

test("a manifest edited during backup is preserved and prior config writes roll back", async () => {
  const fixture = makeFixture();
  const originalCopy = fs.copyFileSync;
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    const originalConfig = readFileSync(projectConfig(fixture), "utf8");
    let changed = false;
    fs.copyFileSync = ((from: fs.PathLike, to: fs.PathLike, mode?: number) => {
      originalCopy(from, to, mode);
      if (!changed && resolve(String(from)) === resolve(first.manifestPath)) {
        const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
        manifest.external_marker = "user-change-during-backup";
        writeFileSync(first.manifestPath, JSON.stringify(manifest));
        changed = true;
      }
    }) as typeof fs.copyFileSync;
    syncBuiltinESMExports();
    const updated = await runInstaller(request(fixture, {
      action: "update", channel: "plugin", apply: true,
      models: { aliases: { sonnet: { providerID: "local", model: "updated" } } },
    }));
    assert.equal(changed, true);
    assert.equal(updated.ok, false);
    assert.equal(JSON.parse(readFileSync(first.manifestPath, "utf8")).external_marker, "user-change-during-backup");
    assert.equal(readFileSync(projectConfig(fixture), "utf8"), originalConfig);
  } finally {
    fs.copyFileSync = originalCopy;
    syncBuiltinESMExports();
    fixture.cleanup();
  }
});

test("late user instructions are not replaced by a source update", async () => {
  const fixture = makeFixture({ packageRootCopy: true });
  const originalCopy = fs.copyFileSync;
  try {
    const first = await install(fixture, "skills", "project", { apply: true });
    const file = first.instructionsPath!;
    const original = readFileSync(file, "utf8");
    const core = join(fixture.packageRoot, "shared", "references", "routing_core.md");
    writeFileSync(core, readFileSync(core, "utf8").replace("<!-- routing-core:end -->", "A fixture source update.\n<!-- routing-core:end -->"));
    let changed = false;
    fs.copyFileSync = ((from: fs.PathLike, to: fs.PathLike, mode?: number) => {
      originalCopy(from, to, mode);
      if (!changed && resolve(String(from)) === resolve(file)) {
        writeFileSync(file, original + "\n# user late note\n");
        changed = true;
      }
    }) as typeof fs.copyFileSync;
    syncBuiltinESMExports();
    const updated = await runInstaller(request(fixture, { action: "update", channel: "skills", apply: true }));
    assert.equal(changed, true);
    assert.equal(updated.ok, false);
    assert.equal(readFileSync(file, "utf8"), original + "\n# user late note\n");
  } finally {
    fs.copyFileSync = originalCopy;
    syncBuiltinESMExports();
    fixture.cleanup();
  }
});

test("retained bundle metadata never advances to an unwritten source digest", async () => {
  const fixture = makeFixture({ packageRootCopy: true });
  try {
    const first = await install(fixture, "skills", "project", { apply: true });
    const before = JSON.parse(readFileSync(first.manifestPath, "utf8"));
    const target = join(first.skillsDir!, "deep-research", "SKILL.md");
    const source = join(fixture.packageRoot, "deep-research", "SKILL.md");
    const userText = readFileSync(target, "utf8") + "\n<!-- user edits -->\n";
    writeFileSync(target, userText);
    writeFileSync(source, readFileSync(source, "utf8") + "\n<!-- source edits -->\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      const updated = await runInstaller(request(fixture, { action: "update", channel: "skills", apply: true }));
      assert.equal(updated.ok, true, updated.blockers.join("\n"));
      const metadata = JSON.parse(readFileSync(first.manifestPath, "utf8"));
      assert.equal(metadata.skills["deep-research"].digest, before.skills["deep-research"].digest);
      assert.equal(metadata.skills["deep-research"].retained, true);
      assert.equal(readFileSync(target, "utf8"), userText);
    }
  } finally { fixture.cleanup(); }
});

test("a hidden config recognizes an absolute reference to the same project instruction", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "skills", "project", { apply: true });
    const config = readJsonc(projectConfig(fixture));
    config.instructions = [first.instructionsPath!];
    const hiddenConfig = join(fixture.project, ".opencode", "opencode.json");
    writeFileSync(hiddenConfig, JSON.stringify(config));
    fs.unlinkSync(projectConfig(fixture));
    fixture.env.ARS_OPENCODE_STATE_DIR = join(fixture.home, "fresh-state");
    const reused = await install(fixture, "skills", "project", { apply: true });
    assert.equal(reused.ok, true, reused.blockers.join("\n"));
    assert.equal(reused.changed, false);
    assert.deepEqual(readJsonc(hiddenConfig).instructions, [first.instructionsPath!]);
    assert.equal(existsSync(reused.manifestPath), false, "neither the file nor its reference becomes owned");
  } finally { fixture.cleanup(); }
});

test("packaging exclusions never hide later user data from ownership checks", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "skills", "project", { apply: true });
    const target = join(first.skillsDir!, "deep-research");
    for (const name of ["node_modules", ".git", "__pycache__"]) {
      mkdirSync(join(target, name));
      writeFileSync(join(target, name, "user-notes.txt"), `keep ${name}`);
    }
    const updated = await runInstaller(request(fixture, { action: "update", channel: "skills", apply: true }));
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.ok(updated.retained.includes("skills.deep-research"));
    const removed = await runInstaller(request(fixture, { action: "uninstall", channel: "skills", apply: true }));
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    for (const name of ["node_modules", ".git", "__pycache__"]) assert.equal(readFileSync(join(target, name, "user-notes.txt"), "utf8"), `keep ${name}`);
  } finally { fixture.cleanup(); }
});

test("a user replacement of the managed root by a junction remains untouched", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "skills", "project", { apply: true });
    const target = join(first.skillsDir!, "deep-research");
    const userDirectory = join(fixture.base, "user-owned-skill");
    fs.renameSync(target, userDirectory);
    fs.symlinkSync(userDirectory, target, process.platform === "win32" ? "junction" : "dir");
    const updated = await runInstaller(request(fixture, { action: "update", channel: "skills", apply: true }));
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.ok(updated.retained.includes("skills.deep-research"));
    const removed = await runInstaller(request(fixture, { action: "uninstall", channel: "skills", apply: true }));
    assert.equal(removed.ok, true);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
    assert.ok(existsSync(join(userDirectory, "SKILL.md")));
  } finally { fixture.cleanup(); }
});

test("disk check retains source preflight errors instead of reporting success", async () => {
  const fixture = makeFixture({ packageRootCopy: true });
  try {
    fs.unlinkSync(join(fixture.packageRoot, "agents", "synthesis_agent.md"));
    const report = await runInstaller(request(fixture, { action: "check", channel: "plugin" }));
    assert.equal(report.ok, false);
    assert.ok(report.blockers.some((s) => s.includes("synthesis_agent.md")));
    assert.ok(report.checks.some((c) => c.id === "preflight" && c.status === "error"));
    assert.equal(existsSync(projectConfig(fixture)), false);
    assert.equal(existsSync(fixture.env.ARS_OPENCODE_STATE_DIR!), false);
  } finally { fixture.cleanup(); }
});

test("a retired bundle changed during backup is not removed", async () => {
  const fixture = makeFixture();
  const originalCopy = fs.copyFileSync;
  try {
    const { skillTreeDigest } = await import("../src/install.ts");
    const first = await install(fixture, "skills", "project", { apply: true });
    const retired = join(first.skillsDir!, "retired-owned");
    mkdirSync(retired);
    const note = join(retired, "note.md");
    writeFileSync(note, "old data\n");
    const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
    manifest.skills["retired-owned"] = { dir: retired, digest: skillTreeDigest(retired) };
    writeFileSync(first.manifestPath, JSON.stringify(manifest));
    let changed = false;
    fs.copyFileSync = ((from: fs.PathLike, to: fs.PathLike, mode?: number) => {
      originalCopy(from, to, mode);
      if (!changed && resolve(String(from)) === resolve(note)) {
        writeFileSync(note, "new user data\n");
        changed = true;
      }
    }) as typeof fs.copyFileSync;
    syncBuiltinESMExports();
    const result = await runInstaller(request(fixture, { action: "update", channel: "skills", apply: true }));
    assert.equal(changed, true);
    assert.equal(result.ok, false);
    assert.equal(readFileSync(note, "utf8"), "new user data\n");
    assert.ok(JSON.parse(readFileSync(first.manifestPath, "utf8")).skills["retired-owned"]);
  } finally {
    fs.copyFileSync = originalCopy;
    syncBuiltinESMExports();
    fixture.cleanup();
  }
});
