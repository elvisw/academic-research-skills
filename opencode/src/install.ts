/**
 * ARS OpenCode installation operations.
 *
 * User-invoked only. Nothing in this module runs from plugin startup: the
 * plugin keeps registering in memory and never writes the user's configuration.
 *
 * Two channels mirror the original project:
 *
 * - `plugin`: register this adapter plus its four portable native agents. The
 *   plugin supplies the five skills, sixteen commands, tools and guard at
 *   runtime, so no skill copy is made.
 * - `skills`: copy the five complete skill directories into native OpenCode
 *   discovery, install the one screening reviewer that sr-screener needs, and
 *   write a scope-appropriate managed instruction file. No plugin entry,
 *   commands, hooks or adapter tools are installed.
 *
 * Both channels support project and user-global scope. Every mutation is
 * previewed first, requires `--apply`, edits JSONC with `jsonc-parser`, keeps
 * backups outside the project VCS, and uses digest-checked ownership so a
 * later user edit is never overwritten.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
} from "jsonc-parser";
import {
  defaultPackageRoot,
  isPackageRoot,
  loadCatalog,
  toPosix,
  type Catalog,
} from "./catalog.ts";
import {
  agentDifferences,
  equivalentText,
  legacyAgentSystem,
  loadNativeAgents,
  modelExists,
  type AdapterOptions,
  type InstallationCheck,
  type ModelRef,
  type NativeAgentSpec,
} from "./setup.ts";
import {
  agentFilePath,
  agentMarkdownDigest,
  agentMarkdownOwnershipDigest,
  renderAgentMarkdown,
} from "./agent-storage.ts";
import { discoverInterpreter } from "./script-runner.ts";

export const INSTALLER_ID = "ars-opencode";
export const MANIFEST_SCHEMA_VERSION = 1;

export type Channel = "plugin" | "skills";
export type Scope = "project" | "global";
export type InstallAction = "install" | "check" | "update" | "uninstall";

export const SKILLS_ONLY_AGENT = "screening-reviewer-agent";

/** Skills that `.claude-plugin/plugin.json` ships. */
const SKILL_DIRS = [
  "academic-paper",
  "academic-paper-reviewer",
  "academic-pipeline",
  "deep-research",
  "sr-screener",
] as const;

const IGNORED_NAMES = new Set([
  ".git",
  ".codegraph",
  ".pytest_cache",
  ".DS_Store",
  "__pycache__",
  "node_modules",
]);

const IGNORED_SUFFIXES = [".pyc", ".pyo"];

export interface InstallManifestEntry {
  digest: string;
  /**
   * Absolute Markdown agent file this record owns. Absent for the pre-Markdown
   * records, whose ownership is an inline `agents.<id>` configuration value.
   */
  path?: string;
  /** The user changed this asset after installation; never remove it. */
  retained?: boolean;
}

export interface InstallManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  installer: typeof INSTALLER_ID;
  channel: Channel;
  scope: Scope;
  packageRoot: string;
  /** `null` for a global installation: one global profile serves every project. */
  projectRoot: string | null;
  configPath: string;
  createdAt: string;
  updatedAt: string;
  pluginDigest?: string;
  /** The user edited the plugin entry after installation; never overwrite it. */
  pluginRetained?: boolean;
  agents: Record<string, InstallManifestEntry>;
  instructions?: {
    path: string;
    configValue: string;
    digest: string;
    /** False for a reused file when only its new config reference is owned. */
    fileOwned?: boolean;
    /** False when the user's config already referenced this file before install. */
    configReferenceAdded?: boolean;
    retained?: boolean;
  };
  skills: Record<string, InstallManifestEntry & { dir: string }>;
  /** Retained assets whose removal failed and should be retried. */
  pendingRemovals: string[];
}

export interface InstallRequest {
  action: InstallAction;
  channel: Channel;
  scope?: Scope;
  projectRoot: string;
  packageRoot?: string;
  models?: AdapterOptions["models"];
  screeningRoles?: Record<string, ModelRef>;
  apply?: boolean;
  adoptLegacy?: boolean;
  /** Explicit opt-in to install into the ARS checkout itself (adapter development). */
  allowCheckout?: boolean;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Test-only fault injection; never used by the CLI. */
  testHooks?: {
    failAt?: "config" | "instructions" | "manifest" | "skills" | "agents" | "removal";
    /** Stop after the agent-file writes without rolling them back. */
    crashAfter?: "agents" | "config";
  };
}

export type OperationKind =
  | "create"
  | "update"
  | "remove"
  | "keep"
  | "reuse"
  | "migrate"
  | "adopt"
  | "retain"
  | "backup"
  | "blocked";

export interface InstallOperation {
  kind: OperationKind;
  target: string;
  detail: string;
}

export interface InstallReport {
  action: InstallAction;
  channel: Channel;
  scope: Scope;
  packageRoot: string;
  projectRoot: string;
  configPath: string;
  skillsDir: string | null;
  agentsDir: string;
  instructionsPath: string | null;
  manifestPath: string;
  stateRoot: string;
  backupDir: string | null;
  operations: InstallOperation[];
  checks: InstallationCheck[];
  blockers: string[];
  warnings: string[];
  retained: string[];
  failed: string[];
  ok: boolean;
  applied: boolean;
  changed: boolean;
}

export interface ScopePaths {
  scope: Scope;
  packageRoot: string;
  projectRoot: string;
  configDir: string;
  configPath: string;
  existingConfigs: string[];
  skillsDir: string;
  agentsDir: string;
  instructionPath: string;
  instructionConfigValue: string;
  stateRoot: string;
  manifestPath: string;
  home: string;
}

export class InstallError extends Error {}

/**
 * Test-only process-death stand-in: it escapes `applyInstall` without running
 * rollback, reproducing a crash between the Markdown write and the config or
 * manifest write.
 */
class SimulatedCrash extends Error {}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable JSON with sorted object keys, used for ownership digests. */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, normalize(record[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

/** Ownership comparison; only line endings and trailing spaces in `system` differ. */
export function equivalentConfigValue(a: unknown, b: unknown): boolean {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(record)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [
            key,
            key === "system" && typeof value === "string"
              ? value.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim()
              : normalize(value),
          ]),
      );
    }
    return input;
  };
  return canonicalJson(normalize(a)) === canonicalJson(normalize(b));
}

export function digestValue(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function resolveHome(request: InstallRequest): string {
  const env = request.env ?? process.env;
  return (
    request.home ??
    env.HOME?.trim() ??
    env.USERPROFILE?.trim() ??
    homedir()
  );
}

export function stateRootFor(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.ARS_OPENCODE_STATE_DIR?.trim();
  return resolve(override || join(home, ".ars", "opencode-install"));
}

function globalConfigDir(home: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, ".config"), "opencode");
}

function configCandidates(scope: Scope, projectRoot: string, home: string, env: NodeJS.ProcessEnv): string[] {
  if (scope === "global") {
    const dir = globalConfigDir(home, env);
    return [join(dir, "opencode.json"), join(dir, "opencode.jsonc")];
  }
  return [
    join(projectRoot, "opencode.json"),
    join(projectRoot, "opencode.jsonc"),
    join(projectRoot, ".opencode", "opencode.json"),
    join(projectRoot, ".opencode", "opencode.jsonc"),
  ];
}

function defaultConfigPath(scope: Scope, projectRoot: string, home: string, env: NodeJS.ProcessEnv): string {
  return scope === "global"
    ? join(globalConfigDir(home, env), "opencode.json")
    : join(projectRoot, "opencode.json");
}

function skillsDirFor(scope: Scope, projectRoot: string, home: string, env: NodeJS.ProcessEnv): string {
  return scope === "global"
    ? join(globalConfigDir(home, env), "skills")
    : join(projectRoot, ".opencode", "skills");
}

/**
 * Native Markdown agents live beside the configuration: project scope uses the
 * project's `.opencode/agents`, global scope the XDG configuration directory.
 */
function agentsDirFor(scope: Scope, projectRoot: string, home: string, env: NodeJS.ProcessEnv): string {
  return scope === "global"
    ? join(globalConfigDir(home, env), "agents")
    : join(projectRoot, ".opencode", "agents");
}

function instructionFor(
  scope: Scope,
  projectRoot: string,
  home: string,
  env: NodeJS.ProcessEnv,
): { path: string; configValue: string } {
  if (scope === "global") {
    const path = join(globalConfigDir(home, env), "ars-instructions.md");
    return { path, configValue: toPosix(path) };
  }
  return {
    path: join(projectRoot, ".opencode", "ars-instructions.md"),
    configValue: ".opencode/ars-instructions.md",
  };
}

function manifestKey(request: InstallRequest, scope: Scope, projectRoot: string, packageRoot: string): string {
  const identity = scope === "global" ? "global" : `project:${pathIdentity(projectRoot)}`;
  return `manifest-${scope}-${request.channel}-${sha256(`${pathIdentity(packageRoot)}|${identity}`).slice(0, 16)}.json`;
}

function readManifestFile(path: string): InstallManifest | null {
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InstallError(
      `ownership manifest ${toPosix(path)} is unreadable (${(error as Error).message}); refusing to guess ownership`,
    );
  }
  const manifest = value as Partial<InstallManifest>;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    manifest.installer !== INSTALLER_ID ||
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !manifest.scope ||
    !manifest.channel ||
    !manifest.agents ||
    !manifest.skills
  ) {
    throw new InstallError(
      `ownership manifest ${toPosix(path)} has an unsupported schema; refusing to guess ownership`,
    );
  }
  return manifest as InstallManifest;
}

function scanManifests(stateRoot: string): {
  manifests: InstallManifest[];
  unreadable: string[];
} {
  if (!existsSync(stateRoot)) return { manifests: [], unreadable: [] };
  const found: InstallManifest[] = [];
  const unreadable: string[] = [];
  for (const file of readdirSync(stateRoot)) {
    if (!/^manifest-.*\.json$/.test(file)) continue;
    try {
      const manifest = readManifestFile(join(stateRoot, file));
      if (manifest) found.push(manifest);
    } catch (error) {
      unreadable.push(`${toPosix(join(stateRoot, file))}: ${(error as Error).message}`);
    }
  }
  return { manifests: found, unreadable };
}

export function resolveScope(request: InstallRequest, packageRoot: string): ScopePaths {
  const env = request.env ?? process.env;
  const home = resolveHome(request);
  const projectRoot = resolve(request.projectRoot);
  const stateRoot = stateRootFor(home, env);

  let scope = request.scope;
  if (!scope) {
    if (request.action === "update" || request.action === "uninstall") {
      const scan = scanManifests(stateRoot);
      if (scan.unreadable.length) {
        throw new InstallError(
          `ownership manifests could not be read: ${scan.unreadable.join("; ")}; ` +
            "refusing to infer a scope from incomplete records. Pass --scope explicitly or fix the listed files.",
        );
      }
      const matches = scan.manifests.filter(
        (manifest) =>
          manifest.installer === INSTALLER_ID &&
          manifest.channel === request.channel &&
          pathIdentity(manifest.packageRoot) === pathIdentity(packageRoot) &&
          (manifest.scope === "global" ||
            (manifest.projectRoot !== null &&
              pathIdentity(manifest.projectRoot) === pathIdentity(projectRoot))),
      );
      if (matches.length > 1) {
        throw new InstallError(
          `more than one ${request.channel} installation matches this checkout; pass --scope project|global explicitly`,
        );
      }
      const match = matches[0];
      if (match) scope = match.scope;
    }
    if (!scope) {
      const projectExists =
        configCandidates("project", projectRoot, home, env).some(existsSync);
      const globalExists =
        configCandidates("global", projectRoot, home, env).some(existsSync);
      scope = projectExists || !globalExists ? "project" : "global";
    }
  }

  const existingConfigs = configCandidates(scope, projectRoot, home, env).filter(existsSync);
  if (existingConfigs.length > 1) {
    throw new InstallError(
      `ambiguous ${scope} configuration: ${existingConfigs
        .map(toPosix)
        .join(", ")} all exist. Keep one file (${scope === "global" ? "global" : "project"} scope) and retry; nothing was changed.`,
    );
  }
  const configPath = existingConfigs[0] ?? defaultConfigPath(scope, projectRoot, home, env);
  const instruction = instructionFor(scope, projectRoot, home, env);
  return {
    scope,
    packageRoot: resolve(packageRoot),
    projectRoot,
    configDir: dirname(configPath),
    configPath,
    existingConfigs,
    skillsDir: skillsDirFor(scope, projectRoot, home, env),
    agentsDir: agentsDirFor(scope, projectRoot, home, env),
    instructionPath: instruction.path,
    instructionConfigValue: instruction.configValue,
    stateRoot,
    manifestPath: join(
      stateRoot,
      manifestKey(request, scope, projectRoot, packageRoot),
    ),
    home,
  };
}

function eolFor(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function jsonFormatting(text: string) {
  return {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: eolFor(text),
    },
  };
}

function parseConfig(text: string, path: string): Record<string, unknown> {
  const errors: { error: number; offset: number; length: number }[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0];
    const message = first ? printParseErrorCode(first.error) : "unknown parse error";
    throw new InstallError(
      `configuration ${toPosix(path)} is not valid JSONC (${message} at offset ${first?.offset ?? 0}); nothing was changed`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InstallError(
      `configuration ${toPosix(path)} is not a JSON object; nothing was changed`,
    );
  }
  return value as Record<string, unknown>;
}

function editConfig(
  text: string,
  path: (string | number)[],
  value: unknown,
): string {
  const edits = modify(text, path, value, jsonFormatting(text));
  return applyEdits(text, edits);
}

/**
 * Apply an edit and re-read the written text to prove the effective value is
 * the intended one. A duplicate property can make an edit succeed on a value
 * the host ignores; verifying the effect catches that without a syntax pass.
 */
function editConfigChecked(
  text: string,
  configPath: string,
  path: (string | number)[],
  value: unknown,
  verify: { path: (string | number)[]; value: unknown } = { path, value },
): string {
  const next = editConfig(text, path, value);
  let effective: unknown;
  try {
    effective = getPath(parseConfig(next, configPath), verify.path);
  } catch {
    throw new InstallError(
      `editing ${toPosix(configPath)} produced text that no longer parses; nothing was changed`,
    );
  }
  if (canonicalJson(effective) !== canonicalJson(verify.value)) {
    throw new InstallError(
      `editing ${toPosix(configPath)} did not produce the intended effective value at ` +
        `${verify.path.join(".")}; the file may declare the same property more than once. ` +
        "Remove the ambiguity and retry; nothing was changed.",
    );
  }
  return next;
}

function readConfigText(path: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  // A BOM is not JSONC. Windows editors still emit one; strip it so the
  // snapshot and every edit operate on the same text.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function assertSnapshot(path: string, expected: string | null): void {
  if (readConfigText(path) !== expected) {
    throw new InstallError(`asset ${toPosix(path)} changed since planning; rerun the preview instead of overwriting it`);
  }
}

const NEW_CONFIG = `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`;

function getPath(value: unknown, path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = typeof key === "number" ? key : Number(key);
      current = current[index];
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[String(key)];
    } else {
      return undefined;
    }
  }
  return current;
}

function samePath(a: string, b: string): boolean {
  const left = toPosix(resolve(a));
  const right = toPosix(resolve(b));
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Identity for ownership filenames. On a case-insensitive Windows volume the
 * same directory must not mint two manifests depending on how it was typed.
 */
function pathIdentity(path: string): string {
  const absolute = toPosix(resolve(path)).replace(/\/+$/, "") || "/";
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function skillFiles(root: string, installed = false): { rel: string; digest: string }[] {
  const files: { rel: string; digest: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (!installed && IGNORED_NAMES.has(entry.name)) continue;
      if (!installed && IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      const absolute = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolute, rel);
      } else if (entry.isFile()) {
        files.push({ rel, digest: sha256(readFileSync(absolute)) });
      } else if (entry.isSymbolicLink()) {
        if (!installed) {
          throw new InstallError(
            `source skill tree contains a symbolic link at ${toPosix(absolute)}; ` +
              "refusing to install a silently incomplete tree",
          );
        }
        files.push({ rel, digest: sha256(`link\0${readlinkSync(absolute)}`) });
      }
    }
  };
  walk(root, "");
  return files;
}

/** A complete skill tree digest, so updates are directory units, not files. */
export function skillTreeDigest(root: string): string {
  if (lstatSync(root).isSymbolicLink()) return sha256(`root-link\0${readlinkSync(root)}`);
  // Exclusions are packaging rules, not permission to discard later user data.
  const files = skillFiles(root, true);
  return sha256(files.map((file) => `${file.rel}\0${file.digest}`).join("\n"));
}

interface SkillSource {
  name: string;
  dir: string;
  files: { rel: string; digest: string }[];
  digest: string;
}

function loadSkillSources(packageRoot: string): SkillSource[] {
  return SKILL_DIRS.map((name) => {
    const dir = join(packageRoot, name);
    if (!existsSync(join(dir, "SKILL.md"))) {
      throw new InstallError(
        `skill source ${toPosix(dir)} is missing SKILL.md; nothing was changed`,
      );
    }
    const files = skillFiles(dir);
    return {
      name,
      dir,
      files,
      digest: sha256(files.map((file) => `${file.rel}\0${file.digest}`).join("\n")),
    };
  });
}

function copySkillTree(source: SkillSource, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const file of source.files) {
    const destination = join(target, ...file.rel.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(source.dir, ...file.rel.split("/")), destination);
  }
}

export interface ParsedModels {
  models?: AdapterOptions["models"];
  screeningRoles?: Record<string, ModelRef>;
}

