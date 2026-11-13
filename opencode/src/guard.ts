/**
 * OpenCode integration for the unchanged ARS write-scope policy.
 *
 * The adapter never re-implements the policy: it translates a host permission
 * evaluation into the Claude PreToolUse payload, runs
 * `scripts/ars_write_scope_guard.py`, and forwards only a `deny`. A pass-through
 * leaves the host decision untouched, so the adapter can never widen access.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  defaultTimeoutMs,
  discoverInterpreter,
  isolatedPythonEnv,
  runPythonFile,
} from "./script-runner.ts";

export type GuardState = "active" | "degraded" | "unknown";

export interface GuardEvaluation {
  action: string;
  resources: readonly string[];
  /** Trusted host agent ID, never text supplied by a model. */
  agent?: string;
}

export interface GuardDecision {
  decision: "allow" | "deny";
  reason?: string;
  /** True when the policy layer could not render a decision (pass-through). */
  degraded: boolean;
  degradedReason?: string;
}

export interface GuardStatus {
  state: GuardState;
  reason?: string;
  interpreter?: string;
  guardScript: string;
}

export interface GuardOptions {
  packageRoot: string;
  projectRoot: string;
  timeoutMs?: number;
  /** Test seam; `null` means no interpreter is available. */
  interpreter?: readonly string[] | null;
  guardScript?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

const INSPECTED_ACTIONS = new Set(["edit", "shell"]);

export function toolNameForAction(action: string): string | null {
  if (action === "edit") return "Write";
  if (action === "shell") return "Bash";
  return null;
}

export function buildGuardPayload(options: {
  action: string;
  resource: string;
  agent?: string;
  projectRoot: string;
  toolName: string;
}): Record<string, unknown> {
  const toolInput: Record<string, unknown> =
    options.toolName === "Bash"
      ? { command: options.resource }
      : { file_path: options.resource };
  const payload: Record<string, unknown> = {
    cwd: options.projectRoot,
    hook_event_name: "PreToolUse",
    tool_name: options.toolName,
    tool_input: toolInput,
  };
  if (options.agent) payload.agent_type = options.agent;
  return payload;
}

/** Parse the guard's stdout contract. Returns null for anything unexpected. */
export function parseGuardOutput(
  stdout: string,
): { deny: boolean; reason?: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const output = (parsed as { hookSpecificOutput?: unknown }).hookSpecificOutput;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  if (record.permissionDecision === "deny") {
    const reason =
      typeof record.permissionDecisionReason === "string"
        ? record.permissionDecisionReason
        : "ARS scope guard denied this operation.";
    return { deny: true, reason };
  }
  // The guard's only non-deny output is a bare pass-through. An explicit
  // "allow"/"ask" is outside the source contract and is treated as degraded.
  if (record.permissionDecision === undefined) return { deny: false };
  return null;
}

export class WriteScopeGuard {
  readonly guardScript: string;
  private readonly packageRoot: string;
  private readonly projectRoot: string;
  private readonly timeoutMs: number;
  private readonly baseEnv?: NodeJS.ProcessEnv;
  private interpreterOverride: readonly string[] | null | undefined;
  private state: GuardState = "unknown";
  private reason?: string;
  private interpreterLabel?: string;

  constructor(options: GuardOptions) {
    this.packageRoot = options.packageRoot;
    this.projectRoot = options.projectRoot;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs();
    this.interpreterOverride = options.interpreter;
    this.baseEnv = options.baseEnv;
    this.guardScript =
      options.guardScript ??
      join(options.packageRoot, "scripts", "ars_write_scope_guard.py");
  }

  status(): GuardStatus {
    return {
      state: this.state,
      reason: this.reason,
      interpreter: this.interpreterLabel,
      guardScript: this.guardScript,
    };
  }

