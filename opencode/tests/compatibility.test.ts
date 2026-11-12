import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..", "node_modules", "@opencode", "plugin");

test("the adapter pins the tested @opencode/plugin version", () => {
  const manifest = JSON.parse(
    readFileSync(join(here, "..", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  assert.equal(manifest.dependencies["@opencode/plugin"], "2.2.7");

  const installedRoot = pluginRoot;
  const installed = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8"),
  ) as { version: string };
  assert.equal(installed.version, "2.2.7");
});

test("the plugin package exports a V2 setup definition", async () => {
  const mod = (await import("../index.ts")) as {
    default: { id: string; setup: unknown };
  };
  assert.equal(mod.default.id, "academic-research-skills.opencode");
  assert.equal(typeof mod.default.setup, "function");
});

test("the host contract still has the members the adapter wires", () => {
  const pluginTypes = readFileSync(
    join(pluginRoot, "dist", "promise", "index.d.ts"),
    "utf8",
  );
  assert.match(pluginTypes, /export \* as Plugin from "\.\/plugin\.js"/);

  const toolTypes = readFileSync(
    join(pluginRoot, "dist", "promise", "tool.d.ts"),
    "utf8",
  );
  assert.match(toolTypes, /readonly transform: Transform<ToolEditor>/);
  assert.match(toolTypes, /readonly hook: Hooks<ToolHooks>/);

  const commandTypes = readFileSync(
    join(pluginRoot, "dist", "promise", "command.d.ts"),
    "utf8",
  );
  assert.match(commandTypes, /add\(definition: CommandDefinition\): void/);
  assert.match(commandTypes, /readonly delivery: SessionInbox\.Delivery/);

  const skillTypes = readFileSync(
    join(pluginRoot, "dist", "promise", "skill.d.ts"),
    "utf8",
  );
  assert.match(skillTypes, /add\(skill: Skill\.Info\): void/);

  const permissionTypes = readFileSync(
    join(pluginRoot, "dist", "promise", "permission.d.ts"),
    "utf8",
  );
  assert.match(permissionTypes, /readonly hook: Hooks<PermissionHooks>/);
  assert.match(permissionTypes, /effect: Permission\.Effect/);

  const agentTypes = readFileSync(
    join(pluginRoot, "dist", "promise", "agent.d.ts"),
    "utf8",
  );
  // Native agents are configuration, not API: there is no add().
  assert.doesNotMatch(agentTypes, /\n\s*add\(/);
});

test("the source repo and adapter live in one trusted package root", () => {
  const repoRoot = resolve(here, "..", "..");
  assert.ok(existsSync(join(repoRoot, ".claude-plugin", "plugin.json")));
  assert.match(repoRoot, /academic-research-skills$/);
});