export function parseModelsArgument(
  raw: string | undefined,
  cwd: string,
): ParsedModels | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) throw new InstallError("--models needs a JSON value or a file path");
  let parsed: unknown;
  if (trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Never echo the payload: operators may paste a credential by mistake.
      throw new InstallError("--models is not valid JSON; pass an object or a file path");
    }
  } else {
    const path = resolve(cwd, trimmed);
    if (!existsSync(path)) {
      throw new InstallError(`--models file ${toPosix(path)} does not exist`);
    }
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new InstallError(
        `--models file ${toPosix(path)} is not valid JSON; correct the file and retry`,
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InstallError(
      "--models must be an object with optional `agents`, `aliases` and `screening`",
    );
  }
  const allowed = new Set(["agents", "aliases", "screening"]);
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      throw new InstallError(
        `--models does not accept ${JSON.stringify(key)}; use agents, aliases or screening`,
      );
    }
  }
  const checkRefs = (value: unknown, label: string): Record<string, ModelRef> => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new InstallError(`--models.${label} must be an object`);
    }
    const refs: Record<string, ModelRef> = {};
    for (const [name, ref] of Object.entries(value as Record<string, unknown>)) {
      if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
        throw new InstallError(`--models.${label}.${name} must be a model reference`);
      }
      const record = ref as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!["providerID", "model", "variant"].includes(key)) {
          throw new InstallError(
            `--models.${label}.${name} has unsupported field ${JSON.stringify(key)}; ` +
              "model references carry only providerID, model and optional variant, never credentials",
          );
        }
      }
      const providerID = record.providerID;
      const model = record.model;
      const variant = record.variant;
      if (typeof providerID !== "string" || !providerID.trim()) {
        throw new InstallError(`--models.${label}.${name}.providerID must be a non-empty string`);
      }
      if (typeof model !== "string" || !model.trim()) {
        throw new InstallError(`--models.${label}.${name}.model must be a non-empty string`);
      }
      if (variant !== undefined && (typeof variant !== "string" || !variant.trim())) {
        throw new InstallError(`--models.${label}.${name}.variant must be a non-empty string`);
      }
      refs[name] = {
        providerID: providerID.trim(),
        model: model.trim(),
        ...(variant ? { variant: variant.trim() } : {}),
      };
    }
    return refs;
  };
  const record = parsed as Record<string, unknown>;
  const models: AdapterOptions["models"] = {};
  if (record.agents !== undefined) models.agents = checkRefs(record.agents, "agents");
  if (record.aliases !== undefined) models.aliases = checkRefs(record.aliases, "aliases");
  let screeningRoles: Record<string, ModelRef> | undefined;
  if (record.screening !== undefined) {
    const screening = record.screening;
    if (!screening || typeof screening !== "object" || Array.isArray(screening)) {
      throw new InstallError("--models.screening must be an object with a `roles` member");
    }
    for (const key of Object.keys(screening)) {
      if (key !== "roles") {
        throw new InstallError(
          `--models.screening does not accept ${JSON.stringify(key)}; use roles`,
        );
      }
    }
    const roles = (screening as Record<string, unknown>).roles;
    if (roles !== undefined) {
      const parsedRoles = checkRefs(roles, "screening.roles");
      if (Object.keys(parsedRoles).length) screeningRoles = parsedRoles;
    }
  }
  return {
    ...(Object.keys(models).length ? { models } : {}),
    ...(screeningRoles ? { screeningRoles } : {}),
  };
}

function pluginPackagePath(packageRoot: string): string {
  const local = join(packageRoot, "opencode");
  return isAbsolute(local) ? resolve(local) : local;
}

function agentConfigValue(agent: NativeAgentSpec): Record<string, unknown> {
  return {
    description: agent.description,
    mode: agent.mode,
    system: agent.system,
    ...(agent.model
      ? {
          model: {
            providerID: agent.model.providerID,
            model: agent.model.model,
            ...(agent.model.variant ? { variant: agent.model.variant } : {}),
          },
        }
      : {}),
    permissions: agent.permissions,
  };
}

/**
 * A legacy entry is verifiable only as a complete template: description, mode,
 * portable-to-legacy system text, permissions and model must all match. A
 * matching system alone must never authorize replacing the user's rules.
 */
function isVerifiedLegacyAgent(
  current: unknown,
  agent: NativeAgentSpec,
  packageRoot: string,
  projectRoot: string,
): boolean {
  if (!current || typeof current !== "object" || Array.isArray(current)) return false;
  const legacyValue = {
    ...agentConfigValue(agent),
    system: legacyAgentSystem(packageRoot, projectRoot, agent.system),
  };
  return equivalentConfigValue(current, legacyValue);
}

function pluginConfigValue(
  packagePath: string,
  packageRoot: string,
  models: AdapterOptions["models"] | undefined,
  persistedOptions: Record<string, unknown> = {},
  screeningRoles?: Record<string, ModelRef>,
  persistedScreening?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    package: toPosix(packagePath),
    options: {
      ...persistedOptions,
      ...(screeningRoles
        ? { screening: { ...(persistedScreening ?? {}), roles: screeningRoles } }
        : {}),
      repoRoot: toPosix(packageRoot),
      ...(models && Object.keys(models).length ? { models } : {}),
    },
  };
}

function pluginOptionsFromEntry(entry: unknown): Record<string, unknown> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
  const options = (entry as Record<string, unknown>).options;
  if (!options || typeof options !== "object" || Array.isArray(options)) return {};
  return { ...(options as Record<string, unknown>) };
}

function readModelRefs(value: unknown): Record<string, ModelRef> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, ModelRef> = {};
  for (const [name, ref] of Object.entries(value as Record<string, unknown>)) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
    const item = ref as Record<string, unknown>;
    if (typeof item.providerID !== "string" || typeof item.model !== "string") continue;
    output[name] = {
      providerID: item.providerID,
      model: item.model,
      ...(typeof item.variant === "string" ? { variant: item.variant } : {}),
    };
  }
  return Object.keys(output).length ? output : undefined;
}

/** Persisted plugin options are the default when --models is not repeated. */
function modelsFromPluginEntry(entry: unknown): AdapterOptions["models"] | undefined {
  const value = pluginOptionsFromEntry(entry).models;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const agents = readModelRefs(record.agents);
  const aliases = readModelRefs(record.aliases);
  return agents || aliases ? { ...(agents ? { agents } : {}), ...(aliases ? { aliases } : {}) } : undefined;
}

function screeningRolesFromPluginEntry(
  entry: unknown,
): Record<string, ModelRef> | undefined {
  const screening = pluginOptionsFromEntry(entry).screening;
  if (!screening || typeof screening !== "object" || Array.isArray(screening)) return undefined;
  return readModelRefs((screening as Record<string, unknown>).roles);
}

function mergeScreeningRoles(
  persisted: Record<string, ModelRef> | undefined,
  explicit: Record<string, ModelRef> | undefined,
): Record<string, ModelRef> | undefined {
  if (!persisted && !explicit) return undefined;
  const merged = { ...(persisted ?? {}), ...(explicit ?? {}) };
  return Object.keys(merged).length ? merged : undefined;
}

/**
 * Explicit --models wins per entry; mappings already persisted for this
 * checkout survive so an update never silently drops configured models.
 */
function mergeModels(
  persisted: AdapterOptions["models"] | undefined,
  explicit: AdapterOptions["models"] | undefined,
): AdapterOptions["models"] | undefined {
  if (!persisted && !explicit) return undefined;
  const merged: AdapterOptions["models"] = {
    ...(persisted?.agents || explicit?.agents
      ? { agents: { ...(persisted?.agents ?? {}), ...(explicit?.agents ?? {}) } }
      : {}),
    ...(persisted?.aliases || explicit?.aliases
      ? { aliases: { ...(persisted?.aliases ?? {}), ...(explicit?.aliases ?? {}) } }
      : {}),
  };
  return Object.keys(merged).length ? merged : undefined;
}

function pluginEntryPackage(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const value = (entry as Record<string, unknown>).package;
    if (typeof value === "string") return value;
  }
  return undefined;
}

function resolvePluginPackage(entry: string, projectRoot: string): string {
  return isAbsolute(entry) ? resolve(entry) : resolve(projectRoot, entry);
}

function findPluginIndex(
  plugins: unknown,
  packagePath: string,
  projectRoot: string,
): { index: number; value: unknown } | undefined {
  if (!Array.isArray(plugins)) return undefined;
  for (let index = 0; index < plugins.length; index += 1) {
    const entry = plugins[index];
    const declared = pluginEntryPackage(entry);
    if (declared === undefined) continue;
    if (samePath(resolvePluginPackage(declared, projectRoot), packagePath)) {
      return { index, value: entry };
    }
  }
  return undefined;
}

function isVerifiedLegacyPlugin(value: unknown, packageRoot: string): boolean {
  // findPluginIndex already matched the package path; a bare string is the
  // documented manual route. An object is legacy only when it names this exact
  // checkout in its repoRoot option.
  if (typeof value === "string") return true;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const options = (value as Record<string, unknown>).options;
    if (options && typeof options === "object" && !Array.isArray(options)) {
      const repoRoot = (options as Record<string, unknown>).repoRoot;
      return typeof repoRoot === "string" && samePath(repoRoot, packageRoot);
    }
  }
  return false;
}

function findInstructionIndex(
  instructions: unknown,
  configValue: string,
  workspaceRoot: string,
  home: string,
): number {
  if (!Array.isArray(instructions)) return -1;
  const instructionPath = (entry: string): string =>
    /^~[\\/]/.test(entry) ? resolve(home, entry.slice(2)) : resolve(workspaceRoot, entry);
  const target = instructionPath(configValue);
  return instructions.findIndex(
    (entry) =>
      typeof entry === "string" &&
      samePath(
        instructionPath(entry),
        target,
      ),
  );
}

function routingCoreBlock(packageRoot: string): string {
  const path = join(packageRoot, "shared", "references", "routing_core.md");
  if (!existsSync(path)) {
    throw new InstallError(
      `canonical routing core ${toPosix(path)} is missing; the project skills channel cannot install its routing guidance`,
    );
  }
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const begin = "<!-- routing-core:begin -->";
  const end = "<!-- routing-core:end -->";
  const start = text.indexOf(begin);
  const finish = text.indexOf(end);
  if (start === -1 || finish === -1 || finish < start) {
    throw new InstallError(
      `canonical routing core ${toPosix(path)} has no marked block; refusing to invent routing guidance`,
    );
  }
  return text.slice(start, finish + end.length);
}

function projectionInstructions(scope: Scope, checkout: string, skillsDir: string): string {
  const root = toPosix(checkout);
  if (scope === "global") {
    return `# Academic Research Skills — global compatibility (managed)

This file is managed by the ARS OpenCode installer. It records how the
skills-only installation relates to this host.

- The five ARS skills are installed under \`${toPosix(skillsDir)}\` and load
  through OpenCode's native global skill discovery.
- The retained ARS checkout is \`${root}\`. Resolve \`shared/\`, \`scripts/\` and
  other repository-relative resources from that checkout; it is a read-only
  input. This is a machine-local path, not a substitute for cloning the
  checkout on another machine.
- This is a skills-only installation. It does not register the \`/ars-*\`
  commands, plugin tools, hooks or the write-scope guard, and it does not add
  plugin startup routing. In a project that needs those, install the plugin
  channel at project scope.
- \`sr-screener\` uses the installed \`screening-reviewer-agent\` native
  subagent. It has the source Read/Grep boundary and no write or shell access.
`;
  }
  return `# Academic Research Skills — project routing (managed)

This file is managed by the ARS OpenCode installer. It carries the project
skills installation's canonical routing discipline; it never replaces the
source skills.

## Routing core (verbatim from \`shared/references/routing_core.md\`)

${routingCoreBlock(checkout)}

## This installation

- The five ARS skills are installed under \`${toPosix(skillsDir)}\` in this
  project and load through OpenCode's native project skill discovery.
- The retained ARS checkout is \`${root}\`. Resolve \`shared/\`, \`scripts/\` and
  other repository-relative resources from that checkout; package files are
  read-only inputs. Phase artifacts belong under this project.
- Follow the canonical routing core above, then that skill's own workflow. Do
  not invent a second loader or copy skill bodies into the project.
- This is a skills-only installation. It does not register the \`/ars-*\`
  commands, plugin tools, hooks or the write-scope guard. Do not claim those
  capabilities; conditional root-backed Python features need the retained
  checkout and its dependencies.
- \`sr-screener\` uses the installed \`screening-reviewer-agent\` native
  subagent. It has the source Read/Grep boundary and no write or shell access.
  The Claude Workflow tool is not available here; use the Agent-tool or
  single-session path the skill documents.
`;
}

interface NativeSkillCandidate {
  name: string;
  path: string;
  source: "claude" | "agents" | "opencode" | "config";
  scope: "project" | "global";
  label: string;
}

/** The host scans at most six directory levels below a skill source root. */
const MAX_SKILL_SCAN_DEPTH = 6;

function ancestorRoots(projectRoot: string): string[] {
  const roots = [resolve(projectRoot)];
  let current = resolve(projectRoot);
  let gitRoot = existsSync(join(current, ".git")) ? current : undefined;
  while (!gitRoot) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    if (existsSync(join(current, ".git"))) gitRoot = current;
  }
  if (!gitRoot || resolve(gitRoot) === resolve(projectRoot)) return roots;
  const extra: string[] = [];
  let cursor = dirname(resolve(projectRoot));
  const stop = resolve(gitRoot);
  while (cursor.startsWith(stop)) {
    extra.unshift(cursor);
    if (cursor === stop) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return [...extra, ...roots];
}

/**
 * Metadata-only scan of one native skill root. Mirrors the documented shapes:
 * root Markdown files and grouped `<group>/<skill>/SKILL.md`, hidden entries and
 * `node_modules` excluded, and no descent beneath a skill directory. It is not
 * a loader: the host alone decides what runs.
 */
function scanSkillRoot(
  root: string,
  source: NativeSkillCandidate["source"],
  scope: NativeSkillCandidate["scope"],
  label: string,
  found: NativeSkillCandidate[],
): void {
  if (!existsSync(root)) return;
  const visit = (dir: string, level: number): void => {
    if (level > MAX_SKILL_SCAN_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (existsSync(join(path, "SKILL.md"))) {
          found.push({ name: entry.name, path, source, scope, label });
          continue;
        }
        visit(path, level + 1);
      } else if (entry.isFile() && level === 0 && entry.name.endsWith(".md")) {
        found.push({
          name: basename(entry.name, ".md"),
          path,
          source,
          scope,
          label,
        });
      }
    }
  };
  visit(root, 0);
}

type ConfiguredSkillSource = { path: string; label: string; url: string | null };

function systemConfigDirs(env: NodeJS.ProcessEnv): string[] {
  if (process.platform === "win32") {
    const programData = env.ProgramData?.trim();
    return programData ? [join(programData, "opencode")] : [];
  }
  if (process.platform === "darwin") {
    return ["/Library/Application Support/opencode"];
  }
  return ["/etc/opencode"];
}

/**
 * Read `skills` entries in the host's config priority: global, project direct
 * configs farthest to closest, project `.opencode` configs in that order, then
 * system configuration. Relative entries resolve from the active working
 * directory (approximated by the project root), never from the config file.
 * URLs are reported, never fetched.
 */
function configuredSkillSources(
  projectRoot: string,
  home: string,
  env: NodeJS.ProcessEnv,
): ConfiguredSkillSource[] {
  const roots = ancestorRoots(projectRoot);
  const configFiles = [
    ...configCandidates("global", projectRoot, home, env),
    ...roots.flatMap((root) => [
      join(root, "opencode.json"),
      join(root, "opencode.jsonc"),
    ]),
    ...roots.flatMap((root) => [
      join(root, ".opencode", "opencode.json"),
      join(root, ".opencode", "opencode.jsonc"),
    ]),
    ...systemConfigDirs(env).flatMap((dir) =>
      configCandidates("global", projectRoot, home, env).map((file) =>
        join(dir, basename(file)),
      ),
    ),
  ];
  const sources: ConfiguredSkillSource[] = [];
  const seenFiles = new Set<string>();
  for (const file of configFiles) {
    const identity = pathIdentity(file);
    if (seenFiles.has(identity)) continue;
    seenFiles.add(identity);
    const text = readConfigText(file);
    if (text === null) continue;
    let value: unknown;
    try {
      value = parseConfig(text, file);
    } catch {
      // An unrelated invalid config is reported by check/install, not here.
      continue;
    }
    const skills = getPath(value, ["skills"]);
    if (!Array.isArray(skills)) continue;
    skills.forEach((entry, index) => {
      if (typeof entry !== "string" || !entry.trim()) return;
      const raw = entry.trim();
      const label = `${toPosix(file)} skills[${index}]`;
      if (/^https?:\/\//i.test(raw)) {
        sources.push({ path: "", label, url: raw });
        return;
      }
      const path = raw.startsWith("~/")
        ? join(home, raw.slice(2))
        : isAbsolute(raw)
          ? raw
          : resolve(projectRoot, raw);
      sources.push({ path, label, url: null });
    });
  }
  return sources;
}

function scanNativeSkillSources(
  projectRoot: string,
  home: string,
  env: NodeJS.ProcessEnv,
): NativeSkillCandidate[] {
  const found: NativeSkillCandidate[] = [];
  scanSkillRoot(join(home, ".claude", "skills"), "claude", "global", "global .claude/skills", found);
  scanSkillRoot(join(home, ".agents", "skills"), "agents", "global", "global .agents/skills", found);
  const roots = ancestorRoots(projectRoot);
  roots.forEach((root) => {
    scanSkillRoot(join(root, ".claude", "skills"), "claude", "project", `project .claude/skills (${toPosix(root)})`, found);
    scanSkillRoot(join(root, ".agents", "skills"), "agents", "project", `project .agents/skills (${toPosix(root)})`, found);
    scanSkillRoot(join(root, ".opencode", "skills"), "opencode", "project", `project .opencode/skills (${toPosix(root)})`, found);
  });
  scanSkillRoot(join(globalConfigDir(home, env), "skills"), "opencode", "global", "global .config/opencode/skills", found);
  for (const dir of systemConfigDirs(env)) {
    scanSkillRoot(join(dir, "skills"), "opencode", "global", `system ${toPosix(join(dir, "skills"))}`, found);
  }
  configuredSkillSources(projectRoot, home, env).forEach((source) => {
    if (source.url !== null || !source.path) return;
    scanSkillRoot(source.path, "config", "project", source.label, found);
  });
  return found;
}

