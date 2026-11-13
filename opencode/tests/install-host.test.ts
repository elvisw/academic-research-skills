/** Real pinned host; explicit npm host gate never silently skips. */
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInstaller } from "../src/install.ts";
import { agentDifferences, loadNativeAgents } from "../src/setup.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const enabled = process.env.ARS_HOST_INSTALL === "1" || process.env.npm_lifecycle_event === "test:host:install";
const posix = (p: string) => p.replaceAll("\\", "/");
const expectedSkills = ["academic-paper", "academic-paper-reviewer", "academic-pipeline", "deep-research", "sr-screener"];
const expectedAgents = ["research-architect-agent", "synthesis-agent", "report-compiler-agent", "screening-reviewer-agent"];
const model = { providerID: "ars-install-test", model: "never-dispatch" };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function binaryPath(): string {
  const local = join(dirname(process.execPath), "node_modules", "@opencode", "cli", "node_modules", "@opencode", "cli-windows-x64-baseline", "bin", "opencode.exe");
  const binary = process.env.ARS_OPENCODE_BINARY || local;
  assert.ok(existsSync(binary), "set ARS_OPENCODE_BINARY to the real OpenCode 2.2.7 executable, not an NVM/launcher proxy");
  assert.match(execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 30000 }), /v?2\.2\.7\b/);
  return binary;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((r, reject) => server.close((e) => e ? reject(e) : r()));
  return port;
}

function isolatedEnv(base: string, binary: string): NodeJS.ProcessEnv {
  const home = join(base, "home");
  const env: NodeJS.ProcessEnv = { ...process.env };
  const roots = new Set(["home","userprofile","appdata","localappdata","programdata","xdg_config_home","xdg_data_home","xdg_state_home","xdg_cache_home","tmp","temp","tmpdir","path"]);
  for (const key of Object.keys(env)) {
    if (roots.has(key.toLowerCase()) || /KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|SSH|PROXY/i.test(key) || /^(ARS_|OPENCODE_|HIAGENT_|GIT_|PYTHON|NODE_OPTIONS|NODE_PATH|BUN_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"), ProgramData: join(home, "ProgramData"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
    TMP: join(base, "tmp"), TEMP: join(base, "tmp"), TMPDIR: join(base, "tmp"),
    ARS_OPENCODE_STATE_DIR: join(home, ".ars-state"),
    OPENCODE_PASSWORD: randomBytes(24).toString("hex"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  });
  for (const key of ["HOME","APPDATA","LOCALAPPDATA","ProgramData","XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_STATE_HOME","XDG_CACHE_HOME","TMP"]) mkdirSync(env[key]!, { recursive: true });
  const python = execFileSync("py", ["-3", "-E", "-s", "-B", "-c", "import sys; print(sys.executable)"], { encoding: "utf8", timeout: 30000 }).trim();
  const git = execFileSync("where.exe", ["git"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]!;
  env.PATH = [dirname(python), dirname(git), dirname(binary), dirname(process.execPath), join(process.env.SystemRoot!, "System32"), process.env.SystemRoot!].join(";");
  return env;
}

async function startHost(binary: string, project: string, env: NodeJS.ProcessEnv) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (v) => { log += String(v); });
  child.stderr!.on("data", (v) => { log += String(v); });
  child.on("error", (e) => { log += e.message; });
  const api = (directory: string, method: string, path: string, body?: unknown): any => {
    const args = ["api", "--server", url, method, path];
    if (body !== undefined) args.push("--data", JSON.stringify(body));
    const result = spawnSync(binary, args, { cwd: directory, env, encoding: "utf8", timeout: 90000, windowsHide: true });
    assert.equal(result.status, 0, `owned server API ${method} ${path}: ${result.stderr ?? result.error?.message ?? "failed"} ${(result.stdout ?? "").slice(0, 1000)}`);
    return result.stdout?.trim() ? JSON.parse(result.stdout) : undefined;
  };
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      assert.equal(child.exitCode, null, `owned server exited: ${log}`);
      if (log.includes(`:${port}`)) break;
      await pause(100);
    }
    assert.ok(log.includes(`:${port}`), `owned server did not announce its port: ${log}`);
    api(project, "GET", "/api/info");
  } catch (error) { child.kill(); throw error; }
  return {
    api,
    async probe(directory: string, mode: string) {
      const response = api(directory, "POST", "/api/session", { title: "isolated installer probe", agent: "build", location: { directory: posix(directory) }, permissions: [{ action: "external_directory", resource: "*", effect: "allow" }] });
      const session = response.data ?? response;
      try { api(directory, "POST", `/api/session/${session.id}/command`, { name: "installation-test-probe", text: mode }); }
      finally { api(directory, "DELETE", `/api/session/${session.id}`); }
    },
    async stop() {
      const stopped = new Promise<void>((r) => child.once("exit", () => r()));
      if (child.exitCode === null) { child.kill(); await Promise.race([stopped, pause(10000)]); }
      writeFileSync(join(project, "owned-server.log"), log);
      assert.ok(child.exitCode !== null || child.signalCode !== null, "owned fixture process did not stop");
    },
  };
}

function json(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }

