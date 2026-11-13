/**
 * Installation planning and read-only verification.
 *
 * OpenCode V2 has no "add agent" API: native subagents come from configuration
 * (`agents.<id>` with `system`, `mode`, `permissions`). This module builds the
 * preview fragment for those agents and checks an installation without writing
 * anything. The user merges the fragment by hand; a collision is refused, never
 * overwritten.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  hostCompatibilityNote,
  parseFrontmatter,
  toPosix,
  type Catalog,
} from "./catalog.ts";
import { discoverInterpreter } from "./script-runner.ts";

export interface ModelRef {
  providerID: string;
  model: string;
  variant?: string;
}

export interface AdapterOptions {
  repoRoot?: string;
  models?: {
    agents?: Record<string, ModelRef>;
    aliases?: Record<string, ModelRef>;
  };
  screening?: {
    roles?: Record<string, ModelRef>;
    modelsFile?: string;
  };
  guard?: { timeoutMs?: number };
}

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface NativeAgentSpec {
  id: string;
  description: string;
  mode: "subagent";
  system: string;
  model?: ModelRef;
  sourceModel?: string;
  permissions: PermissionRule[];
}

export interface ModelInfoLike {
  providerID: string;
  id: string;
}

export interface HostSnapshot {
  agents: readonly {
    id: string;
    system?: string;
    mode?: "subagent" | "primary" | "all";
    permissions?: readonly PermissionRule[];
    model?: ModelRef;
  }[];
  skills: readonly { id: string; content?: string }[];
  commands: readonly { name: string; description?: string }[];
  models: readonly ModelInfoLike[];
  /**
   * Set when `model.list()` failed. `models` is then an empty placeholder, not
   * an authoritative "this host offers nothing" answer, so callers must block
   * availability checks instead of reporting unoffered mappings.
   */
  modelsUnavailable?: string;
  capabilities: {
    skillTransform: boolean;
    commandTransform: boolean;
    toolTransform: boolean;
    permissionHook: boolean;
    sessionHook: boolean;
    shellHook: boolean;
  };
}

export type CheckStatus = "ok" | "warn" | "error";

