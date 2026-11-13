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
  legacyAgentSystem,
  loadNativeAgents,
  modelExists,
  type AdapterOptions,
  type InstallationCheck,
  type ModelRef,
  type NativeAgentSpec,
} from "./setup.ts";
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
  apply?: boolean;
  adoptLegacy?: boolean;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Test-only fault injection; never used by the CLI. */
  testHooks?: { failAt?: "config" | "instructions" | "manifest" | "skills" | "removal" };
}

export type OperationKind =
  | "create"
  | "update"
  | "remove"
  | "keep"
  | "reuse"
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
  instructionPath: string;
  instructionConfigValue: string;
  stateRoot: string;
  manifestPath: string;
  home: string;
}

export class InstallError extends Error {}

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

function scanManifests(stateRoot: string): InstallManifest[] {
  if (!existsSync(stateRoot)) return [];
  const found: InstallManifest[] = [];
  for (const file of readdirSync(stateRoot)) {
    if (!/^manifest-.*\.json$/.test(file)) continue;
    try {
      const manifest = readManifestFile(join(stateRoot, file));
      if (manifest) found.push(manifest);
    } catch {
      // A malformed manifest is reported by the specific path, not skipped.
    }
  }
  return found;
}

export function resolveScope(request: InstallRequest, packageRoot: string): ScopePaths {
  const env = request.env ?? process.env;
  const home = resolveHome(request);
  const projectRoot = resolve(request.projectRoot);
  const stateRoot = stateRootFor(home, env);

  let scope = request.scope;
  if (!scope) {
    if (request.action === "update" || request.action === "uninstall") {
      const matches = scanManifests(stateRoot).filter(
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
  return existsSync(path) ? readFileSync(path, "utf8") : null;
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
      } else if (installed && entry.isSymbolicLink()) {
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

export function parseModelsArgument(
  raw: string | undefined,
  cwd: string,
): AdapterOptions["models"] | undefined {
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
    throw new InstallError("--models must be an object with optional `agents` and `aliases`");
  }
  const allowed = new Set(["agents", "aliases"]);
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      throw new InstallError(`--models does not accept ${JSON.stringify(key)}; use agents or aliases`);
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
      if (variant !== undefined && typeof variant !== "string") {
        throw new InstallError(`--models.${label}.${name}.variant must be a string`);
      }
      refs[name] = {
        providerID: providerID.trim(),
        model: model.trim(),
        ...(variant ? { variant } : {}),
      };
    }
    return refs;
  };
  const record = parsed as Record<string, unknown>;
  const models: AdapterOptions["models"] = {};
  if (record.agents !== undefined) models.agents = checkRefs(record.agents, "agents");
  if (record.aliases !== undefined) models.aliases = checkRefs(record.aliases, "aliases");
  return models;
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
): Record<string, unknown> {
  return {
    package: toPosix(packagePath),
    options: {
      ...persistedOptions,
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

/** Persisted plugin options are the default when --models is not repeated. */
function modelsFromPluginEntry(entry: unknown): AdapterOptions["models"] | undefined {
  const value = pluginOptionsFromEntry(entry).models;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const read = (key: "agents" | "aliases"): Record<string, ModelRef> | undefined => {
    const refs = record[key];
    if (!refs || typeof refs !== "object" || Array.isArray(refs)) return undefined;
    const output: Record<string, ModelRef> = {};
    for (const [name, ref] of Object.entries(refs as Record<string, unknown>)) {
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
  };
  const agents = read("agents");
  const aliases = read("aliases");
  return agents || aliases ? { ...(agents ? { agents } : {}), ...(aliases ? { aliases } : {}) } : undefined;
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
  desiredAgents: NativeAgentSpec[];
  skillSources: SkillSource[];
  state: ApplyState;
  nextAgents: Record<string, InstallManifestEntry>;
}

function planAgentEntries(plan: InstallPlan): void {
  const { request, paths, packageRoot, projectRoot, manifest, desiredAgents, state } = plan;
  const agentsNode = getPath(plan.currentConfig, ["agents"]);
  const currentAgents =
    agentsNode && typeof agentsNode === "object" && !Array.isArray(agentsNode)
      ? (agentsNode as Record<string, unknown>)
      : {};

  for (const agent of desiredAgents) {
    const desiredValue = agentConfigValue(agent);
    const desiredDigest = digestValue(desiredValue);
    const current = currentAgents[agent.id];
    const owned = manifest?.agents[agent.id];
    if (current === undefined) {
      state.configText = editConfigChecked(state.configText, paths.configPath, ["agents", agent.id], desiredValue);
      state.configDirty = true;
      plan.nextAgents[agent.id] = { digest: desiredDigest };
      state.operations.push({
        kind: owned ? "update" : "create",
        target: `agents.${agent.id}`,
        detail: "portable native agent configuration",
      });
      continue;
    }
    if (owned?.retained) {
      // A previously retained user edit keeps its record on every retry; it is
      // not reclassified as an unowned collision.
      plan.nextAgents[agent.id] = { digest: digestValue(current), retained: true };
      state.retained.push(`agents.${agent.id}`);
      state.operations.push({
        kind: "retain",
        target: `agents.${agent.id}`,
        detail: "previously retained user edit; left untouched and still recorded",
      });
      continue;
    }
    if (owned && !owned.retained) {
      if (equivalentConfigValue(current, desiredValue)) {
        plan.nextAgents[agent.id] = { digest: desiredDigest };
        state.operations.push({ kind: "keep", target: `agents.${agent.id}`, detail: "already current" });
      } else if (digestValue(current) === owned.digest) {
        state.configText = editConfigChecked(state.configText, paths.configPath, ["agents", agent.id], desiredValue);
        state.configDirty = true;
        plan.nextAgents[agent.id] = { digest: desiredDigest };
        state.operations.push({
          kind: "update",
          target: `agents.${agent.id}`,
          detail: "owned entry updated to the current source",
        });
      } else {
        plan.nextAgents[agent.id] = { digest: digestValue(current), retained: true };
        state.retained.push(`agents.${agent.id}`);
        state.operations.push({
          kind: "retain",
          target: `agents.${agent.id}`,
          detail: "user-modified after installation; left untouched and still recorded",
        });
      }
      continue;
    }
    if (equivalentConfigValue(current, desiredValue)) {
      state.operations.push({
        kind: "reuse",
        target: `agents.${agent.id}`,
        detail: "identical pre-existing entry reused without claiming ownership",
      });
      continue;
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
      continue;
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
}

function planPluginEntry(plan: InstallPlan): void {
  const { request, paths, packageRoot, manifest, models, state } = plan;
  const packagePath = pluginPackagePath(packageRoot);
  const desiredPlugin = pluginConfigValue(
    packagePath,
    packageRoot,
    models,
    plan.persistedPluginOptions,
  );
  const desiredDigest = digestValue(desiredPlugin);
  const plugins = getPath(plan.currentConfig, ["plugins"]);
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

  const instructions = getPath(plan.currentConfig, ["instructions"]);
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
    const alreadyIdentical =
      existsSync(target) && skillTreeDigest(target) === source.digest;
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
    pendingRemovals: manifest?.pendingRemovals ?? [],
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
  blockers: string[];
  warnings: string[];
  operations: InstallOperation[];
}): {
  models: AdapterOptions["models"] | undefined;
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
    blockers,
    warnings,
    operations,
  } = input;
  const models =
    request.channel === "plugin"
      ? mergeModels(persistedModels, request.models)
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
  }

  return { models, desiredAgents, skillSources };
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
  if (request.models && request.channel === "skills") {
    throw new InstallError(
      "the skills channel has no plugin options, so --models is not supported; " +
        "the reviewer keeps its source `inherit` model. Install the plugin channel to configure model mappings.",
    );
  }

  const paths = resolveScope(request, packageRoot);
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

  const currentConfig = parseConfig(configText, paths.configPath);
  const existingPlugin = findPluginIndex(
    getPath(currentConfig, ["plugins"]),
    pluginPackagePath(packageRoot),
    paths.projectRoot,
  );
  const persistedPluginOptions = pluginOptionsFromEntry(existingPlugin?.value);
  const persistedModels = modelsFromPluginEntry(existingPlugin?.value);

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

  const { models, desiredAgents, skillSources } = inspectChannelSources({
    request,
    paths,
    packageRoot,
    projectRoot,
    env,
    catalog,
    persistedModels,
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
  state.backupTargets.push(paths.manifestPath);

  const changed =
    state.configDirty ||
    state.instructionWrite ||
    state.skillWrites.length > 0 ||
    state.skillRemoves.length > 0 ||
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
        `another ARS installation holds ${toPosix(path)}; retry after it finishes`,
      );
    }
    try {
      // Re-read: another waiter may have replaced the stale handle meanwhile.
      if (readFileSync(path, "utf8").trim() === observed) unlinkSync(path);
    } catch {
      // Another process may have taken it over.
    }
    write();
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
            if (skillTreeDigest(write.target) !== writtenDigest) return;
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

    if (request.testHooks?.failAt === "config") {
      throw new InstallError("test-injected configuration write failure");
    }
    if (state.configDirty) {
      writeFileStaged(paths.configPath, state.configText, input.originalConfigText, paths.stateRoot);
      undo.push(fileUndo(paths.configPath, input.originalConfigText, state.configText, paths.stateRoot));
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
  for (const agent of desiredAgents) {
    const current = installedAgents[agent.id];
    if (current === undefined) {
      pushCheck(checks, `agent:${agent.id}`, "warn", "not present in the configuration on disk");
      continue;
    }
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
    pushCheck(
      checks,
      `agent:${agent.id}`,
      differences.length ? "warn" : "ok",
      differences.length
        ? `on disk with different ${differences.join(", ")}`
        : "on disk with the expected instructions, mode, permissions and model",
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

  const agents = getPath(config, ["agents"]);
  const agentRecord =
    agents && typeof agents === "object" && !Array.isArray(agents)
      ? (agents as Record<string, unknown>)
      : {};
  for (const [id, owned] of Object.entries(manifest.agents)) {
    const current = agentRecord[id];
    if (current === undefined) {
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
      warnings.push(
        "configuration references were left in place because at least one skill removal failed; retry after fixing the cause",
      );
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
