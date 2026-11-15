import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  digestValue,
  formatInstallReport,
  parseModelsArgument,
  runInstaller,
  skillTreeDigest,
  type Channel,
  type InstallReport,
  type InstallRequest,
  type Scope,
} from "../src/install.ts";
import { agentMarkdownDigest, renderAgentMarkdown } from "../src/agent-storage.ts";
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

function agentsDir(fixture: Fixture, scope: Scope = "project"): string {
  return scope === "global"
    ? join(fixture.home, ".config", "opencode", "agents")
    : join(fixture.project, ".opencode", "agents");
}

function agentFileNames(fixture: Fixture, scope: Scope = "project"): string[] {
  const dir = agentsDir(fixture, scope);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** The `model:` frontmatter line of one rendered agent, if any. */
function agentModelLine(
  fixture: Fixture,
  id: string,
  scope: Scope = "project",
): string | undefined {
  const text = readFileSync(join(agentsDir(fixture, scope), `${id}.md`), "utf8");
  return /^model: (.+)$/m.exec(text)?.[1];
}

/** Windows line endings for an installed Markdown file, without other edits. */
function withCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

interface OwnedAgentRecord {
  digest: string;
  path?: string;
  retained?: boolean;
}

function manifestAgents(manifestPath: string): Record<string, OwnedAgentRecord> {
  return (JSON.parse(readFileSync(manifestPath, "utf8")) as {
    agents: Record<string, OwnedAgentRecord>;
  }).agents;
}

function writeManifestAgents(
  manifestPath: string,
  agents: Record<string, OwnedAgentRecord>,
): void {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    agents: Record<string, OwnedAgentRecord>;
  };
  manifest.agents = agents;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function agentRecord(manifestPath: string, id: string): OwnedAgentRecord {
  const record = manifestAgents(manifestPath)[id];
  assert.ok(record, `ownership record for ${id}`);
  return record;
}

/** Drop `path` from one record, reproducing the interrupted-migration shape. */
function stripAgentPath(manifestPath: string, id: string): void {
  const agents = manifestAgents(manifestPath);
  agents[id] = { digest: agentRecord(manifestPath, id).digest };
  writeManifestAgents(manifestPath, agents);
}

/**
 * Turn a fresh plugin install into the pre-Markdown shape: inline agents in
 * `config.agents`, matching manifest digests, no Markdown files. Story 1.2 has
 * to migrate exactly this state, so the legacy inline branch stays covered.
 */
async function seedLegacyInline(fixture: Fixture): Promise<InstallReport> {
  const report = await install(fixture, "plugin", "project", { apply: true });
  assert.equal(report.ok, true, report.blockers.join("\n"));
  rmSync(agentsDir(fixture), { recursive: true, force: true });
  const config = readJsonc(projectConfig(fixture));
  const manifest = JSON.parse(readFileSync(report.manifestPath, "utf8")) as {
    agents: Record<string, { digest: string }>;
  };
  const { agents } = loadNativeAgents(fixture.packageRoot, {}, [], {
    validateModels: false,
  });
  const inline: Record<string, unknown> = {};
  for (const agent of agents) {
    const value = {
      description: agent.description,
      mode: agent.mode,
      system: agent.system,
      ...(agent.model ? { model: agent.model } : {}),
      permissions: agent.permissions,
    };
    inline[agent.id] = value;
    manifest.agents[agent.id] = { digest: digestValue(value) };
  }
  config.agents = inline;
  writeFileSync(projectConfig(fixture), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  writeFileSync(report.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return report;
}

test("a stale pre-Markdown ownership record is not converted into a Markdown claim", async () => {
  const fixture = makeFixture();
  try {
    await seedLegacyInline(fixture);
    const config = readJsonc(projectConfig(fixture));
    delete config.agents;
    writeFileSync(projectConfig(fixture), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const report = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(report.ok, false);
    assert.match(report.blockers.join("\n"), /pre-Markdown ownership record/);
    assert.match(report.blockers.join("\n"), /no inline entry exists/);
    assert.match(report.blockers.join("\n"), /Restore the inline entry/);
    assert.deepEqual(agentFileNames(fixture), []);
    assert.equal(readJsonc(projectConfig(fixture)).agents, undefined);
  } finally {
    fixture.cleanup();
  }
});

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
    assert.equal(readJsonc(projectConfig(fixture)).agents, undefined);
    assert.deepEqual(agentFileNames(fixture), []);
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
    assert.equal(existsSync(agentsDir(fixture)), false);

    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    assert.equal(first.applied, true);
    const config = readJsonc(projectConfig(fixture));
    assert.equal((config.plugins as unknown[]).length, 1);
    assert.equal(config.agents, undefined, "new installs write Markdown, not agents.<id>");
    assert.deepEqual(agentFileNames(fixture), [
      "report-compiler-agent.md",
      "research-architect-agent.md",
      "screening-reviewer-agent.md",
      "synthesis-agent.md",
    ]);
    assert.equal(first.agentsDir.replace(/\\/g, "/"), agentsDir(fixture).replace(/\\/g, "/"));
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
    assert.equal(config.agents, undefined);
    assert.deepEqual(agentFileNames(fixture, "global"), [
      "report-compiler-agent.md",
      "research-architect-agent.md",
      "screening-reviewer-agent.md",
      "synthesis-agent.md",
    ]);

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
    const agentsText = agentFileNames(fixture, "global")
      .map((name) => readFileSync(join(agentsDir(fixture, "global"), name), "utf8"))
      .join("\n");
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
    assert.equal(config.agents, undefined, "the reviewer is a Markdown file");
    assert.deepEqual(agentFileNames(fixture), ["screening-reviewer-agent.md"]);
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
    assert.equal(config.agents, undefined);
    assert.deepEqual(agentFileNames(fixture, "global"), ["screening-reviewer-agent.md"]);
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
    assert.equal(config.agents, undefined);
    assert.deepEqual(agentFileNames(fixture), [], "unchanged Markdown agents are removed");
    assert.equal(existsSync(first.manifestPath), false);

    // A user-edited Markdown agent is retained, not removed.
    const second = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(second.ok, true, second.blockers.join("\n"));
    const edited = join(agentsDir(fixture), "synthesis-agent.md");
    writeFileSync(edited, `${readFileSync(edited, "utf8")}\nmy own edits\n`, "utf8");
    const partial = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(partial.ok, true, partial.blockers.join("\n"));
    assert.match(readFileSync(edited, "utf8"), /my own edits/);
    assert.deepEqual(agentFileNames(fixture), ["synthesis-agent.md"]);
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
    assert.equal(kept.agents, undefined);
    assert.deepEqual(agentFileNames(fixture), ["screening-reviewer-agent.md"]);
    assert.equal(
      failed.operations.some(
        (operation) =>
          operation.kind === "remove" &&
          operation.target.endsWith("screening-reviewer-agent.md"),
      ),
      false,
      "a skipped agent removal must not be reported as removed",
    );
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

test("preview refuses a second channel without deleting the first installation", async () => {
  const fixture = makeFixture();
  try {
    const skills = await install(fixture, "skills", "project", { apply: true });
    assert.equal(skills.ok, true);
    const preview = await install(fixture, "plugin", "project");
    assert.equal(preview.ok, false);
    assert.match(preview.warnings.join("\n"), /native skill copies also exist/);
    assert.match(preview.blockers.join("\n"), /already owns screening-reviewer-agent/);
    assert.equal(existsSync(join(fixture.project, ".opencode", "skills", "deep-research", "SKILL.md")), true);

    const clean = makeFixture();
    try {
      const plugin = await install(clean, "plugin", "project", { apply: true });
      assert.equal(plugin.ok, true);
      const skillsPreview = await install(clean, "skills", "project");
      assert.equal(skillsPreview.ok, false);
      assert.match(skillsPreview.warnings.join("\n"), /plugin entry for this checkout also exists/);
      assert.match(skillsPreview.blockers.join("\n"), /already owns screening-reviewer-agent/);
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
    const parsed = parseModelsArgument(
      '{"aliases":{"sonnet":{"providerID":"p","model":"m"}},"agents":{"synthesis-agent":{"providerID":"p","model":"m2","variant":"high"}},"screening":{"roles":{"FTA":{"providerID":"p","model":"m3"}}}}',
      process.cwd(),
    );
    const report = await install(fixture, "plugin", "project", {
      apply: true,
      models: parsed?.models,
      screeningRoles: parsed?.screeningRoles,
    });
    assert.equal(report.ok, true, report.blockers.join("\n"));
    const config = readJsonc(projectConfig(fixture));
    const entry = (config.plugins as Record<string, unknown>[])[0]!;
    const options = entry.options as Record<string, unknown>;
    assert.deepEqual(options.models, parsed?.models);
    assert.deepEqual(
      (options.screening as Record<string, unknown>).roles,
      { FTA: { providerID: "p", model: "m3" } },
    );
    assert.equal(config.agents, undefined, "the variant lives in the Markdown frontmatter");
    assert.equal(agentModelLine(fixture, "synthesis-agent"), "p/m2#high");
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
    const screeningRoles = {
      FTA: { providerID: "probe", model: "screening-choice" },
    };
    const first = await install(fixture, "plugin", "project", { apply: true, models, screeningRoles });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    const config = readJsonc(projectConfig(fixture));
    const entry = (config.plugins as Record<string, unknown>[])[0]!;
    assert.deepEqual((entry.options as Record<string, unknown>).models, models);
    assert.deepEqual(
      ((entry.options as Record<string, unknown>).screening as Record<string, unknown>).roles,
      screeningRoles,
    );
    assert.equal(config.agents, undefined);
    assert.equal(agentModelLine(fixture, "synthesis-agent"), "probe/agent-choice");
    const check = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const modelCheck = check.checks.find((item) => item.id === "models");
    assert.equal(modelCheck?.status, "ok");
    assert.match(modelCheck?.detail ?? "", /agents\.synthesis-agent/);
    assert.match(modelCheck?.detail ?? "", /aliases\.sonnet/);
    const screeningCheck = check.checks.find((item) => item.id === "screening-models");
    assert.equal(screeningCheck?.status, "ok");
    assert.match(screeningCheck?.detail ?? "", /FTA/);

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

test("the screening check does not claim alias defaults when no aliases exist", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));

    const withoutAliases = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const blocked = withoutAliases.checks.find(
      (item) => item.id === "screening-models",
    );
    assert.equal(blocked?.status, "warn");
    assert.match(
      blocked?.detail ?? "",
      /stay blocked until models\.aliases\.\* are configured/,
    );
    assert.doesNotMatch(blocked?.detail ?? "", /tier defaults/);

    const withAliases = await runInstaller(
      request(fixture, {
        action: "update",
        channel: "plugin",
        scope: "project",
        apply: true,
        models: { aliases: { sonnet: { providerID: "probe", model: "balanced" } } },
      }),
    );
    assert.equal(withAliases.ok, true, withAliases.blockers.join("\n"));
    const resolved = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const detail =
      resolved.checks.find((item) => item.id === "screening-models")?.detail ?? "";
    assert.match(detail, /tier defaults/);
    assert.doesNotMatch(detail, /stay blocked/);
  } finally {
    fixture.cleanup();
  }
});

test("V02 a retained agent stays retained across repeated updates", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true);
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const original = readFileSync(target, "utf8");
    const userText = original.replace(
      /^description: .*$/m,
      "description: user-edited-description",
    );
    assert.notEqual(userText, original);
    writeFileSync(target, userText, "utf8");
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
    assert.equal(readFileSync(target, "utf8"), userText);
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

test("an unowned Markdown agent with different content blocks the whole install", async () => {
  const fixture = makeFixture();
  try {
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const mine = "---\ndescription: my own agent\nmode: subagent\n---\n\nmine\n";
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, mine, "utf8");
    const report = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(report.ok, false);
    assert.match(report.blockers.join("\n"), /already exists with different content outside this installer/);
    assert.match(report.blockers.join("\n"), /synthesis-agent\.md/);
    assert.equal(readFileSync(target, "utf8"), mine);
    assert.equal(existsSync(projectConfig(fixture)), false, "blocked install writes no configuration");
    assert.deepEqual(agentFileNames(fixture), ["synthesis-agent.md"]);
  } finally {
    fixture.cleanup();
  }
});

test("an identical unowned Markdown agent is reused without claiming ownership", async () => {
  const fixture = makeFixture();
  try {
    const synthesis = loadNativeAgents(fixture.packageRoot, {}, [], {
      validateModels: false,
    }).agents.find((agent) => agent.id === "synthesis-agent");
    assert.ok(synthesis);
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderAgentMarkdown(synthesis), "utf8");

    const report = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(report.ok, true, report.blockers.join("\n"));
    const manifest = JSON.parse(readFileSync(report.manifestPath, "utf8")) as {
      agents: Record<string, unknown>;
    };
    assert.equal(manifest.agents["synthesis-agent"], undefined, "reused file is not claimed");
    assert.deepEqual(agentFileNames(fixture), [
      "report-compiler-agent.md",
      "research-architect-agent.md",
      "screening-reviewer-agent.md",
      "synthesis-agent.md",
    ]);

    const uninstall = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(uninstall.ok, true, uninstall.blockers.join("\n"));
    assert.ok(existsSync(target), "an unowned reusable file survives uninstall");
    assert.deepEqual(agentFileNames(fixture), ["synthesis-agent.md"]);
  } finally {
    fixture.cleanup();
  }
});

test("Markdown and inline definitions of one agent are refused before any write", async () => {
  const fixture = makeFixture();
  try {
    await install(fixture, "plugin", "project", { apply: true });
    const config = readJsonc(projectConfig(fixture));
    config.agents = {
      "synthesis-agent": {
        description: "second definition",
        mode: "subagent",
        system: "second definition",
        permissions: [],
      },
    };
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(projectConfig(fixture), configText, "utf8");
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const before = readFileSync(target, "utf8");

    const report = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(report.ok, false);
    const blockers = report.blockers.join("\n");
    assert.match(blockers, /exists twice/);
    assert.match(blockers, /synthesis-agent\.md/);
    assert.match(blockers, /agents\.synthesis-agent/);
    assert.equal(readFileSync(target, "utf8"), before);
    assert.equal(readFileSync(projectConfig(fixture), "utf8"), configText);

    const check = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const entry = check.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(entry?.status, "error");
    assert.match(entry?.detail ?? "", /defined twice/);
  } finally {
    fixture.cleanup();
  }
});

test("an inline definition in the other scope is refused before a Markdown write", async () => {
  const fixture = makeFixture();
  try {
    const globalPath = globalConfig(fixture);
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(
      globalPath,
      `${JSON.stringify({
        agents: {
          "synthesis-agent": {
            description: "global inline",
            mode: "subagent",
            system: "global inline",
            permissions: [],
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const project = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(project.ok, false);
    assert.match(project.blockers.join("\n"), /global scope/);
    assert.deepEqual(agentFileNames(fixture), []);
    assert.equal(existsSync(projectConfig(fixture)), false);
    const check = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const conflict = check.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(conflict?.status, "error");
    assert.match(conflict?.detail ?? "", /global scope/);

    const projectPath = projectConfig(fixture);
    writeFileSync(
      projectPath,
      `${JSON.stringify({
        agents: {
          "synthesis-agent": {
            description: "project inline",
            mode: "subagent",
            system: "project inline",
            permissions: [],
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const global = await install(fixture, "plugin", "global", { apply: true });
    assert.equal(global.ok, false);
    const globalMessage = global.blockers.join("\n");
    assert.match(globalMessage, /project scope/);
    assert.equal(
      globalMessage.includes(fixture.project.replace(/\\/g, "/")),
      true,
      "global blocker names the current project",
    );
    const globalCheck = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "global" }),
    );
    const globalEntry = globalCheck.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(globalEntry?.status, "error");
    assert.equal(
      (globalEntry?.detail ?? "").includes(fixture.project.replace(/\\/g, "/")),
      true,
      "global check names the current project",
    );
    assert.deepEqual(agentFileNames(fixture, "global"), []);
    assert.match(readFileSync(projectPath, "utf8"), /project inline/);
  } finally {
    fixture.cleanup();
  }
});

test("a CLI-style request finds the other scope through the process XDG root", async () => {
  const fixture = makeFixture();
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalState = process.env.ARS_OPENCODE_STATE_DIR;
  try {
    const xdg = join(fixture.home, "cli-xdg");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.ARS_OPENCODE_STATE_DIR = join(fixture.home, ".ars-state");
    const globalPath = join(xdg, "opencode", "opencode.json");
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(
      globalPath,
      `${JSON.stringify({
        agents: {
          "synthesis-agent": {
            description: "global inline through XDG",
            mode: "subagent",
            system: "global inline through XDG",
            permissions: [],
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const report = await runInstaller({
      action: "install",
      channel: "plugin",
      scope: "project",
      projectRoot: fixture.project,
      packageRoot: fixture.packageRoot,
      home: fixture.home,
      apply: true,
    });
    assert.equal(report.ok, false);
    assert.match(report.blockers.join("\n"), /global scope/);
    assert.deepEqual(agentFileNames(fixture), []);
  } finally {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalState === undefined) delete process.env.ARS_OPENCODE_STATE_DIR;
    else process.env.ARS_OPENCODE_STATE_DIR = originalState;
    fixture.cleanup();
  }
});

test("a source change rewrites an owned Markdown agent and advances its digest", async () => {
  const fixture = makeFixture({ packageRootCopy: true });
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
    assert.equal(resolve(manifest.agents["synthesis-agent"].path), resolve(target));
    const before = readFileSync(target, "utf8");

    const source = join(fixture.packageRoot, "agents", "synthesis_agent.md");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n<!-- source update -->\n`, "utf8");
    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.equal(updated.retained.includes("agents.synthesis-agent"), false);
    const after = readFileSync(target, "utf8");
    assert.notEqual(after, before);
    assert.match(after, /<!-- source update -->/);
    const nextManifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
    assert.notEqual(nextManifest.agents["synthesis-agent"].digest, manifest.agents["synthesis-agent"].digest);

    const second = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(second.changed, false, "a second update is a no-op");
  } finally {
    fixture.cleanup();
  }
});

test("a failed configuration write rolls back the Markdown agents written by the same run", async () => {
  const fixture = makeFixture();
  try {
    const report = await install(fixture, "plugin", "project", {
      apply: true,
      testHooks: { failAt: "config" },
    });
    assert.equal(report.ok, false);
    assert.equal(report.applied, false);
    assert.deepEqual(agentFileNames(fixture), []);
    assert.equal(existsSync(projectConfig(fixture)), false);
    assert.equal(existsSync(report.manifestPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("a failed agent write rolls back the skills and instructions written before it", async () => {
  const fixture = makeFixture();
  try {
    const report = await install(fixture, "skills", "project", {
      apply: true,
      testHooks: { failAt: "agents" },
    });
    assert.equal(report.ok, false);
    assert.equal(report.applied, false);
    assert.deepEqual(agentFileNames(fixture), []);
    for (const name of [
      "academic-paper",
      "academic-paper-reviewer",
      "academic-pipeline",
      "deep-research",
      "sr-screener",
    ]) {
      assert.equal(existsSync(join(fixture.project, ".opencode", "skills", name)), false, name);
    }
    assert.equal(
      existsSync(join(fixture.project, ".opencode", "ars-instructions.md")),
      false,
    );
    assert.equal(existsSync(projectConfig(fixture)), false);
    assert.equal(existsSync(report.manifestPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("check names each Markdown agent path and reports missing or edited files", async () => {
  const fixture = makeFixture();
  try {
    await install(fixture, "plugin", "project", { apply: true });
    const ok = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const present = ok.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(present?.status, "ok");
    assert.match(present?.detail ?? "", /synthesis-agent\.md/);
    assert.equal(ok.agentsDir.replace(/\\/g, "/"), agentsDir(fixture).replace(/\\/g, "/"));

    rmSync(join(agentsDir(fixture), "synthesis-agent.md"));
    const missing = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const absent = missing.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(absent?.status, "warn");
    assert.match(absent?.detail ?? "", /not present/);

    const edited = join(agentsDir(fixture), "report-compiler-agent.md");
    writeFileSync(edited, readFileSync(edited, "utf8").replace(/^mode: .*$/m, "mode: primary"), "utf8");
    const changed = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const differs = changed.checks.find((item) => item.id === "agent:report-compiler-agent");
    assert.equal(differs?.status, "warn");
    assert.match(differs?.detail ?? "", /differs in frontmatter/);
  } finally {
    fixture.cleanup();
  }
});

test("a stale pathless record with a matching file warns and is adopted by update", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const before = readFileSync(target, "utf8");
    stripAgentPath(first.manifestPath, "synthesis-agent");
    const configBefore = readFileSync(projectConfig(fixture), "utf8");

    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const check = checked.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(check?.status, "warn");
    assert.equal(checked.ok, true, checked.blockers.join("\n"));
    const verdict = check?.detail ?? "";
    assert.match(verdict, /interrupted migration/);
    assert.match(verdict, /synthesis-agent\.md/);
    assert.match(verdict, /entry is already absent/);
    assert.match(verdict, /no manual repair is needed/);

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.equal(updated.applied, true);
    assert.equal(readFileSync(target, "utf8"), before, "a canonical file is not rewritten");
    assert.equal(
      updated.operations.some((operation) => /line endings canonicalized/.test(operation.detail)),
      false,
      "the recovery does not schedule a rewrite for canonical bytes",
    );
    assert.equal(readFileSync(projectConfig(fixture), "utf8"), configBefore);
    const record = agentRecord(first.manifestPath, "synthesis-agent");
    assert.equal(resolve(record.path!), resolve(target));
    assert.equal(record.digest, agentMarkdownDigest(before));

    const second = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(second.changed, false, "a second update is a no-op");
    const rechecked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    assert.equal(
      rechecked.checks.find((item) => item.id === "agent:synthesis-agent")?.status,
      "ok",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a stale pathless record whose file differs from the source errors and is not adopted", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    writeFileSync(
      target,
      readFileSync(target, "utf8").replace(/^description: .*$/m, "description: local"),
      "utf8",
    );
    stripAgentPath(first.manifestPath, "synthesis-agent");
    const manifestBefore = readFileSync(first.manifestPath, "utf8");
    const configBefore = readFileSync(projectConfig(fixture), "utf8");
    const fileBefore = readFileSync(target, "utf8");

    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const check = checked.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(check?.status, "error");
    const verdict = check?.detail ?? "";
    assert.match(verdict, /differs from the current source/);
    assert.match(verdict, /Nothing was changed/);

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, false);
    assert.deepEqual(updated.blockers, [verdict], "check and update share one manual action");
    assert.equal(readFileSync(target, "utf8"), fileBefore);
    assert.equal(readFileSync(first.manifestPath, "utf8"), manifestBefore);
    assert.equal(readFileSync(projectConfig(fixture), "utf8"), configBefore);
  } finally {
    fixture.cleanup();
  }
});

test("a pathless record with file and inline is recoverable instead of a dual-form error", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const before = readFileSync(target, "utf8");
    stripAgentPath(first.manifestPath, "synthesis-agent");
    const { agents } = loadNativeAgents(fixture.packageRoot, {}, [], {
      validateModels: false,
    });
    const source = agents.find((agent) => agent.id === "synthesis-agent");
    assert.ok(source);
    const config = readJsonc(projectConfig(fixture));
    config.agents = {
      ...((config.agents as Record<string, unknown> | undefined) ?? {}),
      "synthesis-agent": {
        description: source.description,
        mode: source.mode,
        system: source.system,
        ...(source.model ? { model: source.model } : {}),
        permissions: source.permissions,
      },
    };
    writeFileSync(projectConfig(fixture), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const check = checked.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(check?.status, "warn", "the crash state is recovery, not two definitions");
    assert.match(check?.detail ?? "", /interrupted migration/);
    assert.match(check?.detail ?? "", /entry already matches the current source/);

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    const after = readJsonc(projectConfig(fixture));
    assert.equal((after.agents as Record<string, unknown> | undefined)?.["synthesis-agent"], undefined);
    assert.equal(readFileSync(target, "utf8"), before);
    const record = agentRecord(first.manifestPath, "synthesis-agent");
    assert.equal(resolve(record.path!), resolve(target));
    assert.equal(record.digest, agentMarkdownDigest(before));
  } finally {
    fixture.cleanup();
  }
});

test("a stale pathless record without a file reports the same verdict and writes nothing", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    rmSync(target);
    stripAgentPath(first.manifestPath, "synthesis-agent");
    const manifestBefore = readFileSync(first.manifestPath, "utf8");
    const configBefore = readFileSync(projectConfig(fixture), "utf8");

    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const check = checked.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(check?.status, "error");
    assert.equal(checked.ok, false);
    const verdict = check?.detail ?? "";
    assert.match(verdict, /no inline entry exists/);
    assert.match(verdict, /no Markdown file exists/);

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, false);
    assert.deepEqual(updated.blockers, [verdict]);
    assert.equal(existsSync(target), false);
    assert.equal(readFileSync(first.manifestPath, "utf8"), manifestBefore);
    assert.equal(readFileSync(projectConfig(fixture), "utf8"), configBefore);
  } finally {
    fixture.cleanup();
  }
});

test("an owned Markdown file deleted by the user is recreated by update", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const canonical = readFileSync(target, "utf8");
    rmSync(target);

    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const check = checked.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(check?.status, "warn");
    assert.match(check?.detail ?? "", /not present/);

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.equal(readFileSync(target, "utf8"), canonical);
    const record = agentRecord(first.manifestPath, "synthesis-agent");
    assert.equal(record.retained, undefined);
    assert.equal(record.digest, agentMarkdownDigest(canonical));
  } finally {
    fixture.cleanup();
  }
});

test("an owned CRLF file is ok to check, canonicalized by update and removed by uninstall", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const canonical = readFileSync(target, "utf8");
    writeFileSync(target, withCrlf(canonical), "utf8");

    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    assert.equal(
      checked.checks.find((item) => item.id === "agent:synthesis-agent")?.status,
      "ok",
    );

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.equal(updated.retained.includes("agents.synthesis-agent"), false);
    assert.equal(readFileSync(target, "utf8"), canonical);
    assert.equal(
      agentRecord(first.manifestPath, "synthesis-agent").digest,
      agentMarkdownDigest(canonical),
    );

    const again = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(again.ok, true, again.blockers.join("\n"));
    assert.equal(again.changed, false, "a second update is a no-op");
    const rechecked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    assert.equal(
      rechecked.checks.find((item) => item.id === "agent:synthesis-agent")?.status,
      "ok",
      "a later check remains ok after canonicalization",
    );

    const removed = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    assert.equal(existsSync(target), false);
  } finally {
    fixture.cleanup();
  }
});

test("a retained record is healed when the file matches the source again", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const canonical = readFileSync(target, "utf8");
    writeFileSync(
      target,
      canonical.replace(/^description: .*$/m, "description: user-edited-description"),
      "utf8",
    );
    const retained = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(retained.ok, true, retained.blockers.join("\n"));
    assert.equal(agentRecord(first.manifestPath, "synthesis-agent").retained, true);

    // Back to the source text, but saved with Windows line endings.
    writeFileSync(target, withCrlf(canonical), "utf8");
    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    assert.equal(
      checked.checks.find((item) => item.id === "agent:synthesis-agent")?.status,
      "ok",
    );

    const healed = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(healed.ok, true, healed.blockers.join("\n"));
    assert.equal(healed.retained.includes("agents.synthesis-agent"), false);
    assert.equal(readFileSync(target, "utf8"), canonical);
    const record = agentRecord(first.manifestPath, "synthesis-agent");
    assert.equal(record.retained, undefined);
    assert.equal(record.digest, agentMarkdownDigest(canonical));
    const rechecked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    assert.equal(
      rechecked.checks.find((item) => item.id === "agent:synthesis-agent")?.status,
      "ok",
      "a later check remains ok after healing",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a CRLF file whose source changed warns and is refreshed to canonical bytes", async () => {
  const fixture = makeFixture({ packageRootCopy: true });
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    writeFileSync(target, withCrlf(readFileSync(target, "utf8")), "utf8");

    const source = join(fixture.packageRoot, "agents", "synthesis_agent.md");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n<!-- source update -->\n`, "utf8");

    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const check = checked.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(check?.status, "warn");
    assert.match(check?.detail ?? "", /differs in instructions/);

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.equal(updated.retained.includes("agents.synthesis-agent"), false);
    const after = readFileSync(target, "utf8");
    assert.match(after, /<!-- source update -->/);
    assert.doesNotMatch(after, /\r/);
    assert.equal(
      agentRecord(first.manifestPath, "synthesis-agent").digest,
      agentMarkdownDigest(after),
    );

    const again = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(again.ok, true, again.blockers.join("\n"));
    assert.equal(again.changed, false, "a second update is a no-op");
    const rechecked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    assert.equal(
      rechecked.checks.find((item) => item.id === "agent:synthesis-agent")?.status,
      "ok",
      "a later check remains ok after refreshing the source",
    );
  } finally {
    fixture.cleanup();
  }
});

test("an unowned CRLF duplicate is reused by update without a claim and survives uninstall", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const crlf = withCrlf(readFileSync(target, "utf8"));
    writeFileSync(target, crlf, "utf8");
    const agents = manifestAgents(first.manifestPath);
    delete agents["synthesis-agent"];
    writeManifestAgents(first.manifestPath, agents);

    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    assert.equal(
      checked.checks.find((item) => item.id === "agent:synthesis-agent")?.status,
      "ok",
    );

    const reused = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(reused.ok, true, reused.blockers.join("\n"));
    assert.equal(readFileSync(target, "utf8"), crlf, "an unowned file is never rewritten");
    assert.equal(
      manifestAgents(first.manifestPath)["synthesis-agent"],
      undefined,
      "update does not claim the unowned file",
    );
    assert.ok(
      reused.operations.some(
        (operation) => operation.kind === "reuse" && resolve(operation.target) === resolve(target),
      ),
    );

    const removed = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    assert.equal(readFileSync(target, "utf8"), crlf);
  } finally {
    fixture.cleanup();
  }
});

test("a CRLF file with a genuine edit is retained and never overwritten", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const edited = withCrlf(
      readFileSync(target, "utf8").replace(/^description: .*$/m, "description: user-edited-description"),
    );
    writeFileSync(target, edited, "utf8");

    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const check = checked.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(check?.status, "warn");
    assert.match(check?.detail ?? "", /differs in frontmatter/);

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.ok(updated.retained.includes("agents.synthesis-agent"));
    assert.equal(readFileSync(target, "utf8"), edited);
    const record = agentRecord(first.manifestPath, "synthesis-agent");
    assert.equal(record.retained, true);
    assert.equal(record.digest, agentMarkdownDigest(edited));

    const again = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.ok(again.retained.includes("agents.synthesis-agent"));
    assert.equal(readFileSync(target, "utf8"), edited);

    const removed = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    assert.ok(removed.retained.includes("agents.synthesis-agent"));
    assert.equal(readFileSync(target, "utf8"), edited);
  } finally {
    fixture.cleanup();
  }
});

test("uninstall removes an owned CRLF file without a prior update", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    writeFileSync(target, withCrlf(readFileSync(target, "utf8")), "utf8");

    const removed = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    assert.equal(existsSync(target), false);
    const stillRecorded =
      existsSync(first.manifestPath) &&
      manifestAgents(first.manifestPath)["synthesis-agent"] !== undefined;
    assert.equal(stillRecorded, false, "the removed record is not left behind");
  } finally {
    fixture.cleanup();
  }
});

test("a retained record whose file was deleted restores the file on update", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const canonical = readFileSync(target, "utf8");
    writeFileSync(
      target,
      canonical.replace(/^description: .*$/m, "description: user-edited-description"),
      "utf8",
    );
    const retained = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(retained.ok, true, retained.blockers.join("\n"));
    assert.equal(agentRecord(first.manifestPath, "synthesis-agent").retained, true);

    rmSync(target);
    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const missing = checked.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(missing?.status, "warn");
    assert.match(missing?.detail ?? "", /retained/);
    assert.match(missing?.detail ?? "", /update will restore/);
    assert.doesNotMatch(missing?.detail ?? "", /not present:/);

    // A manually re-added inline entry while the retained file is missing must
    // not make `check` claim the inline definition is healthy: `update` stops
    // on the retained record instead of restoring the file.
    const configBeforeInline = JSON.parse(readFileSync(first.configPath, "utf8"));
    writeFileSync(
      first.configPath,
      `${JSON.stringify(
        {
          ...configBeforeInline,
          agents: {
            ...(configBeforeInline.agents ?? {}),
            "synthesis-agent": { system: "inline while the retained file is missing" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const conflicted = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const conflict = conflicted.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(conflict?.status, "error");
    assert.match(conflict?.detail ?? "", /retained/);
    assert.match(conflict?.detail ?? "", /inline/);
    assert.doesNotMatch(conflict?.detail ?? "", /or restore the file manually/);

    const blockedUpdate = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(blockedUpdate.ok, false);
    assert.match(blockedUpdate.blockers.join("\n"), /retained legacy inline/);
    assert.doesNotMatch(
      blockedUpdate.blockers.join("\n"),
      /Restore the original inline value/,
    );

    // Restoring only the file leaves the definition twice; the error text
    // must not send the user down that path.
    writeFileSync(target, canonical, "utf8");
    const dual = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const dualCheck = dual.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(dualCheck?.status, "error");
    assert.match(dualCheck?.detail ?? "", /defined twice/);
    rmSync(target);
    const configAfterInline = JSON.parse(readFileSync(first.configPath, "utf8"));
    delete configAfterInline.agents["synthesis-agent"];
    writeFileSync(first.configPath, `${JSON.stringify(configAfterInline, null, 2)}\n`, "utf8");

    const restored = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(restored.ok, true, restored.blockers.join("\n"));
    assert.equal(readFileSync(target, "utf8"), canonical);
    const record = agentRecord(first.manifestPath, "synthesis-agent");
    assert.equal(record.retained, undefined);
    assert.equal(record.digest, agentMarkdownDigest(canonical));
  } finally {
    fixture.cleanup();
  }
});

test("a body trailing-whitespace edit is warned about and never overwritten", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    const canonical = readFileSync(target, "utf8");
    const edited = canonical.replace(/\n$/, "   \n");
    assert.notEqual(edited, canonical);
    writeFileSync(target, edited, "utf8");

    const checked = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const check = checked.checks.find((item) => item.id === "agent:synthesis-agent");
    assert.equal(check?.status, "warn");
    assert.match(check?.detail ?? "", /matches the source semantically, but its bytes differ/);
    assert.match(check?.detail ?? "", /update and uninstall will keep it/);

    const updated = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(updated.ok, true, updated.blockers.join("\n"));
    assert.ok(updated.retained.includes("agents.synthesis-agent"));
    assert.equal(readFileSync(target, "utf8"), edited);
    assert.equal(agentRecord(first.manifestPath, "synthesis-agent").retained, true);

    const checkedAfterRetain = await runInstaller(
      request(fixture, { action: "check", channel: "plugin", scope: "project" }),
    );
    const retainedCheck = checkedAfterRetain.checks.find(
      (item) => item.id === "agent:synthesis-agent",
    );
    assert.equal(retainedCheck?.status, "warn");
    assert.match(retainedCheck?.detail ?? "", /retained/);
    assert.match(retainedCheck?.detail ?? "", /update and uninstall keep it/);

    const again = await runInstaller(
      request(fixture, { action: "update", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(again.ok, true, again.blockers.join("\n"));
    assert.ok(again.retained.includes("agents.synthesis-agent"));
    assert.ok(
      again.operations.some(
        (operation) =>
          operation.kind === "retain" &&
          resolve(operation.target) === resolve(target),
      ),
      again.operations.map((operation) => `${operation.kind}:${operation.target}`).join("\n"),
    );
    assert.equal(readFileSync(target, "utf8"), edited);
    const retainedRecord = agentRecord(first.manifestPath, "synthesis-agent");
    assert.equal(retainedRecord.retained, true);
    assert.equal(retainedRecord.digest, agentMarkdownDigest(edited));

    const removed = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    assert.ok(removed.retained.includes("agents.synthesis-agent"));
    assert.equal(readFileSync(target, "utf8"), edited);
  } finally {
    fixture.cleanup();
  }
});

test("uninstall reports a stale pre-Markdown record instead of dropping it silently", async () => {
  const fixture = makeFixture();
  try {
    const first = await install(fixture, "plugin", "project", { apply: true });
    assert.equal(first.ok, true, first.blockers.join("\n"));
    const target = join(agentsDir(fixture), "synthesis-agent.md");
    stripAgentPath(first.manifestPath, "synthesis-agent");

    const removed = await runInstaller(
      request(fixture, { action: "uninstall", channel: "plugin", scope: "project", apply: true }),
    );
    assert.equal(removed.ok, true, removed.blockers.join("\n"));
    assert.ok(
      removed.warnings.some((warning) => /stale pre-Markdown ownership record/.test(warning)),
      removed.warnings.join("\n"),
    );
    assert.ok(
      removed.operations.some(
        (operation) =>
          operation.kind === "keep" && /no Markdown path was owned/.test(operation.detail),
      ),
    );
    assert.equal(existsSync(target), true, "a pathless record never deletes a file");
    const stillRecorded =
      existsSync(first.manifestPath) &&
      manifestAgents(first.manifestPath)["synthesis-agent"] !== undefined;
    assert.equal(stillRecorded, false);
  } finally {
    fixture.cleanup();
  }
});