export interface InstallationCheck {
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface SetupReport {
  checks: InstallationCheck[];
  agents: NativeAgentSpec[];
  fragment: Record<string, unknown>;
  fragmentText: string;
  ok: boolean;
}

const AGENT_FILES = [
  "agents/research_architect_agent.md",
  "agents/synthesis_agent.md",
  "agents/report_compiler_agent.md",
  "agents/screening_reviewer_agent.md",
] as const;

/** The four plugin-exposed agents as a source tool list. */
const TOOL_ACTIONS: Record<string, string[]> = {
  read: ["read"],
  grep: ["grep"],
  glob: ["glob"],
  write: ["edit"],
  edit: ["edit"],
  multiedit: ["edit"],
  notebookedit: ["edit"],
  bash: ["shell"],
  shell: ["shell"],
  webfetch: ["webfetch"],
  websearch: ["websearch"],
  task: ["subagent"],
  agent: ["subagent"],
  skill: ["skill"],
};

/** Capability actions the source agents do not list, denied explicitly. */
const HIGH_RISK_ACTIONS = ["shell", "subagent", "webfetch", "websearch", "skill"];

const SOURCE_NAMES_TO_NATIVE: Record<string, string> = {
  screening_reviewer_agent: "screening-reviewer-agent",
  "academic-research-skills:screening_reviewer_agent":
    "screening-reviewer-agent",
  "academic-research-skills:screening-reviewer-agent":
    "screening-reviewer-agent",
};

/** Map any accepted sr-screener reviewer name to the native agent ID. */
export function bareReviewerAgentType(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "screening-reviewer-agent";
  return SOURCE_NAMES_TO_NATIVE[raw] ?? raw;
}

function normalizeSystem(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/** Compare two source texts for installation purposes (line endings only). */
export function equivalentText(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return normalizeSystem(a) === normalizeSystem(b);
}

function parseTools(value: string | undefined): Set<string> {
  const tools = new Set<string>();
  for (const raw of (value ?? "").split(/[,\s]+/)) {
    const name = raw.trim().toLowerCase();
    if (name) tools.add(name);
  }
  return tools;
}

/** Derive an OpenCode permission matrix from an agent's source `tools:` list. */
export function permissionsForTools(tools: ReadonlySet<string>): PermissionRule[] {
  const actions = new Set<string>();
  for (const tool of tools) {
    for (const action of TOOL_ACTIONS[tool] ?? []) actions.add(action);
  }
  const rules: PermissionRule[] = [];
  const seen = new Set<string>();
  const add = (rule: PermissionRule) => {
    const key = `${rule.action}|${rule.resource}|${rule.effect}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push(rule);
  };
  for (const action of actions) add({ action, resource: "*", effect: "allow" });
  for (const action of HIGH_RISK_ACTIONS) {
    if (!actions.has(action)) add({ action, resource: "*", effect: "deny" });
  }
  // Read-only reviewers must not mutate. The source has no Write/Edit tool.
  if (!actions.has("edit")) add({ action: "edit", resource: "*", effect: "deny" });
  return rules;
}

const PHASE_SCOPED_AGENTS = new Set([
  "research-architect-agent",
  "synthesis-agent",
]);

function agentHostNote(agentId: string): string {
  if (agentId === "screening-reviewer-agent") {
    return [
      "## OpenCode host note",
      "",
      "You are read-only in this host: the `read` and `grep` tools only. Never write, edit, patch, or run shell commands. Each call is a fresh session and cannot see any other reviewer's decisions.",
    ].join("\n");
  }
  if (PHASE_SCOPED_AGENTS.has(agentId)) {
    return [
      "## OpenCode host note",
      "",
      "Write only inside the phase directory this role owns. The host permission layer enforces the same scope; a denial is final. If you need a downstream deliverable, return control to the caller instead of writing it.",
    ].join("\n");
  }
  // report-compiler-agent is a Bucket B role: it is not in the phase-scope
  // manifest, so do not add a phase restriction the source role does not have.
  return [
    "## OpenCode host note",
    "",
    "Use only the tools granted by this host. The host permission layer enforces configured permissions; a denial is final. Do not claim to have run tools or audits that this host did not provide.",
  ].join("\n");
}

/** The portable compatibility note appended to every native agent. */
export function agentCompatibilityNote(packageRoot: string): string {
  return hostCompatibilityNote(packageRoot);
}

/**
 * The pre-portability template embedded the supplied project root. It is only
 * used to recognise a verified legacy install before `--adopt-legacy` takes
 * ownership; new fragments never contain a project path.
 */
export function legacyAgentSystem(
  packageRoot: string,
  projectRoot: string,
  portableSystem: string,
): string {
  const portable = agentCompatibilityNote(packageRoot);
  const legacy = hostCompatibilityNote(packageRoot, projectRoot);
  return portableSystem.includes(portable)
    ? portableSystem.replace(portable, legacy)
    : `${portableSystem}\n\n${legacy}`;
}

export function loadNativeAgents(
  packageRoot: string,
  options: AdapterOptions,
  availableModels: readonly ModelInfoLike[],
  behaviour: { validateModels?: boolean } = {},
): { agents: NativeAgentSpec[]; problems: string[]; warnings: string[] } {
  const validateModels = behaviour.validateModels ?? true;
  const agents: NativeAgentSpec[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const models = options.models ?? {};

  for (const relative of AGENT_FILES) {
    const path = join(packageRoot, relative);
    if (!existsSync(path)) {
      problems.push(`agent source missing: ${toPosix(relative)}`);
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
    const id = frontmatter.name;
    if (!id) {
      problems.push(`${relative} has no frontmatter name`);
      continue;
    }
    const tools = parseTools(frontmatter.tools);
    const system = [
      body,
      agentHostNote(id),
      agentCompatibilityNote(packageRoot),
    ].join("\n\n");
    const sourceModel = frontmatter.model;
    let model: ModelRef | undefined;
    if (models.agents?.[id]) {
      model = models.agents[id];
      if (validateModels && !modelExists(model, availableModels)) {
        problems.push(
          `models.agents.${id} names ${model.providerID}/${model.model}, which this host does not offer`,
        );
      }
    } else if (sourceModel && sourceModel !== "inherit") {
      const alias = models.aliases?.[sourceModel];
      if (alias) {
        if (validateModels && !modelExists(alias, availableModels)) {
          problems.push(
            `models.aliases.${sourceModel} names ${alias.providerID}/${alias.model}, which this host does not offer`,
          );
        } else {
          model = alias;
        }
      } else {
        problems.push(
          `agent ${id} asks for model alias ${JSON.stringify(sourceModel)}; add models.aliases.${sourceModel} before using it`,
        );
      }
    }
    agents.push({
      id,
      description: frontmatter.description ?? `ARS agent: ${id}`,
      mode: "subagent",
      system,
      model,
      sourceModel,
      permissions: permissionsForTools(tools),
    });
  }
  return { agents, problems, warnings };
}

export function modelExists(
  ref: ModelRef,
  models: readonly ModelInfoLike[],
): boolean {
  return models.some(
    (model) => model.providerID === ref.providerID && model.id === ref.model,
  );
}

export function sameModel(
  a: ModelRef | undefined,
  b: ModelRef | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.providerID === b.providerID &&
    a.model === b.model &&
    (a.variant ?? "") === (b.variant ?? "")
  );
}

export function samePermissions(
  expected: readonly PermissionRule[] | undefined,
  effective: readonly PermissionRule[] | undefined,
): boolean {
  if (expected === undefined || effective === undefined) {
    return expected === effective;
  }
  if (expected.length === 0) return true;
  if (expected.length > effective.length) return false;
  // Real OpenCode 2.2.7 does not keep agent rules as a simple suffix: it
  // prepends its base policy (`*/* allow` plus the `*.env` read rules) and
  // appends host-specific rules such as `browser` and `skill/browser`. The
  // expected block must appear CONTIGUOUSLY somewhere in the effective set;
  // arbitrary subsequence matching would let an extra interleaved rule override
  // an expected deny. Missing or altered rules inside the block still fail.
  const matches = (rule: PermissionRule, candidate: PermissionRule | undefined) =>
    candidate !== undefined &&
    rule.action === candidate.action &&
    rule.resource === candidate.resource &&
    rule.effect === candidate.effect;
  const denied = expected.filter((rule) => rule.effect === "deny");
  for (let start = 0; start <= effective.length - expected.length; start += 1) {
    const block = expected.every((rule, index) =>
      matches(rule, effective[start + index]),
    );
    if (!block) continue;
    // Host rules appended AFTER the block win under last-match semantics. A
    // trailing allow/ask for an action the expected block denies would weaken
    // that deny (including a scoped resource or a wildcard action). A trailing
    // deny only narrows, so the real host suffixes (`browser`, `skill/browser`
    // denies) remain valid.
    const tail = effective.slice(start + expected.length);
    const weakened = tail.some((rule) => {
      if (rule.effect !== "allow" && rule.effect !== "ask") return false;
      return denied.some(
        (deny) =>
          rule.action === "*" ||
          deny.action === "*" ||
          rule.action === deny.action,
      );
    });
    return !weakened;
  }
  return false;
}

function readConfigCandidates(projectRoot: string): string[] {
  const home = homedir();
  const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
  const candidates = [
    join(configHome, "opencode", "opencode.json"),
    join(configHome, "opencode", "opencode.jsonc"),
    join(projectRoot, "opencode.json"),
    join(projectRoot, "opencode.jsonc"),
    join(projectRoot, ".opencode", "opencode.json"),
    join(projectRoot, ".opencode", "opencode.jsonc"),
  ];
  return candidates.filter((path) => existsSync(path));
}

function pluginPackagePath(packageRoot: string): string {
  const local = join(packageRoot, "opencode");
  return existsSync(join(local, "package.json"))
    ? resolve(local)
    : "academic-research-skills-opencode";
}

function configMentionsPlugin(path: string, needle: string): boolean {
  try {
    const text = readFileSync(path, "utf8");
    const escaped = JSON.stringify(needle).slice(1, -1);
    return (
      text.includes(needle) ||
      text.includes(toPosix(needle)) ||
      text.includes(escaped)
    );
  } catch {
    return false;
  }
}

/** Build the preview fragment and run every read-only installation check. */
export function agentDifferences(
  expected: NativeAgentSpec,
  existing: HostSnapshot["agents"][number],
): string[] {
  const differences: string[] = [];
  if (!equivalentText(existing.system, expected.system)) differences.push("system");
  if (existing.mode !== undefined && existing.mode !== expected.mode) {
    differences.push(`mode (${existing.mode})`);
  }
  if (
    existing.permissions !== undefined &&
    !samePermissions(expected.permissions, existing.permissions)
  ) {
    differences.push("permissions");
  }
  if (expected.model && !existing.model) {
    differences.push(
      `model (expected ${expected.model.providerID}/${expected.model.model}, none set)`,
    );
  } else if (
    expected.model &&
    existing.model &&
    !sameModel(existing.model, expected.model)
  ) {
    differences.push(
      `model (${existing.model.providerID}/${existing.model.model})`,
    );
  }
  return differences;
}

export async function planInstallation(options: {
  catalog: Catalog;
  projectRoot: string;
  host: HostSnapshot;
  adapter: AdapterOptions;
  /** Commands this adapter instance registered (ownership evidence). */
  ownedCommands?: ReadonlySet<string>;
  /** Skills this adapter instance registered (ownership evidence). */
  ownedSkills?: ReadonlySet<string>;
  /** Escalate "agent not installed" from a warning to an error (status tool). */
  strictAgents?: boolean;
}): Promise<SetupReport> {
  const { catalog, projectRoot, host, adapter } = options;
  const packageRoot = catalog.packageRoot;
  const checks: InstallationCheck[] = [];
  const push = (id: string, status: CheckStatus, detail: string) =>
    checks.push({ id, status, detail });

  const capabilities = host.capabilities;
  const missing = Object.entries(capabilities)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (missing.length) {
    push(
      "host-contract",
      "error",
      `required @opencode/plugin contract members are missing: ${missing.join(", ")}. Pin @opencode/plugin 2.2.7.`,
    );
  } else {
    push("host-contract", "ok", "@opencode/plugin 2.2.7 contract available");
  }

  const packagePath = pluginPackagePath(packageRoot);
  const configs = readConfigCandidates(projectRoot);
  const registeredConfigs = configs.filter(
    (path) =>
      configMentionsPlugin(path, packagePath) ||
      configMentionsPlugin(path, "academic-research-skills-opencode"),
  );
  const pluginRegistered = registeredConfigs.length > 0;

  const { agents, problems, warnings } = loadNativeAgents(
    packageRoot,
    adapter,
    host.models,
  );
  for (const problem of problems) push("agent", "error", problem);
  for (const warning of warnings) push("agent-model", "warn", warning);

  const agentsById = new Map(host.agents.map((agent) => [agent.id, agent]));
  for (const agent of agents) {
    const existing = agentsById.get(agent.id);
    if (existing === undefined) {
      push(
        "agent",
        options.strictAgents ? "error" : "warn",
        pluginRegistered
          ? `agent ${agent.id} is not loaded in this host snapshot yet; run ars_opencode_status to verify the merged fragment`
          : `agent ${agent.id} is not installed yet; merge the preview fragment after registration`,
      );
      continue;
    }
    const differences = agentDifferences(agent, existing);
    if (differences.length) {
      push(
        "agent-collision",
        "error",
        `agent ${agent.id} is installed with different ${differences.join(", ")}; refusing to overwrite. Rename it or merge the fragment manually.`,
      );
    } else {
      push(
        "agent-collision",
        "ok",
        `${agent.id} is installed with the expected instructions, mode and permissions`,
      );
    }
  }

  // Skill collisions: same ID, different bytes means a user-owned skill.
  const skillsById = new Map(host.skills.map((skill) => [skill.id, skill.content]));
  for (const skill of catalog.skills) {
    const existing = skillsById.get(skill.name);
    if (existing === undefined) continue;
    if (normalizeSystem(existing) === normalizeSystem(skill.content)) {
      push("skill-collision", "ok", `skill ${skill.name} is already installed identically`);
    } else {
      push(
        "skill-collision",
        "error",
        `skill ${skill.name} already exists with different content; refusing to overwrite`,
      );
    }
  }

  // Command identity: a description match is not proof. Only a command this
  // adapter instance registered is ours; anything else is a collision.
  const ownedCommands = options.ownedCommands ?? new Set<string>();
  const commandNames = new Map(
    host.commands.map((command) => [command.name, command.description]),
  );
  for (const command of catalog.commands) {
    if (!commandNames.has(command.name)) continue;
    const existing = commandNames.get(command.name);
    if (!ownedCommands.has(command.name)) {
      push(
        "command-collision",
        "error",
        `command ${command.name} already exists outside this adapter; ownership cannot be proven, refusing to overwrite`,
      );
      continue;
    }
    if (existing === command.description) {
      push(
        "command-collision",
        "ok",
        `command ${command.name} is owned by this adapter with the expected description`,
      );
    } else {
      push(
        "command-collision",
        "error",
        `command ${command.name} is owned by this adapter but its description changed; refusing to claim it`,
      );
    }
  }
  push(
    "catalog",
    "ok",
    `${catalog.skills.length} skills, ${catalog.commands.length} commands, ${agents.length} native agents planned`,
  );

  // Command model aliases: every alias a command declares must be mapped.
  const aliases = new Set(
    catalog.commands
      .map((command) => command.model)
      .filter((model): model is string => Boolean(model && model !== "inherit")),
  );
  for (const alias of aliases) {
    const mapped = adapter.models?.aliases?.[alias];
    if (!mapped) {
      push(
        "model-alias",
        "error",
        `command alias ${JSON.stringify(alias)} has no OpenCode mapping; affected commands are blocked until models.aliases.${alias} is configured`,
      );
    } else if (!modelExists(mapped, host.models)) {
      push(
        "model-alias",
        "error",
        `command alias ${JSON.stringify(alias)} maps to ${mapped.providerID}/${mapped.model}, which this host does not offer; affected commands are blocked`,
      );
    } else {
      push(
        "model-alias",
        "ok",
        `command alias ${JSON.stringify(alias)} -> ${mapped.providerID}/${mapped.model}`,
      );
    }
  }

  const interpreter = await discoverInterpreter({
    timeoutMs: adapter.guard?.timeoutMs ?? 3_000,
  });
  if (!interpreter) {
    push(
      "write-scope-guard",
      "warn",
      "no real Python interpreter found; the write-scope guard will pass through and report itself degraded",
    );
  } else if (
    !existsSync(join(packageRoot, "scripts", "ars_write_scope_guard.py"))
  ) {
    push(
      "write-scope-guard",
      "warn",
      "scripts/ars_write_scope_guard.py is missing; the guard will pass through and report itself degraded",
    );
  } else {
    push(
      "write-scope-guard",
      "ok",
      `guard interpreter: ${interpreter.join(" ")}`,
    );
  }

  if (registeredConfigs.length) {
    push(
      "registration",
      "ok",
      `plugin entry found in ${registeredConfigs.map(toPosix).join(", ")}`,
    );
  } else {
    push(
      "registration",
      "warn",
      `no config under ${toPosix(projectRoot)} or the global config lists ${toPosix(packagePath)}; install it with the preview fragment`,
    );
  }

  const fragment: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    plugins: [
      {
        package: toPosix(packagePath),
        options: {
          repoRoot: toPosix(packageRoot),
          ...(adapter.models ? { models: adapter.models } : {}),
          ...(adapter.screening ? { screening: adapter.screening } : {}),
          ...(adapter.guard ? { guard: adapter.guard } : {}),
        },
      },
    ],
    agents: Object.fromEntries(
      agents.map((agent) => [
        agent.id,
        {
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
        },
      ]),
    ),
  };

  return {
    checks,
    agents,
    fragment,
    fragmentText: `${JSON.stringify(fragment, null, 2)}\n`,
    ok: checks.every((check) => check.status !== "error"),
  };
}

export function formatSetupReport(report: SetupReport): string {
  const lines = ["ARS OpenCode installation check", ""];
  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.id}: ${check.detail}`);
  }
  lines.push("", "Preview fragment (merge manually; never overwritten):", "");
  lines.push(report.fragmentText.trimEnd());
  return lines.join("\n");
}
