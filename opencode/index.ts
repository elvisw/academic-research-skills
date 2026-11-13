/**
 * ARS OpenCode V2 thin adapter.
 *
 * Registers the unchanged ARS skills and commands in memory, wires the ARS
 * write-scope policy into the host permission hook, and exposes the three
 * deterministic CLI wrappers plus screening dispatch as tools.
 *
 * Nothing here modifies the ARS core files or the user's config.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Plugin } from "@opencode/plugin";
import type { Skill } from "@opencode/plugin";
import {
  assertPackageRoot,
  defaultPackageRoot,
  hasPassportArgument,
  insertOptionBeforeSeparator,
  loadCatalog,
  readLogPathForPassport,
  remapMentions,
  renderCommandText,
  requirePassportPath,
  toPosix,
  tokenizeArgs,
  validateScriptInvocation,
  type Catalog,
  type CommandSource,
  type ScriptInvocation,
} from "./src/catalog.ts";
import { WriteScopeGuard } from "./src/guard.ts";
import { ModelRouter, type PreparedRoute } from "./src/models.ts";
import {
  describePlan,
  planScreening,
  runScreening,
  SCREENING_AGENT,
  type ScreeningPlan,
  type ScreeningPort,
} from "./src/screening.ts";
import {
  agentDifferences,
  formatSetupReport,
  loadNativeAgents,
  planInstallation,
  type AdapterOptions,
  type HostSnapshot,
  type PermissionRule,
} from "./src/setup.ts";
import {
  checkPythonModule,
  discoverInterpreter,
  isolatedPythonEnv,
  resetInterpreterCache,
  runPythonFile,
} from "./src/script-runner.ts";

const PLUGIN_ID = "academic-research-skills.opencode";
const SCRIPT_TIMEOUT_MS = 60_000;

const SCRIPT_TOOL_NAMES = [
  "ars_cache_invalidate",
  "ars_mark_read",
  "ars_unmark_read",
] as const;

type ScriptToolName = (typeof SCRIPT_TOOL_NAMES)[number];

interface Capabilities {
  skillTransform: boolean;
  commandTransform: boolean;
  toolTransform: boolean;
  permissionHook: boolean;
  sessionHook: boolean;
  shellHook: boolean;
}

function probeCapabilities(ctx: Plugin.Context): Capabilities {
  return {
    skillTransform: typeof ctx.skill?.transform === "function",
    commandTransform: typeof ctx.command?.transform === "function",
    toolTransform: typeof ctx.tool?.transform === "function",
    permissionHook: typeof ctx.permission?.hook === "function",
    sessionHook: typeof ctx.session?.hook === "function",
    shellHook: typeof ctx.shell?.hook === "function",
  };
}

function requireCapabilities(capabilities: Capabilities): void {
  const missing = Object.entries(capabilities)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `ARS OpenCode adapter needs @opencode/plugin 2.2.7; missing contract members: ${missing.join(", ")}. ` +
        "Registration was aborted and nothing was changed.",
    );
  }
}

function projectRootOf(ctx: Plugin.Context): string {
  const canonical = (ctx.location.project as { canonical?: string } | undefined)
    ?.canonical;
  return resolve(canonical ?? ctx.location.directory);
}

async function hostSnapshot(ctx: Plugin.Context): Promise<HostSnapshot> {
  const [agents, skills, commands, models] = await Promise.all([
    ctx.agent.list().catch(() => ({ data: [] })),
    ctx.skill.list().catch(() => ({ data: [] })),
    ctx.command.list().catch(() => ({ data: [] })),
    ctx.model.list().catch(() => ({ data: [] })),
  ]);
  return {
    agents: (agents.data ?? []).map((agent) => ({
      id: String(agent.id),
      system: agent.system,
      mode: agent.mode,
      permissions: (agent.permissions ?? []) as PermissionRule[],
      model: agent.model
        ? {
            providerID: String(agent.model.providerID),
            model: String(agent.model.id),
            ...(agent.model.variant
              ? { variant: String(agent.model.variant) }
              : {}),
          }
        : undefined,
    })),
    skills: (skills.data ?? []).map((skill) => ({
      id: String(skill.id),
      content: skill.content,
    })),
    commands: (commands.data ?? []).map((command) => ({
      name: command.name,
      description: command.description,
    })),
    models: (models.data ?? []).map((model) => ({
      providerID: String(model.providerID),
      id: String(model.id),
    })),
    capabilities: probeCapabilities(ctx),
  };
}

function stripCommandEcho(
  text: string,
  commandName: string,
): { text: string; offset: number } {
  const trimmed = text.trimStart();
  const leading = text.length - trimmed.length;
  const match = new RegExp(`^/?${commandName}(?:\\s+|$)`).exec(trimmed);
  return match
    ? { text: trimmed.slice(match[0].length), offset: leading + match[0].length }
    : { text: trimmed, offset: leading };
}

function formatRunResult(result: {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}): string {
  const lines = [`exit: ${result.code === null ? "none" : result.code}`];
  if (result.timedOut) lines.push("timed out: yes");
  if (result.spawnError) lines.push(`spawn error: ${result.spawnError}`);
  if (result.stdout.trim()) lines.push("", "stdout:", result.stdout.trimEnd());
  if (result.stderr.trim()) lines.push("", "stderr:", result.stderr.trimEnd());
  return lines.join("\n");
}

async function executeScript(options: {
  tool: ScriptToolName;
  argv: readonly string[];
  packageRoot: string;
  projectRoot: string;
}): Promise<string> {
  const scriptPath =
    options.tool === "ars_cache_invalidate"
      ? join(options.packageRoot, "scripts", "ars_cache_invalidate.py")
      : join(options.packageRoot, "scripts", "ars_mark_read.py");
  const interpreter = await discoverInterpreter({ timeoutMs: 3_000 });
  if (!interpreter) {
    throw new Error(
      "No real Python interpreter found (tried py -3, python3, python). Install Python 3 and retry; no substitution was attempted.",
    );
  }
  const env = isolatedPythonEnv({
    packageRoot: options.packageRoot,
    projectRoot: options.projectRoot,
  });
  if (options.tool !== "ars_cache_invalidate") {
    const dependency = await checkPythonModule({
      interpreter,
      module: "yaml",
      cwd: options.projectRoot,
      env,
      timeoutMs: SCRIPT_TIMEOUT_MS,
      allowUserSite: true,
    });
    if (dependency) {
      throw new Error(
        `PyYAML is required by this CLI but is not importable from the selected interpreter with user site-packages enabled (ambient PYTHONPATH is ignored): ${dependency}. Nothing was executed.`,
      );
    }
  }
  const result = await runPythonFile({
    interpreter,
    script: scriptPath,
    argv: options.argv,
    cwd: options.projectRoot,
    env,
    timeoutMs: SCRIPT_TIMEOUT_MS,
    allowUserSite: true,
  });
  return formatRunResult(result);
}

function scriptToolFor(command: CommandSource): ScriptToolName | undefined {
  const script = command.script;
  if (!script) return undefined;
  return script.tool as ScriptToolName;
}

/** Agents whose source `tools:` list is read-only must never use the CLI tool. */
const NATIVE_ARS_AGENT_IDS = [
  "research-architect-agent",
  "synthesis-agent",
  "report-compiler-agent",
  "screening-reviewer-agent",
] as const;

