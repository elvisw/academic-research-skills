import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const opencodeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(opencodeRoot, "..");
const cli = join(opencodeRoot, "install.ts");

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: opencodeRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("CLI help exits 0 and prints the usage and exit contract", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /Exit codes: 0 success, 1 refused or failed checks, 2 usage error/);
});

test("CLI usage errors exit 2", () => {
  for (const args of [
    [],
    ["install"],
    ["check", "--channel", "plugin", "--apply"],
    ["uninstall", "--channel", "plugin", "--models", "{}"],
    ["check", "--channel", "plugin", "--adopt-legacy"],
    ["install", "--channel", "plugin", "--unknown"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stderr}`);
  }
});

test("CLI refuses an unsupported --models key with exit 1", () => {
  const result = run(["check", "--channel", "plugin", "--models", '{"x":1}']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not accept "x"/);
});

test("CLI refuses installing into the ARS checkout with exit 1", () => {
  const result = run(["install", "--channel", "plugin", "--project", repoRoot]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /inside the ARS checkout/);
});