/**
 * Report every known native/compatible skill source for a managed ID. The
 * installer never edits those trees and does not predict which copy the host
 * will load; duplicate precedence is observed in the live skill inventory.
 */
function reportNativeSkillSources(options: {
  projectRoot: string;
  home: string;
  env: NodeJS.ProcessEnv;
  channel: Channel;
  ourSkillsDir: string;
  warnings: string[];
  operations: InstallOperation[];
}): void {
  const candidates = scanNativeSkillSources(
    options.projectRoot,
    options.home,
    options.env,
  ).filter((candidate) => SKILL_DIRS.includes(candidate.name as never));
  for (const candidate of candidates) {
    if (options.channel === "skills") {
      const ours = join(options.ourSkillsDir, candidate.name);
      if (samePath(candidate.path, ours)) continue;
    }
    options.warnings.push(
      `native skill source ${toPosix(candidate.path)} (${candidate.label}) also defines ` +
        `${candidate.name}; nothing in that tree is modified. This installer does not predict ` +
        "which copy the host loads; confirm in the live skill inventory before relying on one source.",
    );
    options.operations.push({
      kind: "keep",
      target: toPosix(candidate.path),
      detail: `native source (${candidate.label}) scanned, never modified`,
    });
  }
  for (const source of configuredSkillSources(options.projectRoot, options.home, options.env)) {
    if (source.url === null) continue;
    options.warnings.push(
      `configured skill source ${source.url} (${source.label}) is a URL; this installer does not fetch it, so its skills are not checked for shadowing.`,
    );
  }
}