const NATIVE_ARS_AGENTS = new Set<string>(NATIVE_ARS_AGENT_IDS);

/**
 * The real filesystem targets a CLI wrapper can mutate, derived from the
 * validated invocation (never from model text).
 */
export function scriptMutationTargets(
  invocation: ScriptInvocation,
  passportPath?: string,
): string[] {
  if (invocation.tool === "ars_cache_invalidate") {
    const database =
      process.env.ARS_VERIFICATION_CACHE_PATH?.trim() ||
      join(homedir(), ".cache", "ars", "verification.db");
    // SQLite creates -wal/-shm sidecars next to the database in production.
    return [database, `${database}-wal`, `${database}-shm`];
  }
  const passport = passportPath ?? requirePassportPath(invocation);
  const log = readLogPathForPassport(passport);
  const slash = log.lastIndexOf("/");
  const dir = slash === -1 ? "." : log.slice(0, slash) || "/";
  const file = slash === -1 ? log : log.slice(slash + 1);
  return [log, `${dir}/.${file}.lock`];
}

/**
 * Ask the host to evaluate `edit` for every target. A native agent deny (for
 * example the read-only reviewer's `edit * -> deny`) rejects before any child
 * process starts; an `ask` follows the host's normal prompt. Targets outside
 * the project also pass the host's `external_directory` gate, matching what the
 * built-in edit tool would check.
 */
