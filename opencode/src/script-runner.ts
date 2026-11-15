/**
 * Deterministic, shell-free process execution for the ARS Python scripts.
 *
 * Mirrors hooks/run_guard.sh's interpreter discovery (py -3, python3, python),
 * skips Microsoft Store stubs by requiring an explicit marker, and bounds every
 * run. No command string is ever passed to a shell.
 */
import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

const MARKER = "ARS_PY_OK";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 1_000_000;

interface Candidate {
  command: string;
  prefix: string[];
}

const CANDIDATES: Candidate[] = [
  { command: "py", prefix: ["-3"] },
  { command: "python3", prefix: [] },
  { command: "python", prefix: [] },
];

let cachedInterpreter: string[] | null | undefined;

/**
 * Isolate the child from ambient CLAUDE_* variables, then set the two trusted
 * roots the guard reads. `CLAUDE_PROJECT_DIR` is the user's project; the
 * package root is the ARS checkout, never a path reported by a prompt.
 */
export function isolatedPythonEnv(options: {
  packageRoot: string;
  projectRoot: string;
  base?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const base = options.base ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("CLAUDE_")) continue;
    env[key] = value;
  }
  env.CLAUDE_PROJECT_DIR = options.projectRoot;
  env.CLAUDE_PLUGIN_ROOT = options.packageRoot;
  env.ARS_PLUGIN_ROOT = options.packageRoot;
  env.ARS_PROJECT_DIR = options.projectRoot;
  // The guard itself also honours this; keep the child deterministic.
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  return env;
}

/**
 * OpenCode 2.3.x runs plugins on Bun on Windows. Bun's child_process resolves
 * the App Execution Alias stubs under `WindowsApps`; `py`/`python` there either
 * report "no runtime installed" or start the Store installer and never close.
 * Strip that directory from the child PATH so the real Python installation is
 * used. Node is unaffected and keeps the user's PATH unchanged.
 */
export function childEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  bun: boolean = typeof (globalThis as { Bun?: unknown }).Bun === "object",
): NodeJS.ProcessEnv {
  if (platform !== "win32" || !bun) return env;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  if (!pathKey) return env;
  const filtered = String(env[pathKey] ?? "")
    .split(";")
    .filter((entry) => entry.trim() && !/\\WindowsApps(?:\\|$)/i.test(entry.trim()))
    .join(";");
  if (filtered === env[pathKey]) return env;
  return { ...env, [pathKey]: filtered, PATH: filtered };
}

export function spawnBounded(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string;
}): Promise<RunResult> {
  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(result);
    };

    let child;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: childEnvironment(options.env),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolveRun({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // A Windows App Execution Alias (or a wrapper process) can keep the
      // stdio pipes open after the direct child is killed, so `close` may
      // never fire. Resolve on the timeout instead of hanging the caller.
      finish({ code: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        code: null,
        stdout,
        stderr,
        timedOut,
        spawnError: error.message,
      });
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish({ code: null, stdout, stderr, timedOut: true });
        return;
      }
      finish({ code, stdout, stderr, timedOut: false });
    });
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin, "utf8");
    } else {
      child.stdin?.end();
    }
  });
}

/** Find the first interpreter that runs real Python and prints the marker. */
export async function discoverInterpreter(
  options: { timeoutMs?: number } = {},
): Promise<string[] | null> {
  if (cachedInterpreter !== undefined) return cachedInterpreter;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (const candidate of CANDIDATES) {
    const result = await spawnBounded({
      command: candidate.command,
      args: [
        ...candidate.prefix,
        "-I",
        "-B",
        "-X",
        "utf8",
        "-c",
        `print(${JSON.stringify(MARKER)})`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs,
    });
    if (
      !result.timedOut &&
      !result.spawnError &&
      result.code === 0 &&
      result.stdout.trim() === MARKER
    ) {
      cachedInterpreter = [candidate.command, ...candidate.prefix];
      return cachedInterpreter;
    }
  }
  cachedInterpreter = null;
  return null;
}

export function resetInterpreterCache(): void {
  cachedInterpreter = undefined;
}

/** Run a Python file with an explicit argv array (never a shell string). */
export async function runPythonFile(options: {
  interpreter: readonly string[];
  script: string;
  argv?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
  /**
   * The guard keeps `-s` (no user site-packages). The CLI wrappers need the
   * selected interpreter's legitimate dependencies, including user site, so
   * they opt out of `-s`; `-E` still ignores ambient PYTHON* variables.
   */
  allowUserSite?: boolean;
}): Promise<RunResult> {
  const [command, ...prefix] = options.interpreter;
  if (!command) throw new Error("empty interpreter");
  return spawnBounded({
    command,
    args: [
      ...prefix,
      "-B",
      // `-I` also removes the script directory from sys.path, which breaks the
      // CLI wrappers' sibling imports (`file_lock`, `verification_cache`).
      // Keep the environment isolated with `-E` instead: Python ignores
      // PYTHON* variables while still adding the script's own directory.
      "-E",
      ...(options.allowUserSite ? [] : ["-s"]),
      "-X",
      "utf8",
      options.script,
      ...(options.argv ?? []),
    ],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stdin: options.stdin,
  });
}

/**
 * Check a required import under the same flags the CLI will use, before the
 * real command runs. Returns the diagnostic on failure, undefined on success.
 */
export async function checkPythonModule(options: {
  interpreter: readonly string[];
  module: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowUserSite?: boolean;
}): Promise<string | undefined> {
  const [command, ...prefix] = options.interpreter;
  if (!command) return "empty interpreter";
  const result = await spawnBounded({
    command,
    args: [
      ...prefix,
      "-B",
      "-E",
      ...(options.allowUserSite ? [] : ["-s"]),
      "-X",
      "utf8",
      "-c",
      `import ${options.module}`,
    ],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (result.timedOut) return `import ${options.module} timed out`;
  if (result.spawnError) {
    return `import ${options.module} failed to start: ${result.spawnError}`;
  }
  if (result.code !== 0) {
    return (
      (result.stderr || result.stdout).trim() ||
      `import ${options.module} failed`
    );
  }
  return undefined;
}

export function defaultTimeoutMs(): number {
  return DEFAULT_TIMEOUT_MS;
}