function readPackageVersion(packageRoot: string): string | null {
  try {
    const value = JSON.parse(
      readFileSync(
        join(packageRoot, "opencode", "node_modules", "@opencode", "plugin", "package.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    return typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

interface ApplyState {
  configText: string;
  originalConfigText: string | null;
  originalManifestText: string | null;
  originalInstructionText: string | null;
  configDirty: boolean;
  instructionContent: string | null;
  instructionWrite: boolean;
  instructionDelete: boolean;
  instructionReferenceAdded: boolean;
  skillWrites: { name: string; source: SkillSource; target: string; expectedDigest: string | null }[];
  skillRemoves: { name: string; target: string; expectedDigest: string }[];
  agentWrites: { id: string; target: string; content: string; before: string | null }[];
  agentRemoves: { id: string; target: string; expectedDigest: string }[];
  manifest: InstallManifest | null;
  manifestWrite: boolean;
  manifestDelete: boolean;
  backupDir?: string;
  backupTargets: string[];
  operations: InstallOperation[];
  blockers: string[];
  warnings: string[];
  retained: string[];
}

function nowIso(request: InstallRequest): string {
  return (request.now ?? new Date()).toISOString();
}

function pushCheck(
  checks: InstallationCheck[],
  id: string,
  status: InstallationCheck["status"],
  detail: string,
): void {
  checks.push({ id, status, detail });
}

/**
 * Everything the channel planners share after the scope, catalog, manifest and
 * source inspection are resolved. Planners mutate only `state` and `nextAgents`.
 */
interface InstallPlan {
  request: InstallRequest;
  paths: ScopePaths;
  packageRoot: string;
  projectRoot: string;
  manifest: InstallManifest | null;
  currentConfig: Record<string, unknown>;
  existingPlugin: { index: number; value: unknown } | undefined;
  persistedPluginOptions: Record<string, unknown>;
  models: AdapterOptions["models"] | undefined;
  screeningRoles: Record<string, ModelRef> | undefined;
  persistedScreening: Record<string, unknown> | undefined;
  desiredAgents: NativeAgentSpec[];
  skillSources: SkillSource[];
  state: ApplyState;
  nextAgents: Record<string, InstallManifestEntry>;
}

/** Inline agent IDs in the other scope, so a cross-scope shadow is never written. */
function foreignScopeInlineAgents(
  paths: ScopePaths,
  request: InstallRequest,
): Map<string, string> {
  const other = paths.scope === "project" ? "global" : "project";
  const found = new Map<string, string>();
  for (const candidate of configCandidates(other, paths.projectRoot, paths.home, request.env ?? process.env)) {
    if (!existsSync(candidate)) continue;
    try {
      const agentsNode = getPath(parseConfig(readFileSync(candidate, "utf8"), candidate), ["agents"]);
      if (!agentsNode || typeof agentsNode !== "object" || Array.isArray(agentsNode)) continue;
      for (const id of Object.keys(agentsNode)) found.set(id, candidate);
    } catch {
      // Another scope's malformed configuration is not this install's to fix.
    }
  }
  return found;
}

/** The other channel's manifest in the same scope, if it exists. */
function otherChannelManifest(
  paths: ScopePaths,
  request: InstallRequest,
  packageRoot: string,
): { path: string; manifest: InstallManifest } | null {
  const channel: Channel = request.channel === "plugin" ? "skills" : "plugin";
  const path = join(
    paths.stateRoot,
    manifestKey({ ...request, channel }, paths.scope, paths.projectRoot, packageRoot),
  );
  if (!existsSync(path)) return null;
  return { path, manifest: readManifestFile(path)! };
}

function otherChannelReviewerBlocker(
  paths: ScopePaths,
  request: InstallRequest,
  packageRoot: string,
): string | null {
  try {
    const other = otherChannelManifest(paths, request, packageRoot);
    const entry = other?.manifest.agents[SKILLS_ONLY_AGENT];
    // A retained entry is no longer an active ownership claim: the file itself
    // still decides whether the other channel's definition can be reused, so a
    // stale retained record cannot deadlock both channels.
    if (!other || !entry || entry.retained) return null;
    return (
      `${request.channel} install/update is blocked: the ${other.manifest.channel} channel ` +
      `already owns ${SKILLS_ONLY_AGENT} in this scope (${toPosix(other.path)}). ` +
      `The shared file is ${entry.path ? toPosix(entry.path) : `agents.${SKILLS_ONLY_AGENT}`}. ` +
      "Uninstall the other channel first, or keep one channel per scope."
    );
  } catch (error) {
    return `the other channel's ownership manifest could not be read: ${(error as Error).message}`;
  }
}

function planAgentEntries(plan: InstallPlan): void {
  const { paths, manifest, desiredAgents, state } = plan;
  const agentsNode = getPath(plan.currentConfig, ["agents"]);
  const currentAgents =
    agentsNode && typeof agentsNode === "object" && !Array.isArray(agentsNode)
      ? (agentsNode as Record<string, unknown>)
      : {};
  const foreignInline = foreignScopeInlineAgents(paths, plan.request);

  for (const agent of desiredAgents) {
    const target = agentFilePath(paths.agentsDir, agent.id);
    const content = renderAgentMarkdown(agent);
    const desiredDigest = agentMarkdownDigest(content);
    const current = currentAgents[agent.id];
    const owned = manifest?.agents[agent.id];
    const fileText = existsSync(target) ? readFileSync(target, "utf8") : null;
    const fileIsSymlink = fileText !== null && lstatSync(target).isSymbolicLink();
    const foreignPath = foreignInline.get(agent.id);

    if (foreignPath) {
      state.blockers.push(
        `agent ${agent.id} is already defined inline as agents.${agent.id} in ` +
          `${toPosix(foreignPath)} (${paths.scope === "project" ? "global" : "project"} scope), ` +
          `while this ${paths.scope} install would use the Markdown file ${toPosix(target)}. ` +
          "Keep one form across scopes; nothing was written for this agent",
      );
      state.operations.push({
        kind: "blocked",
        target: toPosix(target),
        detail: `also defined inline in ${toPosix(foreignPath)}`,
      });
      continue;
    }

    // The crash shape is exactly file + inline + pathless, which the generic
    // dual-form branch would misread as two owned definitions. Classify before
    // it so an interrupted migration can finish and a manual case still names
    // one action.
    const recovery = classifyPathlessFileRecovery(
      owned,
      current,
      fileText,
      fileIsSymlink,
      content,
      agentConfigValue(agent),
    );
    if (recovery.kind === "recover") {
      planPathlessFileRecovery(plan, agent, {
        target,
        content,
        desiredDigest,
        fileText,
        removeInline: recovery.removeInline,
        canonicalize: recovery.canonicalize,
      });
      continue;
    }
    if (recovery.kind === "manual") {
      state.blockers.push(pathlessManualMessage(agent.id, paths, target, recovery.reason));
      state.operations.push({
        kind: "blocked",
        target: toPosix(target),
        detail: "interrupted migration requires a manual decision",
      });
      continue;
    }

    if (current !== undefined && fileText !== null) {
      // One agent, two definitions: the host would have to choose, and this
      // installer would then own a form the host may ignore.
      state.blockers.push(
        `agent ${agent.id} exists twice: Markdown file ${toPosix(target)} and inline ` +
          `agents.${agent.id} in ${toPosix(paths.configPath)}. Keep exactly one form; ` +
          "nothing was written for this agent",
      );
      state.operations.push({
        kind: "blocked",
        target: toPosix(target),
        detail: `also present as agents.${agent.id} in ${toPosix(paths.configPath)}`,
      });
      continue;
    }

    if (current !== undefined) {
      planInlineAgent(plan, agent, current, owned);
      continue;
    }

    planMarkdownAgent(plan, agent, {
      target,
      content,
      desiredDigest,
      owned,
      fileText,
    });
  }
}

/**
 * The pre-Markdown ownership branch: an inline `agents.<id>` entry already
 * exists. Story 1.2 migrates those records to files; until then this branch
 * keeps them correct and never writes a second form for the same agent.
 */
function planInlineAgent(
  plan: InstallPlan,
  agent: NativeAgentSpec,
  current: unknown,
  owned: InstallManifestEntry | undefined,
): void {
  const { request, paths, packageRoot, projectRoot, state } = plan;
  const desiredValue = agentConfigValue(agent);
  const desiredDigest = digestValue(desiredValue);
  const markdown = renderAgentMarkdown(agent);
  const markdownDigest = agentMarkdownDigest(markdown);
  const target = agentFilePath(paths.agentsDir, agent.id);
  if (owned?.retained) {
    // A previously retained user edit keeps its record on every retry; it is
    // not reclassified as an unowned collision. A pathless record uses the
    // same text as `check` so the two commands name one manual action.
    state.blockers.push(
      !owned.path
        ? pathlessManualMessage(agent.id, paths, target, "retained")
        : `agents.${agent.id} is a user-modified legacy inline entry; the whole migration ` +
            "is stopped before any write. Restore the original inline value, or remove " +
            `agents.${agent.id} from ${toPosix(paths.configPath)} and its ownership record from ` +
            `${toPosix(paths.manifestPath)}; uninstall retains user-modified entries`,
    );
    return;
  }
  if (owned) {
    if (digestValue(current) !== owned.digest && !equivalentConfigValue(current, desiredValue)) {
      state.blockers.push(
        `agents.${agent.id} changed after installation; the whole migration is stopped ` +
          "before any write. Restore the original inline value, or remove " +
          `agents.${agent.id} from ${toPosix(paths.configPath)} and its ownership record from ` +
          `${toPosix(paths.manifestPath)}; uninstall retains user-modified entries. ` +
          "No Markdown file was written for any agent",
      );
      state.operations.push({
        kind: "blocked",
        target: `agents.${agent.id}`,
        detail: "user-modified legacy inline entry; migration refused",
      });
      return;
    }
    // Write the Markdown file first; config removal is applied after it.
    state.agentWrites.push({ id: agent.id, target, content: markdown, before: null });
    plan.nextAgents[agent.id] = { path: target, digest: markdownDigest };
    state.configText = editConfigChecked(
      state.configText,
      paths.configPath,
      ["agents", agent.id],
      undefined,
    );
    state.configDirty = true;
    state.operations.push({
      kind: "migrate",
      target: `agents.${agent.id}`,
      detail: `migrated to ${toPosix(target)}`,
    });
    return;
  }
  if (equivalentConfigValue(current, desiredValue)) {
    state.warnings.push(
      `agents.${agent.id} already exists inline with an identical definition; it is reused ` +
        "without ownership and is not migrated, so the inline value remains in the configuration",
    );
    state.operations.push({
      kind: "reuse",
      target: `agents.${agent.id}`,
      detail: "identical pre-existing entry reused without claiming ownership",
    });
    return;
  }
  const legacy = isVerifiedLegacyAgent(current, agent, packageRoot, projectRoot);
  if (request.adoptLegacy && legacy) {
    state.configText = editConfigChecked(state.configText, paths.configPath, ["agents", agent.id], desiredValue);
    state.configDirty = true;
    plan.nextAgents[agent.id] = { digest: desiredDigest };
    state.operations.push({
      kind: "adopt",
      target: `agents.${agent.id}`,
      detail: "verified legacy template adopted and converted to the portable form",
    });
    return;
  }
  state.blockers.push(
    `agents.${agent.id} already exists with different instructions, mode, permissions or model; ` +
      (legacy
        ? "it matches the verified legacy template, so rerun with --adopt-legacy to take ownership"
        : "refusing to overwrite an unowned entry"),
  );
  state.operations.push({
    kind: "blocked",
    target: `agents.${agent.id}`,
    detail: "unowned entry differs from the expected definition",
  });
}

/**
 * How one Markdown agent file relates to this installer's ownership record.
 * The planner, `check` and `uninstall` share this classification so the three
 * commands agree on what "unchanged" means.
 */
type MarkdownOwnershipStatus =
  | "missing" // no file and no ownership record
  | "unowned" // a file exists, but this installer has no record for it
  | "stale" // a pre-Markdown record with no `path`
  | "absent" // an owned file was deleted by the user
  | "retained" // a previously retained user edit
  | "owned" // the CRLF-folded file bytes match the owned digest
  | "modified"; // the CRLF-folded file bytes differ from the owned digest

interface MarkdownOwnership {
  status: MarkdownOwnershipStatus;
  /** Digest of the file bytes exactly as found on disk. */
  rawDigest: string | null;
  /** Digest after folding CRLF to LF; the ownership comparison. */
  ownershipDigest: string | null;
}

function classifyMarkdownOwnership(
  owned: InstallManifestEntry | undefined,
  fileText: string | null,
): MarkdownOwnership {
  const rawDigest = fileText === null ? null : agentMarkdownDigest(fileText);
  const ownershipDigest =
    fileText === null ? null : agentMarkdownOwnershipDigest(fileText);
  if (!owned) {
    return {
      status: fileText === null ? "missing" : "unowned",
      rawDigest,
      ownershipDigest,
    };
  }
  if (!owned.path) return { status: "stale", rawDigest, ownershipDigest };
  if (owned.retained) return { status: "retained", rawDigest, ownershipDigest };
  if (fileText === null) return { status: "absent", rawDigest, ownershipDigest };
  return {
    status: ownershipDigest === owned.digest ? "owned" : "modified",
    rawDigest,
    ownershipDigest,
  };
}

/**
 * The interrupted-migration shape: a pre-Markdown record has a digest but no
 * `path`, so only the Markdown file and the inline value can prove what the
 * crashed run wrote. Recovery is deliberately narrow: the record is not
 * retained, the file's CRLF-folded bytes equal the current source, and the
 * inline entry is absent, unchanged from the record, or already the desired
 * value. `planAgentEntries` and `checkInstallation` both call this before the
 * generic dual-form branch, so file + inline + pathless is not misreported as
 * two owned definitions.
 */
type PathlessRecoveryVerdict =
  | {
      kind: "recover";
      inline: "absent" | "unchanged" | "desired";
      removeInline: boolean;
      canonicalize: boolean;
    }
  | {
      kind: "manual";
      reason:
        | "retained"
        | "file-modified"
        | "inline-modified"
        | "inline-modified-without-file"
        | "file-missing"
        | "file-symlink";
    }
  | { kind: "not-applicable" };

function classifyPathlessFileRecovery(
  owned: InstallManifestEntry | undefined,
  current: unknown,
  fileText: string | null,
  fileIsSymlink: boolean,
  desiredContent: string,
  desiredInlineValue: Record<string, unknown>,
): PathlessRecoveryVerdict {
  if (!owned || owned.path) return { kind: "not-applicable" };
  // A retained record is never recovered automatically, with or without a
  // file. Checking it before the ordinary-inline shortcut keeps `check` and
  // `update` on the same manual message when the user deleted the file.
  if (owned.retained) return { kind: "manual", reason: "retained" };
  if (fileIsSymlink) return { kind: "manual", reason: "file-symlink" };
  if (fileText === null && current !== undefined) {
    if (
      digestValue(current) !== owned.digest &&
      !equivalentConfigValue(current, desiredInlineValue)
    ) {
      // An ordinary pre-Markdown inline install with no file yet. An edited
      // value is a manual state, not a reason for `check` and `update` to
      // print different refusals.
      return { kind: "manual", reason: "inline-modified-without-file" };
    }
    // An unchanged ordinary inline install still belongs to the inline
    // migration branch.
    return { kind: "not-applicable" };
  }
  if (fileText === null) return { kind: "manual", reason: "file-missing" };
  if (agentMarkdownOwnershipDigest(fileText) !== agentMarkdownDigest(desiredContent)) {
    return { kind: "manual", reason: "file-modified" };
  }
  if (
    current !== undefined &&
    digestValue(current) !== owned.digest &&
    !equivalentConfigValue(current, desiredInlineValue)
  ) {
    return { kind: "manual", reason: "inline-modified" };
  }
  const inline =
    current === undefined
      ? "absent"
      : digestValue(current) === owned.digest
        ? "unchanged"
        : "desired";
  return {
    kind: "recover",
    inline,
    removeInline: current !== undefined,
    canonicalize: fileText !== desiredContent,
  };
}

/** One recovery verdict for `check` and `update`; neither writes on manual. */
function pathlessRecoveryMessage(
  agentId: string,
  target: string,
  inline: "absent" | "unchanged" | "desired",
  canonicalize: boolean,
): string {
  const inlineText =
    inline === "absent"
      ? `the inline agents.${agentId} entry is already absent`
      : inline === "desired"
        ? `the inline agents.${agentId} entry already matches the current source`
        : `the inline agents.${agentId} entry is unchanged from the interrupted run`;
  return (
    `agents.${agentId} is an interrupted migration: its pre-Markdown ownership ` +
    `record has no Markdown path, the file ${toPosix(target)} matches the current ` +
    `source after folding CRLF, and ${inlineText}. update will adopt the file, record ` +
    "its path and canonical digest" +
    (inline === "absent" ? "" : ", remove the inline entry") +
    (canonicalize ? ", and rewrite only its line endings" : "") +
    "; no manual repair is needed"
  );
}

/** The same manual action from `check` (error) and `update` (blocker). */
function pathlessManualMessage(
  agentId: string,
  paths: ScopePaths,
  target: string,
  reason:
    | "retained"
    | "file-modified"
    | "inline-modified"
    | "inline-modified-without-file"
    | "file-missing"
    | "file-symlink",
): string {
  const record =
    `agents.${agentId} has a pre-Markdown ownership record but no Markdown path`;
  const config = toPosix(paths.configPath);
  const manifest = toPosix(paths.manifestPath);
  const file = toPosix(target);
  switch (reason) {
    case "retained":
      return (
        `${record}; it is marked retained because the inline entry changed after ` +
        "installation, and a retained record is never recovered automatically. " +
        "Restoring the inline value does not clear the retained flag. The inline value " +
        `and any file are left untouched. Remove agents.${agentId} from ${config} and its ` +
        `ownership record from ${manifest} to start over; uninstall retains user-modified ` +
        "entries. Nothing was changed"
      );
    case "file-modified":
      return (
        `${record}; the Markdown file ${file} differs from the current source, so ` +
        "the interrupted migration cannot be proven and nothing is overwritten. " +
        `Restore the source text in ${file}, or move the file aside and restore the ` +
        `inline entry in ${config}; removing the record would leave a file this ` +
        "release must not reuse. Nothing was changed"
      );
    case "inline-modified":
      return (
        `${record}; the Markdown file ${file} matches the source, but inline ` +
        `agents.${agentId} in ${config} changed after installation. Restore the ` +
        `original inline value, or remove agents.${agentId} from ${config} and its ` +
        `ownership record from ${manifest}; uninstall retains user-modified entries. ` +
        "Nothing was changed"
      );
    case "inline-modified-without-file":
      return (
        `${record}, and no Markdown file exists at ${file}; inline ` +
        `agents.${agentId} in ${config} changed after installation. Restore the ` +
        `original inline value, or remove agents.${agentId} from ${config} and its ` +
        `ownership record from ${manifest}; uninstall retains user-modified entries. ` +
        "Nothing was changed"
      );
    case "file-missing":
      return (
        `${record}, and no inline entry exists in ${config}; no Markdown file ` +
        `exists at ${file} either. Restore the inline entry in ${config}, or remove ` +
        `the stale ownership record from ${manifest}. Nothing was changed`
      );
    case "file-symlink":
      return (
        `${record}, and ${file} is a symbolic link. The installer never follows ` +
        "or replaces a symlink. Move the link aside and recreate a regular file, or " +
        `remove the ownership record from ${manifest}. Nothing was changed`
      );
  }
}

/**
 * Finish an interrupted migration without a journal: the file already matches
 * the source, so adopt it, record the canonical digest, and remove the inline
 * value only when it is still present. Rewrite the file only when its bytes
 * differ from the canonical text (CRLF line endings), always with the exact
 * bytes the planner observed as `before`.
 */
function planPathlessFileRecovery(
  plan: InstallPlan,
  agent: NativeAgentSpec,
  input: {
    target: string;
    content: string;
    desiredDigest: string;
    fileText: string | null;
    removeInline: boolean;
    canonicalize: boolean;
  },
): void {
  const { paths, state } = plan;
  const { target, content, desiredDigest, fileText, removeInline, canonicalize } = input;
  if (removeInline) {
    state.configText = editConfigChecked(
      state.configText,
      paths.configPath,
      ["agents", agent.id],
      undefined,
    );
    state.configDirty = true;
  }
  if (canonicalize) {
    state.agentWrites.push({ id: agent.id, target, content, before: fileText });
  }
  plan.nextAgents[agent.id] = { path: target, digest: desiredDigest };
  state.operations.push({
    kind: "migrate",
    target: toPosix(target),
    detail:
      "interrupted migration completed: Markdown file adopted and canonical digest recorded" +
      (removeInline ? "; inline entry removed" : "") +
      (canonicalize ? "; line endings canonicalized" : ""),
  });
}

/**
 * Markdown ownership branch. The CRLF-folded digest decides whether this
 * installer may refresh the file; the semantic comparison decides whether a
 * retained record can be healed because the file matches the source again.
 */
function planMarkdownAgent(
  plan: InstallPlan,
  agent: NativeAgentSpec,
  input: {
    target: string;
    content: string;
    desiredDigest: string;
    owned: InstallManifestEntry | undefined;
    fileText: string | null;
  },
): void {
  const { paths, state } = plan;
  const { target, content, desiredDigest, owned, fileText } = input;
  const ownership = classifyMarkdownOwnership(owned, fileText);
  const fileIsSymlink = fileText !== null && lstatSync(target).isSymbolicLink();
  const matchesSource =
    fileText !== null && markdownAgentDifferences(agent, fileText).length === 0;
  const label = `agents.${agent.id}`;

  if (ownership.status === "stale") {
    // The pre-gate handles every pathless record with a file. This branch is
    // the delegate for the missing-file case, so `check` and `update` publish
    // the same manual action instead of two different refusals.
    const verdict = classifyPathlessFileRecovery(
      owned,
      undefined,
      fileText,
      fileIsSymlink,
      content,
      agentConfigValue(agent),
    );
    state.blockers.push(
      pathlessManualMessage(
        agent.id,
        paths,
        target,
        verdict.kind === "manual" ? verdict.reason : "file-missing",
      ),
    );
    state.operations.push({
      kind: "blocked",
      target: toPosix(target),
      detail: "stale pre-Markdown ownership record requires a manual decision",
    });
    return;
  }

  if (owned?.retained) {
    if (fileText === null || ownership.rawDigest === null) {
      // The retained edit is gone. Restoring the source is the only state the
      // installer can prove safe: the user's version no longer exists, so the
      // record is cleared and the file recreated rather than silently dropped.
      state.agentWrites.push({ id: agent.id, target, content, before: null });
      plan.nextAgents[agent.id] = { path: target, digest: desiredDigest };
      state.operations.push({
        kind: "update",
        target: toPosix(target),
        detail:
          "previously retained Markdown agent was removed by the user; restored from source and retained flag cleared",
      });
      return;
    }
    if (matchesSource) {
      // The user's edit now matches the source again; the record no longer
      // needs to pin their digest, and the file is healed to canonical bytes.
      if (fileText !== content) {
        state.agentWrites.push({ id: agent.id, target, content, before: fileText });
      }
      plan.nextAgents[agent.id] = { path: target, digest: desiredDigest };
      state.operations.push({
        kind: fileText === content ? "keep" : "update",
        target: toPosix(target),
        detail:
          "previously retained user edit now matches the source; retained flag cleared" +
          (fileText === content ? "" : " and the file canonicalized"),
      });
      return;
    }
    plan.nextAgents[agent.id] = {
      path: target,
      digest: ownership.rawDigest,
      retained: true,
    };
    state.retained.push(label);
    state.operations.push({
      kind: "retain",
      target: toPosix(target),
      detail: "previously retained user edit; left untouched and still recorded",
    });
    return;
  }

  if (owned) {
    if (fileText === null || ownership.rawDigest === null) {
      state.agentWrites.push({ id: agent.id, target, content, before: null });
      plan.nextAgents[agent.id] = { path: target, digest: desiredDigest };
      state.operations.push({
        kind: "update",
        target: toPosix(target),
        detail: "owned Markdown agent was missing; rewritten from source",
      });
    } else if (ownership.status === "owned") {
      // The file is still the installer's: it matches the owned text while the
      // source moved on (source change), or it only differs in line endings
      // (CRLF). Both are refreshed to the canonical bytes the installer
      // writes. Any other byte difference is a user edit; a semantic
      // comparison must not turn whitespace into a silent overwrite.
      if (fileText === content) {
        plan.nextAgents[agent.id] = { path: target, digest: desiredDigest };
        state.operations.push({
          kind: "keep",
          target: toPosix(target),
          detail: "Markdown agent already current",
        });
      } else {
        state.agentWrites.push({ id: agent.id, target, content, before: fileText });
        plan.nextAgents[agent.id] = { path: target, digest: desiredDigest };
        state.operations.push({
          kind: "update",
          target: toPosix(target),
          detail: "owned Markdown agent updated to the current source",
        });
      }
    } else {
      plan.nextAgents[agent.id] = {
        path: target,
        digest: ownership.rawDigest,
        retained: true,
      };
      state.retained.push(label);
      state.operations.push({
        kind: "retain",
        target: toPosix(target),
        detail: "user-modified after installation; left untouched and still recorded",
      });
    }
    return;
  }

  if (fileText !== null) {
    if (matchesSource) {
      state.operations.push({
        kind: "reuse",
        target: toPosix(target),
        detail: "identical pre-existing Markdown agent reused without claiming ownership",
      });
      return;
    }
    state.blockers.push(
      `Markdown agent ${toPosix(target)} already exists with different content outside this installer; ` +
        "refusing to overwrite it. Move it aside or reconcile it manually",
    );
    state.operations.push({
      kind: "blocked",
      target: toPosix(target),
      detail: "unowned Markdown agent differs from the source",
    });
    return;
  }

  state.agentWrites.push({ id: agent.id, target, content, before: null });
  plan.nextAgents[agent.id] = { path: target, digest: desiredDigest };
  state.operations.push({
    kind: "create",
    target: toPosix(target),
    detail: "portable native agent Markdown file",
  });
}

function planPluginEntry(plan: InstallPlan): void {
  const { request, paths, packageRoot, manifest, models, state } = plan;
  const plugins = getPath(plan.currentConfig, ["plugins"]);
  if (plugins !== undefined && !Array.isArray(plugins)) {
    state.blockers.push(
      "configuration `plugins` is not an array; refusing to replace existing registrations. " +
        "Nothing was changed.",
    );
    return;
  }
  const packagePath = pluginPackagePath(packageRoot);
  const desiredPlugin = pluginConfigValue(
    packagePath,
    packageRoot,
    models,
    plan.persistedPluginOptions,
    plan.screeningRoles,
    plan.persistedScreening,
  );
  const desiredDigest = digestValue(desiredPlugin);
  const existing = plan.existingPlugin;
  if (!existing) {
    const list = Array.isArray(plugins) ? plugins.length : 0;
    state.configText = Array.isArray(plugins)
      ? editConfigChecked(state.configText, paths.configPath, ["plugins", list], desiredPlugin)
      : editConfigChecked(state.configText, paths.configPath, ["plugins"], [desiredPlugin]);
    state.configDirty = true;
    plan.nextAgents.__pluginDigest = { digest: desiredDigest };
    state.operations.push({
      kind: "create",
      target: "plugins[ARS]",
      detail: `register ${toPosix(packagePath)}`,
    });
    return;
  }
  const ownedDigest = manifest?.pluginDigest;
  if (ownedDigest && !manifest?.pluginRetained) {
    if (equivalentConfigValue(existing.value, desiredPlugin)) {
      plan.nextAgents.__pluginDigest = { digest: desiredDigest };
      state.operations.push({ kind: "keep", target: "plugins[ARS]", detail: "owned plugin entry already current" });
    } else if (digestValue(existing.value) === ownedDigest) {
      state.configText = editConfigChecked(state.configText, paths.configPath, ["plugins", existing.index], desiredPlugin);
      state.configDirty = true;
      plan.nextAgents.__pluginDigest = { digest: desiredDigest };
      state.operations.push({ kind: "update", target: "plugins[ARS]", detail: "owned plugin entry refreshed" });
    } else {
      plan.nextAgents.__pluginDigest = { digest: ownedDigest, retained: true };
      state.retained.push("plugins[ARS]");
      state.operations.push({
        kind: "retain",
        target: "plugins[ARS]",
        detail: "user-modified plugin entry; left untouched and still recorded",
      });
    }
  } else if (ownedDigest) {
    plan.nextAgents.__pluginDigest = { digest: ownedDigest, retained: true };
    state.retained.push("plugins[ARS]");
    state.operations.push({
      kind: "retain",
      target: "plugins[ARS]",
      detail: "previously retained plugin entry; still never overwritten",
    });
  } else if (equivalentConfigValue(existing.value, desiredPlugin)) {
    state.operations.push({
      kind: "reuse",
      target: "plugins[ARS]",
      detail: "identical plugin entry reused without claiming ownership",
    });
  } else if (request.adoptLegacy && isVerifiedLegacyPlugin(existing.value, packageRoot)) {
    state.configText = editConfigChecked(state.configText, paths.configPath, ["plugins", existing.index], desiredPlugin);
    state.configDirty = true;
    plan.nextAgents.__pluginDigest = { digest: desiredDigest };
    state.operations.push({
      kind: "adopt",
      target: "plugins[ARS]",
      detail: "verified legacy plugin entry adopted with the explicit --adopt-legacy authorization",
    });
  } else if (!models && typeof existing.value === "string") {
    state.operations.push({
      kind: "reuse",
      target: "plugins[ARS]",
      detail: "existing manual package registration reused; rerun with --adopt-legacy to own it",
    });
  } else {
    state.blockers.push(
      "the plugin entry for this checkout already exists with different options; " +
        "rerun with --adopt-legacy only after reviewing it, or merge the entry manually",
    );
  }
}

function planSkillChannel(plan: InstallPlan): void {
  const { request, paths, packageRoot, manifest, skillSources, state } = plan;
  const instructions = getPath(plan.currentConfig, ["instructions"]);
  if (instructions !== undefined && !Array.isArray(instructions)) {
    state.blockers.push(
      "configuration `instructions` is not an array; refusing to replace the existing entries. " +
        "Nothing was changed.",
    );
    return;
  }
  const instructionContent = projectionInstructions(
    paths.scope,
    packageRoot,
    paths.skillsDir,
  );
  const instructionDigest = sha256(instructionContent);
  const currentInstruction = readConfigText(paths.instructionPath);
  const currentInstructionDigest =
    currentInstruction === null ? null : sha256(currentInstruction);
  const ownedInstruction = manifest?.instructions;
  let instructionCreated = false;
  let instructionUpdated = false;
  if (currentInstruction === null) {
    state.instructionContent = instructionContent;
    state.instructionWrite = true;
    instructionCreated = true;
    state.operations.push({
      kind: "create",
      target: toPosix(paths.instructionPath),
      detail: "managed scope-appropriate ARS instructions",
    });
  } else if (ownedInstruction && !ownedInstruction.retained) {
    if (currentInstructionDigest === ownedInstruction.digest) {
      if (currentInstructionDigest !== instructionDigest) {
        state.instructionContent = instructionContent;
        state.instructionWrite = true;
        instructionUpdated = true;
        state.operations.push({
          kind: "update",
          target: toPosix(paths.instructionPath),
          detail: "owned instructions refreshed",
        });
      } else {
        state.operations.push({
          kind: "keep",
          target: toPosix(paths.instructionPath),
          detail: "owned instructions already current",
        });
      }
    } else {
      state.retained.push("instructions");
      state.operations.push({
        kind: "retain",
        target: toPosix(paths.instructionPath),
        detail: "user-modified instructions kept together with their config reference",
      });
    }
  } else if (ownedInstruction?.retained) {
    state.retained.push("instructions");
    state.operations.push({
      kind: "retain",
      target: toPosix(paths.instructionPath),
      detail: "previously retained instructions still owned only by the user",
    });
  } else if (currentInstructionDigest === instructionDigest) {
    state.operations.push({
      kind: "reuse",
      target: toPosix(paths.instructionPath),
      detail: "identical pre-existing instructions reused without claiming ownership",
    });
  } else {
    state.blockers.push(
      `instructions file ${toPosix(paths.instructionPath)} already exists with different content; ` +
        "refusing to overwrite it. Move it aside or merge the routing guidance manually",
    );
  }

  const instructionIndex = findInstructionIndex(
    instructions,
    paths.instructionConfigValue,
    paths.projectRoot,
    paths.home,
  );
  if (instructionIndex !== -1) {
    state.instructionReferenceAdded = Boolean(
      ownedInstruction?.configReferenceAdded,
    );
  }
  const ownsInstructionFile =
    instructionCreated ||
    instructionUpdated ||
    Boolean(ownedInstruction && !ownedInstruction.retained && ownedInstruction.fileOwned !== false);
  if (instructionIndex === -1 && !state.retained.includes("instructions")) {
    if (ownsInstructionFile || currentInstructionDigest === instructionDigest) {
      state.configText = Array.isArray(instructions)
        ? editConfigChecked(state.configText, paths.configPath, ["instructions", instructions.length], paths.instructionConfigValue)
        : editConfigChecked(state.configText, paths.configPath, ["instructions"], [paths.instructionConfigValue]);
      state.configDirty = true;
      state.instructionReferenceAdded = true;
      state.operations.push({
        kind: "create",
        target: "instructions[ARS]",
        detail: `register ${paths.instructionConfigValue}`,
      });
    } else {
      state.warnings.push(
        `instructions file ${toPosix(paths.instructionPath)} is user-owned, so no instructions entry was added for it`,
      );
    }
  } else if (instructionIndex !== -1) {
    state.operations.push({
      kind: "keep",
      target: "instructions[ARS]",
      detail: "instruction reference already present",
    });
  }

  for (const source of skillSources) {
    const target = join(paths.skillsDir, source.name);
    const owned = manifest?.skills[source.name];
    if (!existsSync(target)) {
      state.skillWrites.push({ name: source.name, source, target, expectedDigest: null });
      state.operations.push({
        kind: owned ? "update" : "create",
        target: toPosix(target),
        detail: `complete skill tree, ${source.files.length} files`,
      });
      continue;
    }
    const targetStats = lstatSync(target);
    if (!targetStats.isDirectory() && !targetStats.isSymbolicLink()) {
      state.blockers.push(
        `skill target ${toPosix(target)} exists and is not a directory; refusing to replace it`,
      );
      state.operations.push({
        kind: "blocked",
        target: toPosix(target),
        detail: "target exists but is not a skill directory",
      });
      continue;
    }
    const currentDigest = skillTreeDigest(target);
    if (currentDigest === source.digest) {
      state.operations.push({
        kind: owned ? "keep" : "reuse",
        target: toPosix(target),
        detail: owned
          ? "complete skill tree already current"
          : "identical pre-existing skill tree reused without claiming ownership",
      });
      continue;
    }
    if (owned && !owned.retained && currentDigest === owned.digest) {
      state.skillWrites.push({ name: source.name, source, target, expectedDigest: currentDigest });
      state.operations.push({
        kind: "update",
        target: toPosix(target),
        detail: "owned skill tree replaced as one directory unit",
      });
      continue;
    }
    if (owned) {
      state.retained.push(`skills.${source.name}`);
      state.operations.push({
        kind: "retain",
        target: toPosix(target),
        detail: "user-modified skill bundle kept whole; no mixed old/new tree was written",
      });
      continue;
    }
    state.blockers.push(
      `skill directory ${toPosix(target)} already exists with different content outside this installer; ` +
        "refusing to mix or overwrite it",
    );
    state.operations.push({
      kind: "blocked",
      target: toPosix(target),
      detail: "unowned skill tree differs from the source",
    });
  }

  // Retire only skills this installer owned and nobody changed.
  for (const [name, owned] of Object.entries(manifest?.skills ?? {})) {
    if (skillSources.some((source) => source.name === name)) continue;
    if (!existsSync(owned.dir)) continue;
    if (owned.retained) {
      state.retained.push(`skills.${name}`);
      state.operations.push({
        kind: "retain",
        target: toPosix(owned.dir),
        detail: "retired source skill was modified; kept for manual removal",
      });
      continue;
    }
    const currentDigest = skillTreeDigest(owned.dir);
    if (currentDigest === owned.digest) {
      state.skillRemoves.push({ name, target: owned.dir, expectedDigest: currentDigest });
      state.operations.push({
        kind: "remove",
        target: toPosix(owned.dir),
        detail: "retired skill no longer in the source and unchanged since installation",
      });
    } else {
      state.retained.push(`skills.${name}`);
      state.operations.push({
        kind: "retain",
        target: toPosix(owned.dir),
        detail: "retired skill was modified; kept",
      });
    }
  }
}

function composeInstallManifest(plan: InstallPlan): void {
  const { request, paths, packageRoot, projectRoot, manifest, skillSources, state } = plan;
  const now = nowIso(request);
  const nextSkills: InstallManifest["skills"] = {};
  for (const source of skillSources) {
    const target = join(paths.skillsDir, source.name);
    const owned = manifest?.skills[source.name];
    if (owned?.retained) {
      nextSkills[source.name] = owned;
      continue;
    }
    if (owned && state.retained.includes(`skills.${source.name}`)) {
      nextSkills[source.name] = { ...owned, retained: true };
      continue;
    }
    if (owned) {
      nextSkills[source.name] = { dir: target, digest: source.digest };
      continue;
    }
    const targetStats = existsSync(target) ? lstatSync(target) : null;
    const alreadyIdentical =
      targetStats !== null &&
      (targetStats.isDirectory() || targetStats.isSymbolicLink()) &&
      skillTreeDigest(target) === source.digest;
    if (alreadyIdentical) {
      // Reuse without ownership: nothing to record.
      continue;
    }
    nextSkills[source.name] = { dir: target, digest: source.digest };
  }
  for (const [name, owned] of Object.entries(manifest?.skills ?? {})) {
    if (nextSkills[name]) continue;
    if (skillSources.some((source) => source.name === name)) continue;
    if (state.retained.includes(`skills.${name}`)) nextSkills[name] = { ...owned, retained: true };
  }

  const nextManifest: InstallManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    installer: INSTALLER_ID,
    channel: request.channel,
    scope: paths.scope,
    packageRoot: toPosix(packageRoot),
    projectRoot: paths.scope === "project" ? toPosix(projectRoot) : null,
    configPath: toPosix(paths.configPath),
    createdAt: manifest?.createdAt ?? now,
    updatedAt: now,
    agents: Object.fromEntries(
      Object.entries(plan.nextAgents).filter(([key]) => key !== "__pluginDigest"),
    ),
    skills: nextSkills,
    pendingRemovals: (manifest?.pendingRemovals ?? []).filter(
      (name) => !state.skillRemoves.some((remove) => remove.name === name),
    ),
  };
  const pluginDigestEntry = plan.nextAgents.__pluginDigest;
  delete plan.nextAgents.__pluginDigest;
  if (pluginDigestEntry) {
    nextManifest.pluginDigest = pluginDigestEntry.digest;
    if (pluginDigestEntry.retained) nextManifest.pluginRetained = true;
  } else if (manifest?.pluginDigest) {
    nextManifest.pluginDigest = manifest.pluginDigest;
    if (manifest.pluginRetained) nextManifest.pluginRetained = true;
  }
  if (request.channel === "skills" && !state.retained.includes("instructions")) {
    const instructionDigest = sha256(
      state.instructionContent ??
        readConfigText(paths.instructionPath) ??
        "",
    );
    const ownsInstructionFile =
      state.instructionWrite ||
      Boolean(manifest?.instructions && !manifest.instructions.retained && manifest.instructions.fileOwned !== false);
    if (ownsInstructionFile || state.instructionReferenceAdded) {
      nextManifest.instructions = {
        path: toPosix(paths.instructionPath),
        configValue: paths.instructionConfigValue,
        digest: instructionDigest,
        fileOwned: ownsInstructionFile,
        configReferenceAdded: state.instructionReferenceAdded,
      };
    }
  } else if (manifest?.instructions) {
    nextManifest.instructions = { ...manifest.instructions, retained: true };
  }

  nextManifest.updatedAt = manifest?.updatedAt ?? now;
  const hasOwnership =
    Object.keys(nextManifest.agents).length > 0 ||
    Boolean(nextManifest.pluginDigest) ||
    Boolean(nextManifest.instructions) ||
    Object.keys(nextManifest.skills).length > 0 ||
    nextManifest.pendingRemovals.length > 0;
  if (manifest === null && !hasOwnership) {
    // Everything was reused; do not invent an empty ownership manifest.
    state.manifest = null;
    state.manifestWrite = false;
  } else {
    const manifestChanged =
      manifest === null || canonicalJson(nextManifest) !== canonicalJson(manifest);
    if (manifestChanged) nextManifest.updatedAt = now;
    state.manifest = manifestChanged ? nextManifest : manifest;
    state.manifestWrite = manifestChanged;
  }
}

function inspectChannelSources(input: {
  request: InstallRequest;
  paths: ScopePaths;
  packageRoot: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  catalog: Catalog;
  persistedModels: AdapterOptions["models"] | undefined;
  persistedScreeningRoles: Record<string, ModelRef> | undefined;
  blockers: string[];
  warnings: string[];
  operations: InstallOperation[];
}): {
  models: AdapterOptions["models"] | undefined;
  screeningRoles: Record<string, ModelRef> | undefined;
  desiredAgents: NativeAgentSpec[];
  skillSources: SkillSource[];
} {
  const {
    request,
    paths,
    packageRoot,
    projectRoot,
    env,
    catalog,
    persistedModels,
    persistedScreeningRoles,
    blockers,
    warnings,
    operations,
  } = input;
  const models =
    request.channel === "plugin"
      ? mergeModels(persistedModels, request.models)
      : undefined;
  const screeningRoles =
    request.channel === "plugin"
      ? mergeScreeningRoles(persistedScreeningRoles, request.screeningRoles)
      : undefined;
  const desiredAgentResult = loadNativeAgents(
    packageRoot,
    { models },
    [],
    { validateModels: false },
  );
  for (const problem of desiredAgentResult.problems) blockers.push(problem);
  const desiredAgents =
    request.channel === "skills"
      ? desiredAgentResult.agents.filter((agent) => agent.id === SKILLS_ONLY_AGENT)
      : desiredAgentResult.agents;
  if (request.channel === "skills" && desiredAgents.length !== 1) {
    blockers.push(
      `the ${SKILLS_ONLY_AGENT} source agent is missing; the skills channel cannot install its reviewer`,
    );
  }

  const skillSources =
    request.channel === "skills" ? loadSkillSources(packageRoot) : [];

  reportNativeSkillSources({
    projectRoot,
    home: paths.home,
    env,
    channel: request.channel,
    ourSkillsDir: paths.skillsDir,
    warnings,
    operations,
  });

  if (request.channel === "plugin") {
    for (const alias of new Set(
      catalog.commands
        .map((command) => command.model)
        .filter((value): value is string => Boolean(value && value !== "inherit")),
    )) {
      if (!models?.aliases?.[alias]) {
        warnings.push(
          `command alias ${JSON.stringify(alias)} has no models.aliases mapping; those commands stay blocked until you configure it`,
        );
      }
    }
    if (models) {
      for (const [name, ref] of Object.entries(models.agents ?? {})) {
        if (!desiredAgents.some((agent) => agent.id === name)) {
          warnings.push(`models.agents.${name} does not name one of the four ARS native agents`);
        }
        if (!modelExists(ref, [])) {
          warnings.push(
            `models.agents.${name} -> ${ref.providerID}/${ref.model} cannot be proven available offline; the host reports it at load time`,
          );
        }
      }
    }
    if (screeningRoles) {
      const knownRoles = new Set(["A", "B", "ADJ", "QC", "FTA", "FTB", "FTADJ"]);
      for (const [role, ref] of Object.entries(screeningRoles)) {
        if (!knownRoles.has(role)) {
          warnings.push(
            `screening.roles.${role} is not a screening role; expected A, B, ADJ, QC, FTA, FTB or FTADJ`,
          );
        }
        if (!modelExists(ref, [])) {
          warnings.push(
            `screening.roles.${role} -> ${ref.providerID}/${ref.model} cannot be proven available offline; the host reports it at load time`,
          );
        }
      }
    }
  }

  return { models, screeningRoles, desiredAgents, skillSources };
}

export async function runInstaller(request: InstallRequest): Promise<InstallReport> {
  const env = request.env ?? process.env;
  const packageRoot = request.packageRoot
    ? resolve(request.packageRoot)
    : defaultPackageRoot();
  if (!isPackageRoot(packageRoot)) {
    throw new InstallError(
      `ARS package root ${JSON.stringify(packageRoot)} is not a complete checkout; ` +
        "expected .claude-plugin/plugin.json and the five SKILL.md files. Nothing was changed.",
    );
  }
  const projectRoot = resolve(request.projectRoot);
  if (!existsSync(projectRoot)) {
    throw new InstallError(`project directory ${toPosix(projectRoot)} does not exist`);
  }
  if (request.action !== "check" && !request.allowCheckout) {
    const rootIdentity = pathIdentity(packageRoot);
    const projectIdentity = pathIdentity(projectRoot);
    if (
      projectIdentity === rootIdentity ||
      projectIdentity.startsWith(`${rootIdentity.replace(/\/+$/, "")}/`)
    ) {
      throw new InstallError(
        `project directory ${toPosix(projectRoot)} is inside the ARS checkout; installing there ` +
          "would write managed files into the source tree. Choose another --project, or pass " +
          "--allow-checkout only for adapter development.",
      );
    }
  }
  if ((request.models || request.screeningRoles) && request.channel === "skills") {
    throw new InstallError(
      "the skills channel has no plugin options, so --models is not supported; " +
        "the reviewer keeps its source `inherit` model. Install the plugin channel to configure model mappings.",
    );
  }

  const paths = resolveScope(request, packageRoot);
  if (request.action !== "check") {
    assertStateOutsideProject(paths.stateRoot, paths.projectRoot);
  }
  const catalog: Catalog = loadCatalog(packageRoot);
  const operations: InstallOperation[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const retained: string[] = [];
  const checks: InstallationCheck[] = [];

  const originalConfigText = readConfigText(paths.configPath);
  const originalManifestText = readConfigText(paths.manifestPath);
  const configText = originalConfigText ?? NEW_CONFIG;
  let manifest: InstallManifest | null;
  try {
    manifest = readManifestFile(paths.manifestPath);
  } catch (error) {
    throw error;
  }

  if (request.action === "update" && !manifest) {
    throw new InstallError(
      `no ${request.channel} ownership manifest at ${toPosix(paths.manifestPath)}; run install first`,
    );
  }
  if (manifest && (manifest.channel !== request.channel || manifest.scope !== paths.scope)) {
    throw new InstallError(
      `the ownership manifest ${toPosix(paths.manifestPath)} describes a ` +
        `${manifest.channel}/${manifest.scope} installation, not ${request.channel}/${paths.scope}; refusing to mix ownership records`,
    );
  }
  if (manifest && !samePath(manifest.configPath, paths.configPath)) {
    throw new InstallError(
      `ownership manifest ${toPosix(paths.manifestPath)} is bound to configuration ` +
        `${toPosix(manifest.configPath)}, not ${toPosix(paths.configPath)}; the environment ` +
        "now resolves a different configuration. Restore the original environment or remove " +
        "the stale manifest explicitly; nothing was changed.",
    );
  }
  if (request.action !== "uninstall" && request.action !== "check") {
    const conflict = otherChannelReviewerBlocker(paths, request, packageRoot);
    if (conflict) blockers.push(conflict);
  }

  const currentConfig = parseConfig(configText, paths.configPath);
  const existingPlugin = findPluginIndex(
    getPath(currentConfig, ["plugins"]),
    pluginPackagePath(packageRoot),
    paths.projectRoot,
  );
  const persistedPluginOptions = pluginOptionsFromEntry(existingPlugin?.value);
  const persistedModels = modelsFromPluginEntry(existingPlugin?.value);
  const persistedScreeningValue = persistedPluginOptions.screening;
  const persistedScreening =
    persistedScreeningValue &&
    typeof persistedScreeningValue === "object" &&
    !Array.isArray(persistedScreeningValue)
      ? (persistedScreeningValue as Record<string, unknown>)
      : undefined;
  const persistedScreeningRoles = screeningRolesFromPluginEntry(existingPlugin?.value);

  // Source/shadowing preview: respect native precedence and never delete the
  // other channel's files. Both may coexist, but one route per scope is the
  // documented expectation.
  if (request.channel === "plugin") {
    const shadowing = SKILL_DIRS.filter((name) =>
      existsSync(join(paths.skillsDir, name, "SKILL.md")),
    );
    if (shadowing.length) {
      warnings.push(
        `${shadowing.length} native skill copies also exist under ${toPosix(paths.skillsDir)}. ` +
          "Those IDs have multiple sources; this disk preview cannot prove which plugin/native definition the host will select. Inspect the live inventory before using them.",
      );
    }
  } else {
    if (existingPlugin) {
      warnings.push(
        `a plugin entry for this checkout also exists in ${toPosix(paths.configPath)}. ` +
          "The skills channel does not remove it; use one route per scope, or uninstall the plugin channel first.",
      );
    }
  }

  const { models, screeningRoles, desiredAgents, skillSources } = inspectChannelSources({
    request,
    paths,
    packageRoot,
    projectRoot,
    env,
    catalog,
    persistedModels,
    persistedScreeningRoles,
    blockers,
    warnings,
    operations,
  });

  if (request.action === "check") {
    return await checkInstallation({
      request,
      paths,
      catalog,
      packageRoot,
      configText,
      currentConfig,
      manifest,
      desiredAgents,
      skillSources,
      models,
      screeningRoles,
      operations,
      blockers,
      warnings,
      checks,
    });
  }

  if (request.action === "uninstall") {
    return await uninstall({
      request,
      paths,
      packageRoot,
      configText,
      originalConfigText,
      originalManifestText,
      manifest,
      operations,
      blockers,
      warnings,
      retained,
      checks,
    });
  }

  const state: ApplyState = {
    configText,
    originalConfigText,
    originalManifestText,
    originalInstructionText: readConfigText(paths.instructionPath),
    configDirty: false,
    instructionContent: null,
    instructionWrite: false,
    instructionDelete: false,
    instructionReferenceAdded: false,
    skillWrites: [],
    skillRemoves: [],
    agentWrites: [],
    agentRemoves: [],
    manifest,
    manifestWrite: false,
    manifestDelete: false,
    backupTargets: [],
    operations,
    blockers,
    warnings,
    retained,
  };

  const plan: InstallPlan = {
    request,
    paths,
    packageRoot,
    projectRoot,
    manifest,
    currentConfig,
    existingPlugin,
    persistedPluginOptions,
    models,
    screeningRoles,
    persistedScreening,
    desiredAgents,
    skillSources,
    state,
    nextAgents: {},
  };
  planAgentEntries(plan);
  if (request.channel === "plugin") planPluginEntry(plan);
  if (request.channel === "skills") planSkillChannel(plan);
  composeInstallManifest(plan);

  if (blockers.length) {
    return finish({
      request,
      paths,
      packageRoot,
      catalog,
      operations,
      blockers,
      warnings,
      retained,
      checks,
      state,
      applied: false,
      changed:
        state.configDirty ||
        state.skillWrites.length > 0 ||
        state.skillRemoves.length > 0 ||
        state.agentWrites.length > 0 ||
        state.instructionWrite,
      manifest,
    });
  }

  if (state.configDirty) {
    state.backupTargets.push(paths.configPath);
    operations.push({ kind: "update", target: toPosix(paths.configPath), detail: "configuration (JSONC comments preserved)" });
  }
  if (state.instructionWrite) state.backupTargets.push(paths.instructionPath);
  for (const write of state.skillWrites) state.backupTargets.push(write.target);
  for (const remove of state.skillRemoves) state.backupTargets.push(remove.target);
  for (const write of state.agentWrites) state.backupTargets.push(write.target);
  for (const remove of state.agentRemoves) state.backupTargets.push(remove.target);
  state.backupTargets.push(paths.manifestPath);

  const changed =
    state.configDirty ||
    state.instructionWrite ||
    state.skillWrites.length > 0 ||
    state.skillRemoves.length > 0 ||
    state.agentWrites.length > 0 ||
    state.agentRemoves.length > 0 ||
    state.manifestWrite;

  if (!changed && blockers.length === 0) {
    // Nothing to do: the second apply is a genuine no-op.
    return finish({
      request,
      paths,
      packageRoot,
      catalog,
      operations,
      blockers,
      warnings,
      retained,
      checks,
      state,
      applied: false,
      changed: false,
      manifest,
    });
  }

  if (!request.apply) {
    operations.push({
      kind: "keep",
      target: toPosix(paths.manifestPath),
      detail: "preview only; rerun with --apply to write (backups stay outside the project VCS)",
    });
    return finish({
      request,
      paths,
      packageRoot,
      catalog,
      operations,
      blockers,
      warnings,
      retained,
      checks,
      state,
      applied: false,
      changed: true,
      manifest,
    });
  }

  return await applyInstall({
    request,
    paths,
    packageRoot,
    catalog,
    operations,
    blockers,
    warnings,
    retained,
    checks,
    state,
    originalConfigText,
    manifest,
  });
}

interface FinishInput {
  request: InstallRequest;
  paths: ScopePaths;
  packageRoot: string;
  catalog: Catalog;
  operations: InstallOperation[];
  blockers: string[];
  warnings: string[];
  retained: string[];
  checks: InstallationCheck[];
  state: ApplyState;
  applied: boolean;
  changed: boolean;
  manifest: InstallManifest | null;
}

function finish(input: FinishInput): InstallReport {
  const { request, paths, operations, blockers, warnings, retained, checks, state } = input;
  pushCheck(
    checks,
    "disk-only",
    "warn",
    "these are disk checks; they do not prove the host loaded the plugin, registered a command or activated a guard",
  );
  return {
    action: request.action,
    channel: request.channel,
    scope: paths.scope,
    packageRoot: toPosix(paths.packageRoot),
    projectRoot: toPosix(paths.projectRoot),
    configPath: toPosix(paths.configPath),
    skillsDir: request.channel === "skills" ? toPosix(paths.skillsDir) : null,
    agentsDir: toPosix(paths.agentsDir),
    instructionsPath:
      request.channel === "skills" ? toPosix(paths.instructionPath) : null,
    manifestPath: toPosix(paths.manifestPath),
    stateRoot: toPosix(paths.stateRoot),
    backupDir: state.backupDir ? toPosix(state.backupDir) : null,
    operations,
    checks,
    blockers,
    warnings,
    retained,
    failed: state.manifest?.pendingRemovals ?? [],
    ok: blockers.length === 0,
    applied: input.applied,
    changed: input.changed,
  };
}

function ensureStateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

function assertStateOutsideProject(stateRoot: string, projectRoot: string): void {
  const relation = relative(projectRoot, stateRoot);
  if (relation === "" || (relation && !relation.startsWith("..") && !isAbsolute(relation))) {
    throw new InstallError(
      `installer state directory ${toPosix(stateRoot)} is inside the project VCS root; ` +
        "set ARS_OPENCODE_STATE_DIR to a private path outside the project",
    );
  }
  // A sibling of a nested project can still be inside its parent worktree.
  // Also resolve existing junctions/symlinks before trusting this boundary.
  let existing = resolve(stateRoot);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const physical = resolve(realpathSync(existing), relative(existing, resolve(stateRoot)));
  const physicalRelation = relative(realpathSync(projectRoot), physical);
  if (physicalRelation === "" || (!physicalRelation.startsWith("..") && !isAbsolute(physicalRelation))) {
    throw new InstallError("installer state resolves inside the project; choose a private ARS_OPENCODE_STATE_DIR outside it");
  }
  for (let directory = physical; ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git"))) {
      throw new InstallError(`installer state is inside a Git worktree (${toPosix(directory)}); set ARS_OPENCODE_STATE_DIR to a private location outside VCS`);
    }
    if (dirname(directory) === directory) break;
  }
}

interface LockHandle {
  path: string;
  release: () => void;
}

function acquireLock(stateRoot: string, projectRoot: string): LockHandle {
  assertStateOutsideProject(stateRoot, projectRoot);
  ensureStateDir(stateRoot);
  const path = join(stateRoot, "install.lock");
  const token = `${process.pid} ${Date.now()} ${randomBytes(8).toString("hex")}`;
  const write = () => {
    writeFileSync(path, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
  };
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM still proves the process exists. Only ESRCH (and the Windows
      // equivalent) means the owner is gone.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  try {
    write();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    let stale = false;
    let observed = "";
    try {
      observed = readFileSync(path, "utf8").trim();
      const [pidText] = observed.split(/\s+/);
      const pid = Number(pidText);
      stale = Number.isInteger(pid) && pid > 0 && !alive(pid);
    } catch (error) {
      stale = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    if (!stale) {
      // A live owner is never displaced by age alone.
      throw new InstallError(
        `another ARS installation holds ${toPosix(path)}; retry after it finishes. ` +
          "If no installer is running (for example the lock file is empty), delete that file and retry.",
      );
    }
    try {
      // Re-read: another waiter may have replaced the stale handle meanwhile.
      if (readFileSync(path, "utf8").trim() === observed) unlinkSync(path);
    } catch {
      // Another process may have taken it over.
    }
    try {
      write();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new InstallError(
          `another ARS installation took ${toPosix(path)} while a stale lock was being reclaimed; ` +
            "retry after it finishes.",
        );
      }
      throw error;
    }
  }
  return {
    path,
    release: () => {
      try {
        // Release only this caller's token; never delete someone else's lock.
        if (readFileSync(path, "utf8").trim() === token) unlinkSync(path);
      } catch {
        // Already gone or taken over.
      }
    },
  };
}

function mkdirForFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeFileStaged(
  path: string,
  content: string,
  expectedBefore: string | null,
  stagingRoot?: string,
): void {
  mkdirForFile(path);
  const before = readConfigText(path);
  if (before !== expectedBefore) {
    throw new InstallError(
      `configuration ${toPosix(path)} changed while the preview was open; aborting instead of overwriting a newer edit`,
    );
  }
  // Sensitive staging copies live in the private state directory, never next
  // to the project config where `git ls-files --others` can see them.
  const stagingDir = stagingRoot
    ? join(stagingRoot, "staging")
    : dirname(path);
  if (stagingRoot) ensureStateDir(stagingDir);
  const temporary = join(
    stagingDir,
    `${basename(path)}.ars-tmp-${randomBytes(6).toString("hex")}`,
  );
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  try {
    assertSnapshot(path, expectedBefore);
    // Replace in one rename where the platform allows it. No delete-before-
    // replace: if the final rename fails, the original file is still intact.
    try {
      renameSync(temporary, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EXDEV") throw error;
      throw new InstallError("private staging cannot cross filesystems atomically; set ARS_OPENCODE_STATE_DIR to a private, out-of-VCS directory on the destination filesystem and retry");
    }
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Best effort.
    }
    throw error;
  }
  try {
    if (existsSync(temporary)) unlinkSync(temporary);
  } catch {
    // Best effort.
  }
}

/**
 * Undo one file write only while the file still contains exactly what this
 * installer wrote. A newer external edit is never clobbered by rollback: the
 * conflict aborts the remaining undo chain instead, because earlier assets may
 * be referenced by this file.
 */
function fileUndo(path: string, before: string | null, after: string, stagingRoot: string): () => void {
  return () => {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current !== after) {
      throw new InstallError(
        `${toPosix(path)} changed after this installer wrote it; rollback stopped instead of overwriting the newer edit`,
      );
    }
    if (before === null) unlinkSync(path);
    else writeFileStaged(path, before, after, stagingRoot);
  };
}

function copyBackup(source: string, target: string): void {
  if (!existsSync(source)) return;
  const stats = statSync(source);
  if (stats.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const from = join(source, entry.name);
      const to = join(target, entry.name);
      if (entry.isDirectory()) copyBackup(from, to);
      else if (entry.isFile()) {
        mkdirForFile(to);
        copyFileSync(from, to);
      }
    }
  } else if (stats.isFile()) {
    mkdirForFile(target);
    copyFileSync(source, target);
  }
}

function removeDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function rollbackOwnWrites(
  undo: (() => void)[],
  warnings: string[],
  backupDir: string,
): boolean {
  let complete = true;
  for (const step of undo.reverse()) {
    try {
      step();
    } catch (error) {
      complete = false;
      warnings.push(
        `rollback stopped after ${(error as Error).message}; later-owned assets that this ` +
          `configuration may reference were left in place. Private backups: ${toPosix(backupDir)}`,
      );
      break;
    }
  }
  return complete;
}

interface ApplyInstallInput {
  request: InstallRequest;
  paths: ScopePaths;
  packageRoot: string;
  catalog: Catalog;
  operations: InstallOperation[];
  blockers: string[];
  warnings: string[];
  retained: string[];
  checks: InstallationCheck[];
  state: ApplyState;
  originalConfigText: string | null;
  manifest: InstallManifest | null;
}

async function applyInstall(input: ApplyInstallInput): Promise<InstallReport> {
  const { request, paths, packageRoot, catalog, operations, blockers, warnings, retained, checks, state } = input;
  const lock = acquireLock(paths.stateRoot, paths.projectRoot);
  void packageRoot;
  void catalog;
  const backupDir = join(
    paths.stateRoot,
    "backups",
    `${nowIso(request).replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`,
  );
  state.backupDir = backupDir;
  const undo: (() => void)[] = [];
  try {
    assertSnapshot(paths.configPath, input.originalConfigText);
    assertSnapshot(paths.manifestPath, state.originalManifestText);
    if (request.channel === "skills") assertSnapshot(paths.instructionPath, state.originalInstructionText);
    ensureStateDir(backupDir);
    for (const target of state.backupTargets) {
      if (!existsSync(target)) continue;
      const relativePath = relative(paths.stateRoot, target);
      const backupPath = relativePath.startsWith("..") || isAbsolute(relativePath)
        ? join(backupDir, "external", sha256(target).slice(0, 12), "asset")
        : join(backupDir, "state", relativePath);
      copyBackup(target, backupPath);
      operations.push({ kind: "backup", target: toPosix(target), detail: `private copy at ${toPosix(backupPath)}` });
    }

    if (request.testHooks?.failAt === "skills") {
      throw new InstallError("test-injected skill write failure");
    }
    for (const write of state.skillWrites) {
      const staging = join(dirname(write.target), `.${write.name}.ars-tmp-${randomBytes(6).toString("hex")}`);
      try {
        copySkillTree(write.source, staging);
        const current = existsSync(write.target) ? skillTreeDigest(write.target) : null;
        if (current !== write.expectedDigest) {
          throw new InstallError(
            `skill directory ${toPosix(write.target)} changed while the preview was open; aborting`,
          );
        }
        const writtenDigest = skillTreeDigest(staging);
        if (writtenDigest !== write.source.digest) {
          throw new InstallError(`source skill ${write.name} changed during staging; rerun the preview`);
        }
        const originalUnit = join(backupDir, "external", sha256(write.target).slice(0, 12), "original-unit");
        // Move the whole old unit aside instead of partially deleting it.
        undo.push(() => {
          if (existsSync(write.target)) {
            if (skillTreeDigest(write.target) !== writtenDigest) {
              throw new InstallError(
                `skill directory ${toPosix(write.target)} changed during rollback; ` +
                  "left in place with its private backup",
              );
            }
            removeDirectory(write.target);
          }
          if (existsSync(originalUnit)) renameSync(originalUnit, write.target);
        });
        if (existsSync(write.target)) {
          mkdirForFile(originalUnit);
          renameSync(write.target, originalUnit);
          if (skillTreeDigest(originalUnit) !== write.expectedDigest) {
            throw new InstallError(`skill ${write.name} changed during replacement; restoring the original unit`);
          }
        }
        renameSync(staging, write.target);
      } catch (error) {
        try {
          removeDirectory(staging);
        } catch {
          // Best effort.
        }
        throw error;
      }
    }
    for (const remove of state.skillRemoves) {
      const before = existsSync(remove.target) ? skillTreeDigest(remove.target) : null;
      if (before === null) continue;
      if (before !== remove.expectedDigest) {
        throw new InstallError(`retired skill ${toPosix(remove.target)} changed since planning; refusing to remove it`);
      }
      const originalUnit = join(backupDir, "external", sha256(remove.target).slice(0, 12), "original-unit");
      undo.push(() => {
        if (existsSync(remove.target)) return;
        if (existsSync(originalUnit)) renameSync(originalUnit, remove.target);
      });
      mkdirForFile(originalUnit);
      renameSync(remove.target, originalUnit);
      if (skillTreeDigest(originalUnit) !== remove.expectedDigest) {
        throw new InstallError(`retired skill ${remove.name} changed during removal; restoring it`);
      }
    }

    if (request.testHooks?.failAt === "instructions") {
      throw new InstallError("test-injected instruction write failure");
    }
    if (state.instructionWrite && state.instructionContent !== null) {
      const before = state.originalInstructionText;
      writeFileStaged(paths.instructionPath, state.instructionContent, before, paths.stateRoot);
      undo.push(fileUndo(paths.instructionPath, before, state.instructionContent, paths.stateRoot));
    }

    if (request.testHooks?.failAt === "agents") {
      throw new InstallError("test-injected agent write failure");
    }
    for (const write of state.agentWrites) {
      const current = existsSync(write.target) ? readFileSync(write.target, "utf8") : null;
      if (current !== write.before) {
        throw new InstallError(
          `Markdown agent ${toPosix(write.target)} changed while the preview was open; ` +
            "aborting instead of overwriting a newer edit",
        );
      }
      writeFileStaged(write.target, write.content, write.before, paths.stateRoot);
      undo.push(fileUndo(write.target, write.before, write.content, paths.stateRoot));
    }
    if (request.testHooks?.crashAfter === "agents") {
      throw new SimulatedCrash("test-injected crash after the Markdown agent write");
    }

    if (request.testHooks?.failAt === "config") {
      throw new InstallError("test-injected configuration write failure");
    }
    if (state.configDirty) {
      writeFileStaged(paths.configPath, state.configText, input.originalConfigText, paths.stateRoot);
      undo.push(fileUndo(paths.configPath, input.originalConfigText, state.configText, paths.stateRoot));
    }
    if (request.testHooks?.crashAfter === "config") {
      throw new SimulatedCrash("test-injected crash after the configuration write");
    }

    if (request.testHooks?.failAt === "manifest") {
      throw new InstallError("test-injected manifest write failure");
    }
    if (state.manifest && state.manifestWrite) {
      const text = `${JSON.stringify(state.manifest, null, 2)}\n`;
      const beforeManifest = state.originalManifestText;
      ensureStateDir(paths.stateRoot);
      writeFileStaged(paths.manifestPath, text, beforeManifest, paths.stateRoot);
      undo.push(fileUndo(paths.manifestPath, beforeManifest, text, paths.stateRoot));
    }

    return finish({
      request,
      paths,
      packageRoot,
      catalog,
      operations,
      blockers,
      warnings,
      retained,
      checks,
      state,
      applied: true,
      changed: true,
      manifest: state.manifest,
    });
  } catch (error) {
    if (error instanceof SimulatedCrash) {
      // A real crash never reaches the rollback or the report.
      throw error;
    }
    const restored = rollbackOwnWrites(undo, warnings, backupDir);
    blockers.push(
      `installer aborted; ${restored ? "own unchanged writes rolled back" : "rollback incomplete (see private backups)"}: ${(error as Error).message}`,
    );
    pushCheck(checks, "rollback", "error", (error as Error).message);
    return finish({
      request,
      paths,
      packageRoot,
      catalog,
      operations,
      blockers,
      warnings,
      retained,
      checks,
      state,
      applied: false,
      changed: false,
      manifest: input.manifest,
    });
  } finally {
    lock.release();
  }
}

/** Frontmatter text without its fences; empty when the file has none. */
function markdownFrontmatterText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return "";
  const end = normalized.indexOf("\n---", 4);
  return end === -1 ? "" : normalized.slice(4, end);
}

/** Markdown body without its frontmatter, trimmed like the source prompts. */
function markdownBodyText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const end = normalized.indexOf("\n---", 4);
  return end === -1 ? normalized.trim() : normalized.slice(end + 4).replace(/^\n/, "").trim();
}

/** Compare a Markdown agent file with the rendered expectation. */
function markdownAgentDifferences(agent: NativeAgentSpec, content: string): string[] {
  const expected = renderAgentMarkdown(agent);
  const differences: string[] = [];
  if (markdownFrontmatterText(content) !== markdownFrontmatterText(expected)) {
    differences.push("frontmatter (description, mode, model or permissions)");
  }
  if (!equivalentText(markdownBodyText(content), agent.system)) {
    differences.push("instructions");
  }
  return differences;
}

interface CheckInput {
  request: InstallRequest;
  paths: ScopePaths;
  catalog: Catalog;
  packageRoot: string;
  configText: string;
  currentConfig: Record<string, unknown>;
  manifest: InstallManifest | null;
  desiredAgents: NativeAgentSpec[];
  skillSources: SkillSource[];
  models?: AdapterOptions["models"];
  screeningRoles?: Record<string, ModelRef>;
  operations: InstallOperation[];
  blockers: string[];
  warnings: string[];
  checks: InstallationCheck[];
}

async function checkInstallation(input: CheckInput): Promise<InstallReport> {
  const { request, paths, catalog, packageRoot, configText, currentConfig, manifest, desiredAgents, blockers, warnings, checks } = input;
  void configText;
  void input.operations;
  for (const problem of blockers) pushCheck(checks, "preflight", "error", problem);
  const channelConflict = otherChannelReviewerBlocker(paths, request, packageRoot);
  if (channelConflict) pushCheck(checks, "channel-conflict", "error", channelConflict);
  const major = Number(process.versions.node.split(".")[0]);
  pushCheck(
    checks,
    "platform",
    process.platform === "win32" ? "ok" : "warn",
    process.platform === "win32"
      ? "Windows host; the validated combination"
      : `${process.platform} is untested; Windows 11 + OpenCode 2.2.7 + Node 24 is the validated combination`,
  );
  pushCheck(
    checks,
    "node",
    major >= 24 ? "ok" : "error",
    `Node ${process.versions.node}${major >= 24 ? "" : "; this adapter requires Node 24+"}`,
  );
  const pluginVersion = readPackageVersion(packageRoot);
  pushCheck(
    checks,
    "plugin-dependency",
    pluginVersion === "2.2.7" ? "ok" : pluginVersion ? "warn" : "error",
    pluginVersion
      ? `@opencode/plugin ${pluginVersion}${pluginVersion === "2.2.7" ? "" : " (validated version is 2.2.7)"}`
      : "opencode/node_modules/@opencode/plugin is missing; run npm ci in opencode/",
  );
  pushCheck(
    checks,
    "catalog",
    "ok",
    `${catalog.skills.length} skills, ${catalog.commands.length} commands, 4 source agents`,
  );

  if (manifest) {
    pushCheck(
      checks,
      "manifest",
      "ok",
      `${manifest.channel}/${manifest.scope} ownership recorded at ${toPosix(paths.manifestPath)}`,
    );
  } else {
    pushCheck(
      checks,
      "manifest",
      "warn",
      `no ownership manifest at ${toPosix(paths.manifestPath)}; existing assets are treated as user-owned`,
    );
  }

  const plugins = getPath(currentConfig, ["plugins"]);
  const packagePath = pluginPackagePath(packageRoot);
  const pluginEntry = findPluginIndex(plugins, packagePath, projectRoot(paths));
  if (request.channel === "plugin") {
    pushCheck(
      checks,
      "plugin-entry",
      pluginEntry ? "ok" : "warn",
      pluginEntry
        ? `plugin entry present in ${toPosix(paths.configPath)}`
        : `plugin entry is not present in ${toPosix(paths.configPath)}`,
    );
  } else {
    pushCheck(
      checks,
      "plugin-entry",
      pluginEntry ? "warn" : "ok",
      pluginEntry
        ? "a plugin entry for this checkout also exists; two channels in one scope can shadow each other"
        : "skills channel: no plugin entry (commands, hooks and adapter tools are not installed)",
    );
  }

  if (request.channel === "skills") {
    let present = 0;
    for (const source of input.skillSources) {
      const target = join(paths.skillsDir, source.name);
      if (!existsSync(target)) continue;
      present += 1;
      const current = skillTreeDigest(target);
      pushCheck(
        checks,
        `skill:${source.name}`,
        current === source.digest ? "ok" : "warn",
        current === source.digest
          ? `complete tree at ${toPosix(target)}`
          : `tree at ${toPosix(target)} differs from the source (local edits are kept on update)`,
      );
    }
    pushCheck(
      checks,
      "skills",
      present === input.skillSources.length ? "ok" : "warn",
      `${present}/${input.skillSources.length} of the five skill trees found under ${toPosix(paths.skillsDir)}`,
    );
    pushCheck(
      checks,
      "instructions",
      existsSync(paths.instructionPath) ? "ok" : "warn",
      existsSync(paths.instructionPath)
        ? `managed instructions at ${toPosix(paths.instructionPath)}`
        : `no managed instructions at ${toPosix(paths.instructionPath)}`,
    );
  }

  const agents = getPath(currentConfig, ["agents"]);
  const installedAgents =
    agents && typeof agents === "object" && !Array.isArray(agents)
      ? (agents as Record<string, unknown>)
      : {};
  const foreignInline = foreignScopeInlineAgents(paths, request);
  for (const agent of desiredAgents) {
    const current = installedAgents[agent.id];
    const target = agentFilePath(paths.agentsDir, agent.id);
    const fileText = existsSync(target) ? readFileSync(target, "utf8") : null;
    const fileIsSymlink = fileText !== null && lstatSync(target).isSymbolicLink();
    const owned = manifest?.agents[agent.id];
    const foreignPath = foreignInline.get(agent.id);
    const content = renderAgentMarkdown(agent);
    if (foreignPath) {
      pushCheck(
        checks,
        `agent:${agent.id}`,
        "error",
        `also defined inline as agents.${agent.id} in ${toPosix(foreignPath)} (${paths.scope === "project" ? "global" : "project"} scope); keep one form across scopes`,
      );
      continue;
    }
    // Same classifier as `update`, before the dual-form branch: a crash after
    // the file write leaves file + inline + a pathless record, which is
    // recoverable rather than two owned definitions.
    const recovery = classifyPathlessFileRecovery(
      owned,
      current,
      fileText,
      fileIsSymlink,
      content,
      agentConfigValue(agent),
    );
    if (recovery.kind === "recover") {
      pushCheck(
        checks,
        `agent:${agent.id}`,
        "warn",
        pathlessRecoveryMessage(agent.id, target, recovery.inline, recovery.canonicalize),
      );
      continue;
    }
    if (recovery.kind === "manual") {
      pushCheck(
        checks,
        `agent:${agent.id}`,
        "error",
        pathlessManualMessage(agent.id, paths, target, recovery.reason),
      );
      continue;
    }
    if (current !== undefined && fileText !== null) {
      pushCheck(
        checks,
        `agent:${agent.id}`,
        "error",
        `defined twice: Markdown file ${toPosix(target)} and agents.${agent.id} in ${toPosix(paths.configPath)}; keep one form`,
      );
      continue;
    }
    if (current !== undefined) {
      const differences = agentDifferences(agent, {
        id: agent.id,
        system:
          typeof (current as Record<string, unknown>).system === "string"
            ? ((current as Record<string, unknown>).system as string)
            : undefined,
        mode: (current as Record<string, unknown>).mode as NativeAgentSpec["mode"] | undefined,
        permissions: (current as Record<string, unknown>).permissions as never,
        model: (current as Record<string, unknown>).model as never,
      });
      if (owned && !owned.path) {
        const changed =
          owned.retained ||
          (digestValue(current) !== owned.digest &&
            !equivalentConfigValue(current, agentConfigValue(agent)));
        pushCheck(
          checks,
          `agent:${agent.id}`,
          changed ? "error" : "warn",
          changed
            ? `legacy inline agents.${agent.id} is user-modified; update will stop before migrating`
            : `legacy inline agents.${agent.id} is unchanged; run update to migrate it to ${toPosix(target)}`,
        );
      } else if (!owned) {
        pushCheck(
          checks,
          `agent:${agent.id}`,
          differences.length ? "error" : "warn",
          differences.length
            ? `unowned legacy inline agents.${agent.id} differs from the source; update will refuse it`
            : `unowned legacy inline agents.${agent.id} is identical and will not be claimed or migrated`,
        );
      } else {
        pushCheck(
          checks,
          `agent:${agent.id}`,
          differences.length ? "warn" : "ok",
          differences.length
            ? `inline agents.${agent.id} on disk with different ${differences.join(", ")}`
            : `inline agents.${agent.id} on disk with the expected instructions, mode, permissions and model`,
        );
      }
      continue;
    }
    const ownership = classifyMarkdownOwnership(owned, fileText);
    const differences =
      fileText === null ? [] : markdownAgentDifferences(agent, fileText);
    if (ownership.status === "stale") {
      // Delegate to the shared classifier: with no file and no inline entry it
      // returns the same manual action `update` blocks with. A pathless record
      // with a file was already handled before the dual-form branch.
      const verdict = classifyPathlessFileRecovery(
        owned,
        undefined,
        fileText,
        fileIsSymlink,
        content,
        agentConfigValue(agent),
      );
      pushCheck(
        checks,
        `agent:${agent.id}`,
        "error",
        pathlessManualMessage(
          agent.id,
          paths,
          target,
          verdict.kind === "manual" ? verdict.reason : "file-missing",
        ),
      );
      continue;
    }
    if (fileText === null) {
      pushCheck(
        checks,
        `agent:${agent.id}`,
        "warn",
        `not present: no Markdown file at ${toPosix(target)} and no agents.${agent.id} in ${toPosix(paths.configPath)}`,
      );
      continue;
    }
    if (ownership.status === "modified" && differences.length === 0) {
      // The text is semantically the same but these are not the bytes the
      // installer wrote (for example, trailing whitespace or blank lines).
      // `update` and `uninstall` keep the file as a user edit, so `check` must
      // not report `ok`.
      pushCheck(
        checks,
        `agent:${agent.id}`,
        "warn",
        `Markdown file ${toPosix(target)} matches the source semantically, but its bytes differ from the installed file; update and uninstall will keep it as a user edit`,
      );
      continue;
    }
    pushCheck(
      checks,
      `agent:${agent.id}`,
      differences.length ? "warn" : "ok",
      differences.length
        ? `Markdown file ${toPosix(target)} differs in ${differences.join(", ")}`
        : `Markdown file ${toPosix(target)} has the expected frontmatter and instructions`,
    );
  }

  if (request.channel === "plugin") {
    const interpreter = await discoverInterpreter({ timeoutMs: 3_000 });
    pushCheck(
      checks,
      "python",
      interpreter ? "ok" : "warn",
      interpreter
        ? `interpreter: ${interpreter.join(" ")} (guard and CLI wrappers can run)`
        : "no real Python interpreter; the guard reports degraded and the three CLI wrappers are blocked",
    );
    const effectiveModels = input.models ?? request.models;
    if (effectiveModels) {
      const mapped = [
        ...Object.keys(effectiveModels.aliases ?? {}).map((name) => `aliases.${name}`),
        ...Object.keys(effectiveModels.agents ?? {}).map((name) => `agents.${name}`),
      ];
      pushCheck(
        checks,
        "models",
        mapped.length ? "ok" : "warn",
        mapped.length
          ? `configured mappings (persisted plugin options and explicit --models): ${mapped.join(", ")}; availability is verified by the host, not by this disk check`
          : "no model mappings configured; aliased commands stay blocked until you map them",
      );
    } else {
      pushCheck(
        checks,
        "models",
        "warn",
        "no persisted or explicit models mapping; Claude aliased commands stay blocked until the plugin options carry a mapping",
      );
    }
    const effectiveScreening = input.screeningRoles ?? request.screeningRoles;
    const mappedRoles = Object.keys(effectiveScreening ?? {});
    const aliasKeys = Object.keys(effectiveModels?.aliases ?? {});
    pushCheck(
      checks,
      "screening-models",
      mappedRoles.length ? "ok" : "warn",
      mappedRoles.length
        ? `screening roles configured: ${mappedRoles.join(", ")}; availability is verified by the host`
        : aliasKeys.length
          ? "no explicit screening role overrides; roles you leave unlisted use the models.aliases tier defaults (sonnet/opus/haiku)"
          : "no screening role mappings and no models.aliases; screening roles stay blocked until models.aliases.* are configured",
    );
  }

  if (paths.scope === "global") {
    pushCheck(
      checks,
      "scope",
      "ok",
      "one fixed global profile; each project uses its own trusted runtime root, not this installer's path",
    );
  }

  pushCheck(
    checks,
    "disk-only",
    "warn",
    "these are disk checks; they do not prove the host loaded the plugin, registered a command or activated a guard",
  );

  const report: InstallReport = {
    action: "check",
    channel: request.channel,
    scope: paths.scope,
    packageRoot: toPosix(packageRoot),
    projectRoot: toPosix(paths.projectRoot),
    configPath: toPosix(paths.configPath),
    skillsDir: request.channel === "skills" ? toPosix(paths.skillsDir) : null,
    agentsDir: toPosix(paths.agentsDir),
    instructionsPath: request.channel === "skills" ? toPosix(paths.instructionPath) : null,
    manifestPath: toPosix(paths.manifestPath),
    stateRoot: toPosix(paths.stateRoot),
    backupDir: null,
    operations: input.operations,
    checks,
    blockers,
    warnings,
    retained: [],
    failed: manifest?.pendingRemovals ?? [],
    ok: blockers.length === 0 && checks.every((check) => check.status !== "error"),
    applied: false,
    changed: false,
  };
  return report;
}

function projectRoot(paths: ScopePaths): string {
  return paths.projectRoot;
}

interface UninstallInput {
  request: InstallRequest;
  paths: ScopePaths;
  packageRoot: string;
  configText: string;
  originalConfigText: string | null;
  originalManifestText: string | null;
  manifest: InstallManifest | null;
  operations: InstallOperation[];
  blockers: string[];
  warnings: string[];
  retained: string[];
  checks: InstallationCheck[];
}

async function uninstall(input: UninstallInput): Promise<InstallReport> {
  const { request, paths, packageRoot, manifest, operations, blockers, warnings, retained, checks } = input;
  let configText = input.configText;
  let configDirty = false;
  let config: Record<string, unknown>;
  try {
    config = parseConfig(configText, paths.configPath);
  } catch (error) {
    blockers.push((error as Error).message);
    return finishUninstall(input, false, false);
  }
  const state: ApplyState = {
    configText,
    originalConfigText: input.originalConfigText,
    originalManifestText: input.originalManifestText,
    originalInstructionText: manifest?.instructions ? readConfigText(manifest.instructions.path) : null,
    configDirty: false,
    instructionContent: null,
    instructionWrite: false,
    instructionDelete: false,
    instructionReferenceAdded: false,
    skillWrites: [],
    skillRemoves: [],
    agentWrites: [],
    agentRemoves: [],
    manifest,
    manifestWrite: false,
    manifestDelete: false,
    backupTargets: [],
    operations,
    blockers,
    warnings,
    retained,
  };
  if (!manifest) {
    warnings.push(
      `no ownership manifest at ${toPosix(paths.manifestPath)}; nothing is owned by this installer, so nothing is removed`,
    );
    operations.push({
      kind: "keep",
      target: toPosix(paths.configPath),
      detail: "no owned entries to remove; user configuration is untouched",
    });
    return finishUninstall(input, false, false);
  }

  const nextManifest: InstallManifest = {
    ...manifest,
    agents: { ...manifest.agents },
    skills: { ...manifest.skills },
    pendingRemovals: [...manifest.pendingRemovals],
  };

  let otherOwnsReviewer = false;
  try {
    const other = otherChannelManifest(paths, request, packageRoot);
    otherOwnsReviewer = Boolean(other?.manifest.agents[SKILLS_ONLY_AGENT]);
    if (otherOwnsReviewer && other) {
      warnings.push(
        `the ${other.manifest.channel} channel still owns ${SKILLS_ONLY_AGENT} ` +
          `(${toPosix(other.path)}); this uninstall will keep the shared reviewer file`,
      );
    }
  } catch (error) {
    otherOwnsReviewer = true;
    warnings.push(
      `the other channel's manifest could not be read; retaining ${SKILLS_ONLY_AGENT}: ${(error as Error).message}`,
    );
  }

  const agents = getPath(config, ["agents"]);
  const agentRecord =
    agents && typeof agents === "object" && !Array.isArray(agents)
      ? (agents as Record<string, unknown>)
      : {};
  for (const [id, owned] of Object.entries(manifest.agents)) {
    if (id === SKILLS_ONLY_AGENT && otherOwnsReviewer) {
      // This uninstall ends our claim but must not delete a file the other
      // channel owns. Drop our record so a later reinstall starts clean.
      delete nextManifest.agents[id];
      operations.push({
        kind: "retain",
        target: owned.path ? toPosix(owned.path) : `agents.${id}`,
        detail: "the other channel still owns this reviewer; file left in place and our claim removed",
      });
      continue;
    }
    if (owned.path) {
      if (!existsSync(owned.path)) {
        // Already gone: nothing to remove or retain.
        delete nextManifest.agents[id];
        continue;
      }
      const currentText = readFileSync(owned.path, "utf8");
      const ownership = classifyMarkdownOwnership(owned, currentText);
      // The CRLF-folded ownership digest decides whether the file is still the
      // one the installer wrote; `retained` stays authoritative, so a retained
      // record is never removed by the shared classifier's "owned" status.
      const currentDigest = agentMarkdownDigest(currentText);
      if (!owned.retained && ownership.status === "owned") {
        state.agentRemoves.push({ id, target: owned.path, expectedDigest: currentDigest });
        state.backupTargets.push(owned.path);
        delete nextManifest.agents[id];
        operations.push({
          kind: "remove",
          target: toPosix(owned.path),
          detail: "unchanged owned Markdown agent removed",
        });
      } else {
        retained.push(`agents.${id}`);
        nextManifest.agents[id] = { ...owned, digest: currentDigest, retained: true };
        operations.push({
          kind: "retain",
          target: toPosix(owned.path),
          detail: "changed after installation; Markdown file and ownership record preserved",
        });
      }
      continue;
    }
    const current = agentRecord[id];
    if (current === undefined) {
      if (!owned.path) {
        // A stale pre-Markdown record has no Markdown path, so this command
        // never owned a file it could delete. Say so instead of dropping the
        // record silently.
        warnings.push(
          `agents.${id} has a stale pre-Markdown ownership record but no inline entry; ` +
            "only the record is removed and no Markdown path can be deleted. " +
            `Restore the inline entry or remove the file at ${toPosix(agentFilePath(paths.agentsDir, id))} manually`,
        );
        operations.push({
          kind: "keep",
          target: `agents.${id}`,
          detail:
            "stale pre-Markdown ownership record dropped; no Markdown path was owned, so no file was removed",
        });
      }
      delete nextManifest.agents[id];
      continue;
    }
    if (owned.retained) {
      retained.push(`agents.${id}`);
      operations.push({
        kind: "retain",
        target: `agents.${id}`,
        detail: "user-modified entry kept; metadata retained for a later retry",
      });
      continue;
    }
    if (digestValue(current) === owned.digest) {
      const leftover = agentFilePath(paths.agentsDir, id);
      if (existsSync(leftover)) {
        warnings.push(
          `agents.${id} has no recorded Markdown path, but ${toPosix(leftover)} exists ` +
            "(likely from an interrupted migration); the inline entry and record are removed " +
            "and the file is left in place. Remove it manually if it is not wanted",
        );
      }
      configText = editConfigChecked(configText, paths.configPath, ["agents", id], undefined);
      configDirty = true;
      delete nextManifest.agents[id];
      operations.push({ kind: "remove", target: `agents.${id}`, detail: "unchanged owned entry removed" });
    } else {
      nextManifest.agents[id] = { digest: digestValue(current), retained: true };
      retained.push(`agents.${id}`);
      operations.push({
        kind: "retain",
        target: `agents.${id}`,
        detail: "changed after installation; preserved with its ownership record",
      });
    }
  }

  const plugins = getPath(config, ["plugins"]);
  const packagePath = pluginPackagePath(packageRoot);
  const pluginEntry = findPluginIndex(plugins, packagePath, paths.projectRoot);
  if (manifest.pluginDigest) {
    if (!pluginEntry) {
      delete nextManifest.pluginDigest;
      delete nextManifest.pluginRetained;
    } else if (!manifest.pluginRetained && digestValue(pluginEntry.value) === manifest.pluginDigest) {
      configText = editConfigChecked(
        configText,
        paths.configPath,
        ["plugins", pluginEntry.index],
        undefined,
        {
          path: ["plugins"],
          value: Array.isArray(plugins)
            ? plugins.filter((_, index) => index !== pluginEntry.index)
            : [],
        },
      );
      configDirty = true;
      delete nextManifest.pluginDigest;
      delete nextManifest.pluginRetained;
      operations.push({ kind: "remove", target: "plugins[ARS]", detail: "unchanged owned entry removed" });
    } else {
      retained.push("plugins[ARS]");
      nextManifest.pluginRetained = true;
      operations.push({
        kind: "retain",
        target: "plugins[ARS]",
        detail: "changed after installation; preserved",
      });
    }
  }

  let pendingInstructionReferenceIndex = -1;
  let releaseInstruction = false;
  if (manifest.instructions) {
    const currentFile = readConfigText(manifest.instructions.path);
    const unchanged =
      !manifest.instructions.retained &&
      manifest.instructions.configReferenceAdded !== false &&
      (currentFile === null || sha256(currentFile) === manifest.instructions.digest);
    if (unchanged) {
      const instructions = getPath(config, ["instructions"]);
      pendingInstructionReferenceIndex = findInstructionIndex(
        instructions,
        manifest.instructions.configValue,
        paths.projectRoot,
        paths.home,
      );
      releaseInstruction = true;
      state.instructionDelete = manifest.instructions.fileOwned !== false && currentFile !== null;
      if (state.instructionDelete) state.backupTargets.push(manifest.instructions.path);
      operations.push({
        kind: "remove",
        target: toPosix(manifest.instructions.path),
        detail: state.instructionDelete ? "unchanged managed instructions removed" : "release only the owned reference; reused instruction file is preserved",
      });
    } else {
      retained.push("instructions");
      nextManifest.instructions = { ...manifest.instructions, retained: true };
      operations.push({
        kind: "retain",
        target: toPosix(manifest.instructions.path),
        detail: "modified instructions and their config reference kept as one unit",
      });
    }
  }

  for (const [name, owned] of Object.entries(manifest.skills)) {
    if (!existsSync(owned.dir)) {
      delete nextManifest.skills[name];
      nextManifest.pendingRemovals = nextManifest.pendingRemovals.filter((item) => item !== name);
      continue;
    }
    const currentDigest = skillTreeDigest(owned.dir);
    if (!owned.retained && currentDigest === owned.digest) {
      state.skillRemoves.push({ name, target: owned.dir, expectedDigest: currentDigest });
      state.backupTargets.push(owned.dir);
      delete nextManifest.skills[name];
      operations.push({ kind: "remove", target: toPosix(owned.dir), detail: "unchanged owned skill tree removed" });
    } else {
      retained.push(`skills.${name}`);
      nextManifest.skills[name] = { ...owned, retained: true };
      operations.push({
        kind: "retain",
        target: toPosix(owned.dir),
        detail: "modified skill tree kept whole with its ownership record",
      });
    }
  }

  state.manifest = nextManifest;
  state.manifestWrite = true;
  state.configText = configText;
  state.configDirty = configDirty;
  const hasOwned =
    Object.keys(nextManifest.agents).length > 0 ||
    Boolean(nextManifest.pluginDigest) ||
    Boolean(nextManifest.instructions) ||
    Object.keys(nextManifest.skills).length > 0;
  state.manifestDelete = !hasOwned;
  state.backupTargets.push(paths.manifestPath);
  if (configDirty || pendingInstructionReferenceIndex !== -1) state.backupTargets.push(paths.configPath);
  if (state.instructionDelete) state.backupTargets.push(manifest.instructions?.path ?? "");

  const changed =
    configDirty ||
    state.instructionDelete ||
    state.skillRemoves.length > 0 ||
    state.agentRemoves.length > 0 ||
    state.manifestDelete ||
    manifest !== null;

  if (!request.apply) {
    operations.push({
      kind: "keep",
      target: toPosix(paths.manifestPath),
      detail: "preview only; rerun with --apply to remove the listed owned assets",
    });
    return finishUninstall(input, false, true);
  }

  const lock = acquireLock(paths.stateRoot, paths.projectRoot);
  const backupDir = join(
    paths.stateRoot,
    "backups",
    `${nowIso(request).replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`,
  );
  state.backupDir = backupDir;
  const undo: (() => void)[] = [];
  try {
    assertSnapshot(paths.configPath, input.originalConfigText);
    assertSnapshot(paths.manifestPath, input.originalManifestText);
    if (manifest.instructions) assertSnapshot(manifest.instructions.path, state.originalInstructionText);
    ensureStateDir(backupDir);
    for (const target of state.backupTargets) {
      if (!target || !existsSync(target)) continue;
      const backupPath = join(
        backupDir,
        "external",
        sha256(target).slice(0, 12),
        "asset",
      );
      copyBackup(target, backupPath);
      operations.push({ kind: "backup", target: toPosix(target), detail: `private copy at ${toPosix(backupPath)}` });
    }
    let removalFailed = false;
    for (const remove of state.skillRemoves) {
      if (!existsSync(remove.target)) continue;
      const before = skillTreeDigest(remove.target);
      if (before !== remove.expectedDigest) {
        throw new InstallError(
          `skill directory ${toPosix(remove.target)} changed while the preview was open; aborting`,
        );
      }
      try {
        if (request.testHooks?.failAt === "removal") {
          throw new Error("test-injected removal failure");
        }
        const originalUnit = join(backupDir, "external", sha256(remove.target).slice(0, 12), "original-unit");
        mkdirForFile(originalUnit);
        renameSync(remove.target, originalUnit);
        if (skillTreeDigest(originalUnit) !== remove.expectedDigest) {
          if (!existsSync(remove.target)) renameSync(originalUnit, remove.target);
          throw new InstallError(`skill ${remove.name} changed during removal; original unit preserved`);
        }
        nextManifest.pendingRemovals = nextManifest.pendingRemovals.filter(
          (name) => name !== remove.name,
        );
        undo.push(() => {
          if (!existsSync(remove.target) && existsSync(originalUnit)) renameSync(originalUnit, remove.target);
        });
      } catch (error) {
        removalFailed = true;
        warnings.push(`could not remove ${toPosix(remove.target)}: ${(error as Error).message}; it stays recorded`);
        nextManifest.pendingRemovals = [
          ...new Set([...nextManifest.pendingRemovals, remove.name]),
        ];
        const original = manifest.skills[remove.name];
        if (original) nextManifest.skills[remove.name] = { ...original, digest: before };
      }
    }
    if (removalFailed) {
      state.instructionDelete = false;
      releaseInstruction = false;
      // Config was not written, so ownership records must keep describing it.
      nextManifest.agents = { ...manifest.agents };
      if (manifest.instructions) nextManifest.instructions = manifest.instructions;
      if (manifest.pluginDigest) {
        nextManifest.pluginDigest = manifest.pluginDigest;
        if (manifest.pluginRetained) nextManifest.pluginRetained = true;
      }
      for (const remove of state.agentRemoves) {
        const target = toPosix(remove.target);
        const index = operations.findIndex(
          (operation) => operation.kind === "remove" && operation.target === target,
        );
        if (index !== -1) {
          operations[index] = {
            kind: "retain",
            target,
            detail: "left in place because at least one skill removal failed",
          };
        }
      }
      state.agentRemoves.length = 0;
      warnings.push(
        "configuration references and Markdown agents were left in place because at least one skill removal failed; retry after fixing the cause",
      );
    }
    if (!removalFailed) {
      // Markdown agents are files, not config references: remove them only when
      // nothing else failed, so a retry never loses the ownership record of a
      // file that is still there.
      for (const remove of state.agentRemoves) {
        if (!existsSync(remove.target)) continue;
        const current = readFileSync(remove.target, "utf8");
        if (agentMarkdownDigest(current) !== remove.expectedDigest) {
          throw new InstallError(
            `Markdown agent ${toPosix(remove.target)} changed while the preview was open; aborting`,
          );
        }
        if (request.testHooks?.failAt === "removal") {
          throw new InstallError("test-injected removal failure");
        }
        const backup = join(backupDir, "external", sha256(remove.target).slice(0, 12), "asset");
        undo.push(() => {
          if (existsSync(remove.target)) return;
          if (existsSync(backup)) copyBackup(backup, remove.target);
        });
        unlinkSync(remove.target);
      }
    }
    if (state.instructionDelete && manifest.instructions) {
      try {
        assertSnapshot(manifest.instructions.path, state.originalInstructionText);
        unlinkSync(manifest.instructions.path);
        undo.push(() => {
          if (existsSync(manifest.instructions!.path)) return;
          const backup = join(
            backupDir,
            "external",
            sha256(manifest.instructions!.path).slice(0, 12),
            "asset",
          );
          if (existsSync(backup)) copyBackup(backup, manifest.instructions!.path);
        });
      } catch (error) {
        releaseInstruction = false;
        warnings.push(`could not remove instructions: ${(error as Error).message}`);
        nextManifest.instructions = { ...manifest.instructions };
        nextManifest.pendingRemovals = [
          ...new Set([...nextManifest.pendingRemovals, "instructions"]),
        ];
        blockers.push(
          `could not remove instructions ${toPosix(manifest.instructions.path)}: ` +
            `${(error as Error).message}; ownership and reference were kept for retry`,
        );
        operations.push({
          kind: "retain",
          target: toPosix(manifest.instructions.path),
          detail: "failed removal kept with metadata and config reference for retry",
        });
      }
    }
    if (releaseInstruction) {
      if (pendingInstructionReferenceIndex !== -1) {
        configText = editConfigChecked(
          configText,
          paths.configPath,
          ["instructions", pendingInstructionReferenceIndex],
          undefined,
          {
            path: ["instructions"],
            value: Array.isArray(getPath(config, ["instructions"]))
              ? (getPath(config, ["instructions"]) as unknown[]).filter(
                  (_, index) => index !== pendingInstructionReferenceIndex,
                )
              : [],
          },
        );
        configDirty = true;
      }
      delete nextManifest.instructions;
      nextManifest.pendingRemovals = nextManifest.pendingRemovals.filter((name) => name !== "instructions");
    }
    if (configDirty && !removalFailed) {
      writeFileStaged(paths.configPath, configText, input.originalConfigText, paths.stateRoot);
      undo.push(fileUndo(paths.configPath, input.originalConfigText, configText, paths.stateRoot));
    }
    const stillOwned =
      Object.keys(nextManifest.agents).length > 0 ||
      Boolean(nextManifest.pluginDigest) ||
      Boolean(nextManifest.instructions) ||
      Object.keys(nextManifest.skills).length > 0 ||
      nextManifest.pendingRemovals.length > 0;
    const deleteManifest = !stillOwned;
    if (deleteManifest) {
      const beforeManifest = input.originalManifestText;
      assertSnapshot(paths.manifestPath, beforeManifest);
      if (existsSync(paths.manifestPath)) unlinkSync(paths.manifestPath);
      if (beforeManifest !== null) {
        undo.push(() => {
          if (!existsSync(paths.manifestPath)) {
            writeFileSync(paths.manifestPath, beforeManifest, "utf8");
          }
        });
      }
      operations.push({ kind: "remove", target: toPosix(paths.manifestPath), detail: "ownership manifest removed" });
    } else {
      const text = `${JSON.stringify(nextManifest, null, 2)}\n`;
      const beforeManifest = input.originalManifestText;
      ensureStateDir(paths.stateRoot);
      writeFileStaged(paths.manifestPath, text, beforeManifest, paths.stateRoot);
      undo.push(fileUndo(paths.manifestPath, beforeManifest, text, paths.stateRoot));
      operations.push({
        kind: "update",
        target: toPosix(paths.manifestPath),
        detail: "retained ownership records kept for later retry",
      });
    }
    return finishUninstall(input, true, changed, backupDir, nextManifest.pendingRemovals);
  } catch (error) {
    const restored = rollbackOwnWrites(undo, warnings, backupDir);
    blockers.push(`uninstall aborted; ${restored ? "own unchanged writes rolled back" : "rollback incomplete (see private backups)"}: ${(error as Error).message}`);
    pushCheck(checks, "rollback", "error", (error as Error).message);
    return finishUninstall(input, false, false);
  } finally {
    lock.release();
  }
}

function finishUninstall(
  input: UninstallInput,
  applied: boolean,
  changed: boolean,
  backupDir?: string,
  failed: readonly string[] = [],
): InstallReport {
  const { request, paths, operations, blockers, warnings, retained, checks } = input;
  if (!checks.some((check) => check.id === "disk-only")) {
    pushCheck(
      checks,
      "disk-only",
      "warn",
      "these are disk checks; they do not prove the host unloaded anything in a running session",
    );
  }
  return {
    action: "uninstall",
    channel: request.channel,
    scope: paths.scope,
    packageRoot: toPosix(paths.packageRoot),
    projectRoot: toPosix(paths.projectRoot),
    configPath: toPosix(paths.configPath),
    skillsDir: request.channel === "skills" ? toPosix(paths.skillsDir) : null,
    agentsDir: toPosix(paths.agentsDir),
    instructionsPath: request.channel === "skills" ? toPosix(paths.instructionPath) : null,
    manifestPath: toPosix(paths.manifestPath),
    stateRoot: toPosix(paths.stateRoot),
    backupDir: backupDir ? toPosix(backupDir) : null,
    operations,
    checks,
    blockers,
    warnings,
    retained,
    failed: [...failed],
    ok: blockers.length === 0,
    applied,
    changed,
  };
}

export function formatInstallReport(report: InstallReport): string {
  const lines = [
    `ARS OpenCode ${report.action} — ${report.channel}/${report.scope}`,
    "",
    `package root: ${report.packageRoot}`,
    `project root: ${report.projectRoot}`,
    `config: ${report.configPath}`,
    ...(report.skillsDir ? [`skills: ${report.skillsDir}`] : []),
    `agents: ${report.agentsDir}`,
    ...(report.instructionsPath ? [`instructions: ${report.instructionsPath}`] : []),
    `state: ${report.stateRoot}`,
    "",
  ];
  for (const operation of report.operations) {
    lines.push(`[${operation.kind}] ${operation.target}: ${operation.detail}`);
  }
  if (report.blockers.length) {
    lines.push("", "Blockers:");
    for (const blocker of report.blockers) lines.push(`  - ${blocker}`);
  }
  if (report.warnings.length) {
    lines.push("", "Warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  if (report.retained.length) {
    lines.push("", "Retained (user-modified, never deleted):");
    for (const item of report.retained) lines.push(`  - ${item}`);
  }
  if (report.failed.length) {
    lines.push("", "Failed removals recorded for retry:");
    for (const item of report.failed) lines.push(`  - ${item}`);
  }
  lines.push("", "Checks:");
  for (const check of report.checks) {
    lines.push(`  [${check.status}] ${check.id}: ${check.detail}`);
  }
  lines.push(
    "",
    report.applied
      ? "Applied."
      : report.action === "check"
        ? "Read-only check; nothing was written."
        : report.ok
          ? "Preview only; nothing was written. Rerun with --apply."
          : "Nothing was written because blockers remain.",
  );
  return lines.join("\n");
}