async function assertMutationAllowed(
  ctx: Plugin.Context,
  projectRoot: string,
  input: {
    sessionID: string;
    agent?: string;
    messageID?: string;
    id?: string;
  },
  targets: readonly string[],
): Promise<void> {
  if (!targets.length) {
    throw new Error("no mutation target could be derived; nothing was executed");
  }
  const source =
    input.messageID && input.id
      ? {
          source: {
            type: "tool" as const,
            messageID: input.messageID,
            id: input.id,
          },
        }
      : {};
  const agent = input.agent ? { agent: input.agent as never } : {};

  const root = resolve(projectRoot);
  const external = targets
    .map((target) => resolve(root, target))
    .filter((target) => {
      const relative = relativeTo(root, target);
      return relative === null;
    })
    .map((target) => {
      const normalized = toPosix(target);
      const slash = normalized.lastIndexOf("/");
      return slash === -1 ? "*" : `${normalized.slice(0, slash)}/*`;
    });
  if (external.length) {
    await ctx.permission.assert({
      sessionID: input.sessionID,
      ...agent,
      ...source,
      action: "external_directory",
      resources: [...new Set(external)],
    });
  }

  await ctx.permission.assert({
    sessionID: input.sessionID,
    ...agent,
    ...source,
    action: "edit",
    resources: [...targets],
  });
}

function relativeTo(root: string, target: string): string | null {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedTarget = toPosix(target);
  if (normalizedTarget === normalizedRoot) return ".";
  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget.slice(normalizedRoot.length + 1);
  }
  return null;
}

function commandNameForTool(tool: ScriptToolName): string {
  if (tool === "ars_cache_invalidate") return "ars-cache-invalidate";
  if (tool === "ars_unmark_read") return "ars-unmark-read";
  return "ars-mark-read";
}

function passportFallbackArgv(
  tool: ScriptToolName,
  argv: readonly string[],
): string[] {
  if (tool === "ars_cache_invalidate") return [...argv];
  if (hasPassportArgument(argv)) return [...argv];
  const fallback = process.env.ARS_PASSPORT_PATH?.trim();
  return fallback
    ? insertOptionBeforeSeparator(argv, "--passport-path", fallback)
    : [...argv];
}


