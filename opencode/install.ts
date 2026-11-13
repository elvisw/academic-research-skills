#!/usr/bin/env node
/**
 * ARS OpenCode installation CLI — user-invoked only.
 *
 *   node install.ts install  --channel plugin|skills [--scope project|global] [--project DIR] [--models JSON|FILE] [--apply]
 *   node install.ts check    --channel plugin|skills [--scope project|global] [--project DIR] [--models JSON|FILE]
 *   node install.ts update   --channel plugin|skills [--scope project|global] [--project DIR] [--models JSON|FILE] [--apply] [--adopt-legacy]
 *   node install.ts uninstall --channel plugin|skills [--scope project|global] [--project DIR] [--apply]
 *
 * Every mutating action previews by default. Only `--apply` writes, and only
 * inside the selected scope. The plugin never runs this CLI at startup.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  formatInstallReport,
  InstallError,
  parseModelsArgument,
  runInstaller,
  type Channel,
  type InstallAction,
  type Scope,
} from "./src/install.ts";
import { defaultPackageRoot, isPackageRoot } from "./src/catalog.ts";

const ACTIONS: InstallAction[] = ["install", "check", "update", "uninstall"];
const CHANNELS: Channel[] = ["plugin", "skills"];
const SCOPES: Scope[] = ["project", "global"];

const USAGE = `ARS OpenCode installer

Usage:
  node install.ts <install|check|update|uninstall> --channel <plugin|skills> [options]

Options:
  --channel plugin|skills   Installation channel (required).
  --scope project|global    Installation scope. Defaults to the existing scope,
                            preferring an existing project configuration, else
                            project.
  --project <dir>           Project directory for project scope (default: cwd).
  --models <json|file>      Explicit model mappings for the plugin channel only,
                            for example:
                            {"aliases":{"sonnet":{"providerID":"p","model":"m"}}}
  --apply                   Write the previewed changes. Without it nothing is
                            written. The check action is always read-only.
  --adopt-legacy            Take ownership of a verified legacy template that
                            the previous adapter generated. Never required for
                            identical pre-existing assets.
  -h, --help                Show this help.

Channels are not interchangeable: the plugin channel supplies the five skills,
sixteen commands, four native agents, tools and guard at runtime; the skills
channel copies the five complete skill trees, installs the screening reviewer
and a managed instruction file, and installs no commands, hooks or tools.
`;

interface ParsedArgs {
  action: InstallAction;
  channel?: Channel;
  scope?: Scope;
  projectRoot: string;
  models?: string;
  apply: boolean;
  adoptLegacy: boolean;
  help: boolean;
}

function fail(message: string): never {
  throw new InstallError(message);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    action: "check",
    projectRoot: process.cwd(),
    apply: false,
    adoptLegacy: false,
    help: false,
  };
  let action: InstallAction | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] as string;
    if (raw === "-h" || raw === "--help") {
      args.help = true;
      continue;
    }
    if (!raw.startsWith("-")) {
      if (action !== undefined) fail(`unexpected argument ${JSON.stringify(raw)}`);
      if (!(ACTIONS as string[]).includes(raw)) {
        fail(`unknown action ${JSON.stringify(raw)}; expected one of ${ACTIONS.join(", ")}`);
      }
      action = raw as InstallAction;
      continue;
    }
    const equals = raw.indexOf("=");
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);
    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--") || next === "-h") {
        fail(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case "--channel": {
        const value = takeValue();
        if (!(CHANNELS as string[]).includes(value)) {
          fail(`--channel must be plugin or skills (got ${JSON.stringify(value)})`);
        }
        if (seen.has("channel")) fail("--channel may be given only once");
        seen.add("channel");
        args.channel = value as Channel;
        break;
      }
      case "--scope": {
        const value = takeValue();
        if (!(SCOPES as string[]).includes(value)) {
          fail(`--scope must be project or global (got ${JSON.stringify(value)})`);
        }
        if (seen.has("scope")) fail("--scope may be given only once");
        seen.add("scope");
        args.scope = value as Scope;
        break;
      }
      case "--project": {
        const value = takeValue();
        if (!value.trim()) fail("--project needs a directory");
        if (seen.has("project")) fail("--project may be given only once");
        seen.add("project");
        args.projectRoot = resolve(value);
        break;
      }
      case "--models": {
        const value = takeValue();
        if (seen.has("models")) fail("--models may be given only once");
        seen.add("models");
        args.models = value;
        break;
      }
      case "--apply":
        if (inline !== undefined) fail("--apply does not take a value");
        args.apply = true;
        break;
      case "--adopt-legacy":
        if (inline !== undefined) fail("--adopt-legacy does not take a value");
        args.adoptLegacy = true;
        break;
      default:
        fail(`unknown option ${JSON.stringify(flag)}`);
    }
  }
  if (args.help) return args;
  if (action === undefined) fail("no action given; expected install, check, update or uninstall");
  args.action = action;
  if (!args.channel) fail("--channel is required (plugin or skills)");
  if (args.action === "check" && args.apply) {
    fail("check is read-only and does not accept --apply");
  }
  return args;
}

async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    console.error("");
    console.error(USAGE);
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const packageRoot = defaultPackageRoot();
  if (!isPackageRoot(packageRoot)) {
    console.error(
      `ARS checkout not found at ${packageRoot}. Run this CLI from the opencode/ directory of a complete checkout.`,
    );
    return 2;
  }
  if (parsed.action !== "check" && !existsSync(parsed.projectRoot)) {
    console.error(`project directory ${parsed.projectRoot} does not exist`);
    return 2;
  }
  try {
    const report = await runInstaller({
      action: parsed.action,
      channel: parsed.channel as Channel,
      scope: parsed.scope,
      projectRoot: parsed.projectRoot,
      packageRoot,
      models: parseModelsArgument(parsed.models, process.cwd()),
      apply: parsed.apply,
      adoptLegacy: parsed.adoptLegacy,
    });
    console.log(formatInstallReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof InstallError) {
      console.error(`ARS installer: ${error.message}`);
      return 1;
    }
    console.error(`ARS installer failed: ${(error as Error).stack ?? (error as Error).message}`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