test("pinned isolated host: four installation variants and same-server project separation", {
  skip: enabled ? false : "invoke npm run test:host:install; a skip is not acceptance",
  timeout: 10 * 60_000,
}, async (t) => {
  assert.equal(process.platform, "win32", "only Windows is currently validated");
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node 24+ required");
  const binary = binaryPath();
  const tempRoot = join(tmpdir(), "opencode");
  mkdirSync(tempRoot, { recursive: true });
  for (const channel of ["plugin", "skills"] as const) {
    for (const scope of ["project", "global"] as const) {
      await t.test(`${channel}/${scope}`, async () => {
        const base = mkdtempSync(join(tempRoot, `ars-host-${channel}-${scope}-`));
        const env = isolatedEnv(base, binary);
        const home = env.HOME!;
        const projects = [join(base, "project-one"), join(base, "project-two")];
        for (const p of projects) {
          mkdirSync(p, { recursive: true });
          execFileSync("git", ["init", "-q", p], { env, windowsHide: true });
        }
        const paths = execFileSync(binary, ["debug", "paths"], { cwd: projects[0], env, encoding: "utf8", timeout: 30000 });
        const runtimePaths = paths.trim().split(/\r?\n/).map((line) => line.trim().replace(/^\S+\s+/, ""));
        assert.ok(runtimePaths.length >= 8);
        for (const path of runtimePaths) assert.ok(posix(resolve(path)).startsWith(posix(base) + "/"), `host path escaped fixture: ${path}`);
        const pluginDir = join(base, "probe-plugin");
        mkdirSync(pluginDir);
        copyFileSync(join(repoRoot, "opencode", "tests", "fixtures", "install-host-probe.mjs"), join(pluginDir, "index.mjs"));
        writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "ars-install-test-probe", type: "module", exports: "./index.mjs" }));
        const request = { action: "install" as const, channel, scope, projectRoot: projects[0]!, packageRoot: repoRoot, home, env, apply: true,
          ...(channel === "plugin" ? { models: { aliases: { sonnet: model } } } : {}) };
        const installed = await runInstaller(request);
        assert.equal(installed.ok, true, installed.blockers.join("\n"));
        const config = json(installed.configPath);
        if (channel === "skills") assert.equal(config.plugins, undefined, "production skills install does not enable ARS plugin");
        config.plugins = [...(config.plugins ?? []), posix(pluginDir)];
        writeFileSync(installed.configPath, JSON.stringify(config));
        const second = await runInstaller(request);
        assert.equal(second.ok, true, second.blockers.join("\n"));
        assert.equal(second.changed, false, "reinstall is genuinely a no-op");
        assert.equal(second.applied, false);
        const host = await startHost(binary, projects[0]!, env);
        try {
          for (const project of scope === "global" ? projects : projects.slice(0, 1)) {
            await host.probe(project, "inventory");
            const inventory = json(join(project, "installation-inventory.json"));
            assert.equal(inventory.directory, posix(project));
            assert.equal(inventory.home, posix(home));
            assert.deepEqual(inventory.skills.map((s: any) => s.id), expectedSkills);
            for (const skill of inventory.skills) {
              assert.equal(skill.bodyLoaded, true, `native skill body ${skill.id}`);
              assert.equal(skill.resourceRead, true, `native resource ${skill.id}`);
              const expectedBase = channel === "plugin" ? join(repoRoot, skill.id) : scope === "project"
                ? join(project, ".opencode", "skills", skill.id) : join(home, ".config", "opencode", "skills", skill.id);
              assert.equal(posix(dirname(skill.path)), posix(expectedBase));
            }
            const ours = inventory.agents.filter((a: any) => expectedAgents.includes(a.id));
            assert.equal(ours.length, channel === "plugin" ? 4 : 1);
            const expected = loadNativeAgents(repoRoot, {}, [], { validateModels: false }).agents;
            for (const agent of ours) {
              const spec = expected.find((a) => a.id === agent.id)!;
              assert.deepEqual(agentDifferences(spec, agent), [], `real agent contract ${agent.id}`);
              for (const location of projects) assert.equal(agent.system.includes(posix(location)), false, "global native system is project-portable");
            }
            assert.equal(inventory.commands.filter((n: string) => n.startsWith("ars-")).length, channel === "plugin" ? 16 : 0);
            if (channel === "plugin") assert.equal(inventory.status.metadata.guard, "active");
            else assert.equal(inventory.toolIDs.some((id: string) => id === "ars_screening"), false);
            await host.probe(project, "context");
            const context = json(join(project, "instruction-probe.json"));
            assert.equal(context.instructionLoaded, true, "actual assembled instructions contain the installed file");
            if (channel === "skills") assert.equal(context.canonicalRouting, scope === "project");
            else {
              assert.equal(context.commandRootBound, true, "actual ars-full admission uses its own location root");
              await host.probe(project, "writes");
              const writes = json(join(project, "installation-writes.json"));
              assert.equal(writes.directory, posix(project));
              assert.equal(writes.guardBefore, "active");
              assert.equal(writes.guardAfter, "active");
              for (const result of writes.results) {
                assert.equal(result.actual, result.expected, JSON.stringify(result));
                assert.equal(result.exists, result.expected === "allow");
                if (result.expected === "deny") assert.equal(result.arsDeny, true, "deny must come from ARS, not a native default");
                else assert.equal(result.content, `fixture ${posix(project)}\n`);
              }
            }
          }
        } finally { await host.stop(); }
        console.log(`Retained isolated host evidence: ${base}`);
      });
    }
  }
});