export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const capabilities = probeCapabilities(ctx);
    requireCapabilities(capabilities);

    const options = (ctx.options ?? {}) as AdapterOptions;
    const declaredRoot = options.repoRoot
      ? resolve(options.repoRoot)
      : defaultPackageRoot();
    const packageRoot = assertPackageRoot(declaredRoot);
    const projectRoot = projectRootOf(ctx);
    const catalog: Catalog = loadCatalog(packageRoot);
    const guard = new WriteScopeGuard({
      packageRoot,
      projectRoot,
      timeoutMs: options.guard?.timeoutMs,
    });
    await guard.probe();
    const registrations: { dispose(): Promise<void> }[] = [];
    const router = new ModelRouter({
      alias: (alias) => options.models?.aliases?.[alias],
      listModels: async () =>
        (await ctx.model.list()).data.map((model) => ({
          providerID: String(model.providerID),
          id: String(model.id),
        })),
      sessionModel: async (sessionID) => {
        const session = await ctx.session.get({ sessionID });
        return session.model
          ? {
              providerID: String(session.model.providerID),
              id: String(session.model.id),
              ...(session.model.variant
                ? { variant: String(session.model.variant) }
                : {}),
            }
          : undefined;
      },
      latestUserMessage: async (sessionID) => {
        const messages = await ctx.session.context({ sessionID });
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index] as
            | {
                id?: string;
                type?: string;
                metadata?: { ars?: { routeId?: unknown } };
              }
            | undefined;
          if (message?.type !== "user" || !message.id) continue;
          return {
            id: String(message.id),
            routeId:
              typeof message.metadata?.ars?.routeId === "string"
                ? message.metadata.ars.routeId
                : undefined,
          };
        }
        return undefined;
      },
    });

    // Probe BEFORE registering, so the host inventory is the user's own state,
    // not the catalog we are about to add. A command/skill/agent collision is a
    // setup error: refusing to overwrite is better than a partial install.
    const hostBefore = await hostSnapshot(ctx);
    const report = await planInstallation({
      catalog,
      projectRoot,
      host: hostBefore,
      adapter: options,
    });
    for (const check of report.checks) {
      if (check.status !== "ok") {
        console.warn(`[ARS OpenCode adapter] ${check.id}: ${check.detail}`);
      }
    }
    const blocking = new Set([
      "host-contract",
      "agent",
      "agent-collision",
      "skill-collision",
      "command-collision",
    ]);
    if (report.checks.some((check) => check.status === "error" && blocking.has(check.id))) {
      throw new Error(
        `ARS OpenCode adapter refused to register because the installation check failed:\n\n${formatSetupReport(report)}`,
      );
    }
    const ownedCommands = new Set(
      catalog.commands.map((command) => command.name),
    );
    const ownedSkills = new Set(catalog.skills.map((skill) => skill.name));

    registrations.push(
      await ctx.skill.transform((editor) => {
        for (const skill of catalog.skills) {
          editor.add({
            id: skill.name as Skill.ID,
            name: skill.name as Skill.Name,
            description: skill.description,
            path: skill.path as Skill.Info["path"],
            content: skill.content,
            autoinvoke: true,
          });
        }
      }),
    );

    registrations.push(
      await ctx.command.transform((editor) => {
        for (const command of catalog.commands) {
          editor.add({
            name: command.name,
            description: command.description,
            execute: async ({ sessionID, prompt, delivery }) => {
              const stripped = stripCommandEcho(prompt.text ?? "", command.name);
              const args = stripped.text;
              const tool = scriptToolFor(command);
              if (tool) {
                let invocation: ScriptInvocation;
                try {
                  const raw = passportFallbackArgv(tool, tokenizeArgs(args));
                  invocation = validateScriptInvocation(tool, raw);
                  if (tool !== "ars_cache_invalidate" && !invocation.passportPath) {
                    throw new Error(
                      "no active Material Passport path was supplied. Pass `--passport-path <path>` " +
                        "or set ARS_PASSPORT_PATH; nothing was executed.",
                    );
                  }
                } catch (error) {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `ARS ${command.name}: ${(error as Error).message}`,
                  });
                  return;
                }
                let targets: string[];
                try {
                  targets = scriptMutationTargets(invocation);
                } catch (error) {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `ARS ${command.name}: ${(error as Error).message}`,
                  });
                  return;
                }
                try {
                  await assertMutationAllowed(ctx, projectRoot, { sessionID }, targets);
                } catch (error) {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `ARS ${command.name}: host permission denied ${toPosix(targets.join(", "))}: ${(error as Error).message}. Nothing was executed.`,
                  });
                  return;
                }
                const output = await executeScript({
                  tool,
                  argv: invocation.argv,
                  packageRoot,
                  projectRoot,
                });
                await ctx.session.synthetic({
                  sessionID,
                  text: `ARS ${command.name}\n${output}`,
                });
                return;
              }

              const rendered = renderCommandText({
                command,
                args,
                packageRoot,
                projectRoot,
              });
              const alias =
                command.model && command.model !== "inherit"
                  ? command.model
                  : undefined;
              let routed: PreparedRoute | undefined;
              if (alias) {
                try {
                  routed = await router.prepare(sessionID, alias);
                } catch (error) {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `ARS ${command.name}: ${(error as Error).message}`,
                  });
                  return;
                }
              }
              try {
                await ctx.session.prompt({
                  sessionID,
                  text: rendered.text,
                  files: remapMentions(
                    prompt.files,
                    prompt.text ?? "",
                    rendered.text,
                    rendered.argsOffset,
                    stripped.offset,
                  ),
                  agents: remapMentions(
                    prompt.agents,
                    prompt.text ?? "",
                    rendered.text,
                    rendered.argsOffset,
                    stripped.offset,
                  ),
                  skills: remapMentions(
                    prompt.skills,
                    prompt.text ?? "",
                    rendered.text,
                    rendered.argsOffset,
                    stripped.offset,
                  ),
                  metadata: {
                    ars: {
                      command: command.name,
                      requestedModelAlias: alias ?? "",
                      mappedModel: routed
                        ? `${routed.ref.providerID}/${routed.ref.id}`
                        : "inherit",
                      ...(routed ? { routeId: routed.routeId } : {}),
                    },
                  },
                  delivery,
                });
              } catch (error) {
                if (alias) router.clear(sessionID, routed?.routeId);
                throw error;
              }
            },
          });
        }
      }),
    );

    // Native tool for the three CLI wrappers. Shell-free, argv-only.
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "ars_run_script",
          description:
            "Run one ARS deterministic CLI wrapper (ars-mark-read, ars-unmark-read, ars-cache-invalidate) with an argv array. No shell, no expansion.",
          input: {
            type: "object",
            properties: {
              script: { type: "string", enum: [...SCRIPT_TOOL_NAMES] },
              argv: {
                type: "array",
                items: { type: "string" },
                maxItems: 64,
              },
            },
            required: ["script", "argv"],
            additionalProperties: false,
          },
          execute: async (input, context) => {
            const trustedAgent = String(context.agent);
            if (NATIVE_ARS_AGENTS.has(trustedAgent)) {
              return {
                content:
                  `ARS ars_run_script: ${trustedAgent} is a native ARS subagent limited to its source tool list and may not run this adapter tool. Nothing was executed.`,
                metadata: { status: "denied" },
              };
            }
            const value = input as {
              script?: string;
              argv?: unknown;
            };
            const tool = value.script as ScriptToolName;
            if (!SCRIPT_TOOL_NAMES.includes(tool)) {
              return {
                content: `ARS ars_run_script: unknown script ${JSON.stringify(value.script)}. Nothing was executed.`,
                metadata: { status: "rejected" },
              };
            }
            if (!Array.isArray(value.argv)) {
              return {
                content: "ARS ars_run_script: argv must be an array of strings.",
                metadata: { status: "rejected" },
              };
            }
            let invocation: ScriptInvocation;
            try {
              invocation = validateScriptInvocation(
                tool,
                passportFallbackArgv(tool, value.argv as string[]),
              );
            } catch (error) {
              return {
                content: `ARS ars_run_script: ${(error as Error).message}. Nothing was executed.`,
                metadata: { status: "rejected" },
              };
            }
            if (tool !== "ars_cache_invalidate" && !invocation.passportPath) {
              return {
                content:
                  "ARS ars_run_script: no active Material Passport path was supplied. " +
                  "Pass `--passport-path <path>` or set ARS_PASSPORT_PATH; nothing was executed.",
                metadata: { status: "blocked" },
              };
            }
            let targets: string[];
            try {
              targets = scriptMutationTargets(invocation);
            } catch (error) {
              return {
                content: `ARS ars_run_script: ${(error as Error).message}`,
                metadata: { status: "blocked" },
              };
            }
            // Host rules are checked for the real targets before any child
            // process starts. A deny rejects this call (Tool.Error).
            await assertMutationAllowed(
              ctx,
              projectRoot,
              {
                sessionID: context.sessionID,
                agent: trustedAgent,
                messageID: context.messageID,
                id: context.id,
              },
              targets,
            );
            const output = await executeScript({
              tool,
              argv: invocation.argv,
              packageRoot,
              projectRoot,
            });
            return {
              content: output,
              metadata: {
                status: "executed",
                script: tool,
                targets: targets.map(toPosix),
              },
            };
          },
        });

        editor.add({
          name: "ars_opencode_status",
          description:
            "Read-only ARS OpenCode installation check. Reports counts, effective agents/models/permissions, model mappings, guard status and collisions. Pass `agent` to get that one agent's full merge fragment; without it, no fragment is returned.",
          input: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                enum: [...NATIVE_ARS_AGENT_IDS],
                description:
                  "Return the full preview fragment for this one native agent.",
              },
            },
            additionalProperties: false,
          },
          execute: async (input) => {
            const value = input as { agent?: string };
            const agentId = value.agent?.trim() || undefined;
            if (
              agentId !== undefined &&
              !NATIVE_ARS_AGENTS.has(agentId)
            ) {
              return {
                content: `ARS status: unknown native agent ${JSON.stringify(agentId)}. Use one of ${NATIVE_ARS_AGENT_IDS.join(", ")}.`,
                metadata: { status: "rejected" },
              };
            }

            const host = await hostSnapshot(ctx);
            const report = await planInstallation({
              catalog,
              projectRoot,
              host,
              adapter: options,
              ownedCommands,
              ownedSkills,
              strictAgents: true,
            });
            const guardStatus = guard.status();
            const lines = report.checks.map(
              (check) => `[${check.status}] ${check.id}: ${check.detail}`,
            );
            const routes = router.usedRoutes();
            lines.push(
              "",
              `guard: ${guardStatus.state}${guardStatus.reason ? ` (${guardStatus.reason})` : ""}`,
              `guard script: ${toPosix(guardStatus.guardScript)}`,
              `model routing: ${router.available ? "available (experimental.model.resolve)" : "unavailable"}`,
              ...(routes.length
                ? routes.map(
                    (route) =>
                      `  last route: ${route.sessionID} alias ${route.alias} -> ${route.model}`,
                  )
                : ["  last route: none recorded"]),
              `package root: ${toPosix(packageRoot)}`,
              `project root: ${toPosix(projectRoot)}`,
              "",
              "Read-only check: this tool never writes configuration or files.",
            );

            const metadata = {
              ok: report.ok,
              checks: report.checks.length,
              guard: guardStatus.state,
              modelRouting: router.available,
              agents: [...NATIVE_ARS_AGENT_IDS],
              agent: agentId ?? null,
            };

            if (!agentId) {
              lines.push(
                "",
                "Native agents:",
                ...NATIVE_ARS_AGENT_IDS.map((id) => `  - ${id}`),
                "",
                "A single fragment for all four agents would exceed the host's tool-output limit, so it is not returned as one bundle.",
                "Call this tool once per agent with `agent=<id>` to get that agent's complete merge fragment (plugin entry + one agent).",
              );
              return { content: lines.join("\n"), metadata };
            }

            const agentsFragment = report.fragment.agents as
              | Record<string, unknown>
              | undefined;
            const entry = agentsFragment?.[agentId];
            if (entry === undefined) {
              return {
                content: `ARS status: the ${agentId} fragment could not be built from the source agent file.`,
                metadata: { status: "blocked", ...metadata },
              };
            }
            const fragment = {
              plugins: report.fragment.plugins,
              agents: { [agentId]: entry },
            };
            const entryModel = (entry as { model?: unknown }).model;
            lines.push(
              "",
              `Preview fragment for ${agentId} (merge the plugin entry and agents.${agentId} into your config):`,
              `model: ${
                entryModel === undefined
                  ? "inherit (no models.agents mapping)"
                  : JSON.stringify(entryModel)
              }`,
              "<<<ARS_FRAGMENT_JSON",
              JSON.stringify(fragment, null, 2),
              "ARS_FRAGMENT_JSON>>>",
            );
            return { content: lines.join("\n"), metadata };
          },
        });

        editor.add({
          name: "ars_screening",
          description:
            "Dispatch sr-screener emitted prompts into independent read-only reviewer sessions, validate decisions, and write a merge_decisions-compatible results file. Requests the host permission action ars_screening_dispatch before dispatch; a confirmation prompt appears only if the user's permission rules make that action ask or stricter.",
          input: {
            type: "object",
            properties: {
              stage: { type: "string", enum: ["ta", "ft"] },
              work: { type: "string" },
              emit: { type: "string" },
              out: { type: "string" },
              approve: {
                type: "boolean",
                description:
                  "Set true only after the user explicitly approved the previewed call count and models.",
              },
            },
            required: ["stage", "work", "emit"],
            additionalProperties: false,
          },
          execute: async (input, context) => {
            const trustedAgent = String(context.agent);
            if (NATIVE_ARS_AGENTS.has(trustedAgent)) {
              return {
                content:
                  `ARS screening: ${trustedAgent} is a native ARS subagent limited to its source tool list and may not dispatch screening. Nothing was dispatched.`,
                metadata: { status: "denied" },
              };
            }
            const value = input as {
              stage?: "ta" | "ft";
              work?: string;
              emit?: string;
              out?: string;
              approve?: boolean;
            };
            if (value.stage !== "ta" && value.stage !== "ft") {
              return {
                content: "ARS screening: stage must be ta or ft.",
                metadata: { status: "rejected" },
              };
            }
            if (!value.work || !value.emit) {
              return {
                content: "ARS screening: work and emit directories are required.",
                metadata: { status: "rejected" },
              };
            }
            const host = await hostSnapshot(ctx);
            const expectedReviewer = loadNativeAgents(
              packageRoot,
              options,
              host.models,
            ).agents.find((agent) => agent.id === SCREENING_AGENT);
            if (!expectedReviewer) {
              return {
                content: `ARS screening: the expected ${SCREENING_AGENT} definition could not be built from the source agent file; nothing was dispatched.`,
                metadata: { status: "blocked" },
              };
            }
            const installedReviewer = host.agents.find(
              (agent) => agent.id === SCREENING_AGENT,
            );
            if (!installedReviewer) {
              return {
                content:
                  `ARS screening: native agent ${SCREENING_AGENT} is not loaded in this host snapshot. ` +
                  `Request its fragment with ars_opencode_status agent=${SCREENING_AGENT}, merge it, reload, then retry; nothing was dispatched.`,
                metadata: { status: "blocked" },
              };
            }
            const reviewerDifferences = agentDifferences(
              expectedReviewer,
              installedReviewer,
            );
            if (reviewerDifferences.length) {
              return {
                content:
                  `ARS screening: ${SCREENING_AGENT} is installed with different ${reviewerDifferences.join(", ")}. ` +
                  "Refusing to dispatch with an unverified reviewer; regenerate and remerge its fragment, then retry. Nothing was dispatched.",
                metadata: { status: "blocked" },
              };
            }
            const workDir = resolve(value.work);
            const emitDir = resolve(value.emit);
            let plan: ScreeningPlan;
            try {
              plan = planScreening({
                stage: value.stage,
                workDir,
                emitDir,
                roleModels: options.screening?.roles,
                availableModels: (await ctx.model.list()).data.map((model) => ({
                  providerID: String(model.providerID),
                  id: String(model.id),
                })),
              });
            } catch (error) {
              return {
                content: `ARS screening: ${(error as Error).message}`,
                metadata: { status: "blocked" },
              };
            }
            const outFile = value.out
              ? resolve(value.out)
              : join(workDir, `opencode_screening_${value.stage}.json`);
            const blocked =
              plan.missingModels.length ||
              plan.missingFiles.length ||
              plan.unreadablePdfs.length;
            if (blocked) {
              return {
                content: `${describePlan(plan)}\n\nNothing was dispatched.`,
                metadata: { status: "blocked" },
              };
            }
            if (value.approve !== true) {
              return {
                content:
                  `${describePlan(plan)}\n\nNothing was dispatched. ` +
                  "Ask the user to approve this call count and these models, then call again with " +
                  "`approve: true`.",
                metadata: { status: "needs-approval" },
              };
            }

            const auditFile =
              outFile.replace(/\.json$/i, "") + ".audit.json";
            try {
              await assertMutationAllowed(
                ctx,
                projectRoot,
                {
                  sessionID: context.sessionID,
                  agent: context.agent,
                  messageID: context.messageID,
                  id: context.id,
                },
                [outFile, auditFile],
              );
            } catch (error) {
              return {
                content:
                  `ARS screening: host permission denied ${toPosix(outFile)}, ${toPosix(auditFile)}: ` +
                  `${(error as Error).message}. Nothing was dispatched.`,
                metadata: { status: "denied" },
              };
            }

            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              source: {
                type: "tool",
                messageID: context.messageID,
                id: context.id,
              },
              action: "ars_screening_dispatch",
              resources: [describePlan(plan)],
            });

            const port: ScreeningPort = {
              create: async (title) =>
                String((await ctx.session.create({ title })).id),
              switchAgent: async (sessionID, agent) => {
                await ctx.session.switchAgent({ sessionID, agent });
              },
              switchModel: async (sessionID, ref) => {
                await ctx.session.switchModel({
                  sessionID,
                  model: {
                    providerID: ref.providerID as never,
                    id: ref.model as never,
                    ...(ref.variant
                      ? { variant: ref.variant as never }
                      : {}),
                  },
                });
              },
              sessionModel: async (sessionID) => {
                const session = await ctx.session.get({ sessionID });
                return session.model
                  ? {
                      providerID: String(session.model.providerID),
                      id: String(session.model.id),
                    }
                  : undefined;
              },
              prompt: async (sessionID, text) => {
                await ctx.session.prompt({ sessionID, text, delivery: "queue" });
              },
              wait: async (sessionID) => {
                await ctx.session.wait({ sessionID });
              },
              lastAssistantText: async (sessionID) => {
                const messages = await ctx.session.context({ sessionID });
                for (let index = messages.length - 1; index >= 0; index -= 1) {
                  const message = messages[index] as
                    | { type?: string; content?: { type?: string; text?: string }[] }
                    | undefined;
                  if (message?.type !== "assistant") continue;
                  return (message.content ?? [])
                    .filter((part) => part.type === "text" && typeof part.text === "string")
                    .map((part) => part.text as string)
                    .join("");
                }
                return "";
              },
              remove: async (sessionID) => {
                await ctx.session.remove({ sessionID });
              },
            };

            const result = await runScreening({
              plan,
              workDir,
              outFile,
              port,
              approve: true,
              roleModels: options.screening?.roles,
              availableModels: (await ctx.model.list()).data.map((model) => ({
                providerID: String(model.providerID),
                id: String(model.id),
              })),
              onProgress: (message) => console.info(`[ARS screening] ${message}`),
            });

            return {
              content: [
                `ARS screening complete (${value.stage})`,
                `context: ${plan.contextID ?? "unknown"}`,
                `calls: ${result.calls}`,
                `results: ${result.results.length}`,
                `pending: ${result.pending.length}`,
                `rejected entries: ${result.rejected.length}`,
                `results file: ${toPosix(outFile)}`,
                "",
                "Next: run sr-screener/scripts/merge_decisions.py with this file and review anything listed as pending.",
              ].join("\n"),
              metadata: {
                status: "dispatched",
                pending: result.pending.length,
                results: result.results.length,
              },
            };
          },
        });
      }),
    );

    // Per-request model routing for command model aliases. If the host refuses
    // this experimental hook, aliased commands block instead of inheriting.
    try {
      registrations.push(
        await ctx.session.hook("experimental.model.resolve", async (event) => {
          await router.handle(event);
        }),
      );
    } catch (error) {
      const reason = (error as Error).message;
      router.disable(reason);
      console.warn(
        `[ARS OpenCode adapter] per-request model routing unavailable: ${reason}. Commands that declare a Claude model alias will block rather than inherit.`,
      );
    }

    // Normal completion: once the session is idle, release the route so the
    // next aliased command in the same session is not blocked forever.
    registrations.push(
      await ctx.session.hook("experimental.idle", async (event) => {
        await router.finish(String(event.sessionID));
      }),
    );

    // Failure/interruption do not reach experimental.idle. The documented
    // session execution events are the supported terminal signal for those.
    const eventAbort = new AbortController();
    const eventPump = (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [
            "session.execution.failed",
            "session.execution.interrupted",
          ],
          signal: eventAbort.signal,
        })) {
          const sessionID = (event as { data?: { sessionID?: unknown } }).data
            ?.sessionID;
          if (typeof sessionID === "string") {
            await router.finish(sessionID);
          }
        }
      } catch (error) {
        if (!eventAbort.signal.aborted) {
          console.warn(
            `[ARS OpenCode adapter] lifecycle event subscription stopped: ${(error as Error).message}`,
          );
        }
      }
    })();
    registrations.push({
      dispose: async () => {
        eventAbort.abort();
        await eventPump;
      },
    });

    // The write-scope policy: only ever add a deny, never widen access.
    registrations.push(
      await ctx.permission.hook("evaluate", async (event) => {
        if (event.action !== "edit" && event.action !== "shell") return;
        let trustedAgent: string | undefined;
        let identityError: string | undefined;
        if (event.agent !== undefined) {
          // Explicit host actor wins: during tool execution it can differ from
          // the session's selected agent.
          trustedAgent = String(event.agent);
        } else {
          try {
            const session = await ctx.session.get({
              sessionID: event.sessionID,
            });
            trustedAgent = session.agent ? String(session.agent) : undefined;
            if (!trustedAgent) {
              identityError = "the session has no recorded agent";
            }
          } catch (error) {
            identityError = `the session lookup failed: ${(error as Error).message}`;
          }
        }
        if (!trustedAgent) {
          event.effect = "deny";
          event.message =
            `ARS write-scope guard: trusted agent identity is unavailable (${identityError ?? "unknown reason"}); ` +
            "denying this operation instead of treating the actor as unscoped.";
          return;
        }
        const decision = await guard.evaluate({
          action: event.action,
          resources: event.resources,
          agent: trustedAgent,
        });
        if (decision.decision === "deny") {
          event.effect = "deny";
          event.message =
            decision.reason ?? "ARS write-scope guard denied this operation.";
        }
      }),
    );

    // Isolate ARS shell children from ambient Claude roots and stale aliases.
    registrations.push(
      await ctx.shell.hook("create.before", (event) => {
        for (const key of Object.keys(event.env)) {
          if (key.startsWith("CLAUDE_")) delete event.env[key];
        }
        event.env.ARS_PLUGIN_ROOT = packageRoot;
        event.env.ARS_PROJECT_DIR = projectRoot;
        event.env.PYTHONUTF8 = "1";
        event.env.PYTHONIOENCODING = "utf-8";
      }),
    );

    console.info(
      `[ARS OpenCode adapter] registered ${catalog.skills.length} skills, ` +
        `${catalog.commands.length} commands, ` +
        `${report.agents.length} native agent definitions; write-scope guard ${guard.status().state}; ` +
        `model routing ${router.available ? "available" : "unavailable"}`,
    );

    return async () => {
      for (const registration of registrations) {
        try {
          await registration.dispose();
        } catch {
          /* host is shutting down */
        }
      }
      resetInterpreterCache();
    };
  },
});