  /** Probe the guard's prerequisites without evaluating a write. */
  async probe(): Promise<GuardStatus> {
    if (!existsSync(this.guardScript)) {
      this.markDegraded(`guard script not found at ${this.guardScript}`);
      return this.status();
    }
    const interpreter = await this.resolveInterpreter();
    if (!interpreter) {
      this.markDegraded(
        "no real Python interpreter found (tried py -3, python3, python)",
      );
      return this.status();
    }
    this.interpreterLabel = interpreter.join(" ");
    if (this.state === "unknown") {
      this.state = "active";
      this.reason = undefined;
    }
    return this.status();
  }

  /**
   * Evaluate one host permission action. Every resource is checked before the
   * caller acts; a deny anywhere wins, otherwise the host decision stands.
   */
  async evaluate(input: GuardEvaluation): Promise<GuardDecision> {
    const toolName = toolNameForAction(input.action);
    if (!toolName) return { decision: "allow", degraded: false };
    if (input.resources.length === 0) {
      this.markDegraded(
        `host reported no ${input.action} targets; scope could not be checked`,
      );
      return {
        decision: "allow",
        degraded: true,
        degradedReason: this.reason,
      };
    }

    const interpreter = await this.resolveInterpreter();
    if (!interpreter) {
      this.markDegraded(
        "no real Python interpreter found (tried py -3, python3, python)",
      );
      return {
        decision: "allow",
        degraded: true,
        degradedReason: this.reason,
      };
    }
    this.interpreterLabel = interpreter.join(" ");

    const env = isolatedPythonEnv({
      packageRoot: this.packageRoot,
      projectRoot: this.projectRoot,
      base: this.baseEnv,
    });

    let degradedReason: string | undefined;
    for (const resource of input.resources) {
      const payload = buildGuardPayload({
        action: input.action,
        resource,
        agent: input.agent,
        projectRoot: this.projectRoot,
        toolName,
      });
      const result = await runPythonFile({
        interpreter,
        script: this.guardScript,
        cwd: this.projectRoot,
        env,
        timeoutMs: this.timeoutMs,
        stdin: JSON.stringify(payload),
      });

      // The launcher relays the guard's own fail-loud advisories on stderr.
      // A guard advisory means the policy layer did not have its full inputs
      // (for example an unreadable manifest): the operation may pass through,
      // but the status must not keep reporting `active`.
      const stderr = result.stderr.trim();
      if (stderr) {
        console.warn(stderr);
        if (stderr.includes("[ARS write-scope guard]")) {
          degradedReason = `guard advisory: ${stderr}`;
        }
      }
      if (result.timedOut) {
        degradedReason = `guard timed out after ${this.timeoutMs} ms`;
        continue;
      }
      if (result.spawnError) {
        degradedReason = `guard could not start: ${result.spawnError}`;
        continue;
      }
      if (result.code !== 0) {
        degradedReason = `guard exited with status ${String(result.code)}`;
        continue;
      }
      const parsed = parseGuardOutput(result.stdout);
      if (!parsed) {
        degradedReason = "guard produced unparseable output";
        continue;
      }
      if (parsed.deny) {
        // A real deny is final even if another target degraded: the operation
        // must not proceed, and the reason is the policy's own.
        if (degradedReason) this.markDegraded(degradedReason);
        else if (this.state === "unknown") this.state = "active";
        return {
          decision: "deny",
          reason: parsed.reason,
          degraded: degradedReason !== undefined,
          degradedReason,
        };
      }
    }

    if (degradedReason) {
      this.markDegraded(degradedReason);
      return { decision: "allow", degraded: true, degradedReason };
    }
    if (this.state === "unknown") this.state = "active";
    return { decision: "allow", degraded: false };
  }

  private markDegraded(reason: string): void {
    this.state = "degraded";
    this.reason = reason;
    // One visible line per distinct degradation; the hot path stays quiet.
    if (this.lastLoggedReason !== reason) {
      this.lastLoggedReason = reason;
      console.warn(`[ARS OpenCode adapter] write-scope guard degraded: ${reason}`);
    }
  }

  private lastLoggedReason?: string;

  private async resolveInterpreter(): Promise<readonly string[] | null> {
    if (this.interpreterOverride === null) return null;
    if (this.interpreterOverride) return this.interpreterOverride;
    return discoverInterpreter({ timeoutMs: this.timeoutMs });
  }
}
