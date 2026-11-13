/**
 * Per-invocation model routing for commands whose source declares a Claude
 * alias (`model: sonnet` / `model: opus`).
 *
 * OpenCode's `session.prompt` has no model field, and the 2.2.7
 * `experimental.model.resolve` event carries no message ID. The adapter tags
 * the admitted prompt with a route ID, then correlates each primary request
 * with the latest user message read through `session.context`. This keeps the
 * alias for tool continuations (the same user message stays latest) and refuses
 * to spend a route on an unrelated prompt. If a route cannot be correlated, the
 * request is blocked visibly instead of inheriting silently.
 */
import type { ModelRef } from "./setup.ts";

export interface HostModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface RouterEvent {
  readonly sessionID: string;
  readonly kind: "primary" | "compaction" | "title" | "generate" | string;
  model: HostModelRef;
}

export interface PreparedRoute {
  ref: HostModelRef;
  routeId: string;
}

export interface RouterMessage {
  id: string;
  routeId?: string;
}

export interface RouterDeps {
  alias(alias: string): ModelRef | undefined;
  listModels(): Promise<readonly { providerID: string; id: string }[]>;
  sessionModel(sessionID: string): Promise<HostModelRef | undefined>;
  /** Latest user message of the session, with the ARS route tag if present. */
  latestUserMessage(sessionID: string): Promise<RouterMessage | undefined>;
}

interface Route {
  id: string;
  ref: HostModelRef;
  alias: string;
  applied: boolean;
}

export class ModelRouter {
  private readonly deps: RouterDeps;
  private readonly routes = new Map<string, Route>();
  private readonly reserved = new Set<string>();
  private readonly used = new Map<
    string,
    { ref: HostModelRef; alias: string }
  >();
  private unavailable?: string;
  private counter = 0;

  constructor(deps: RouterDeps) {
    this.deps = deps;
  }

  /** Called when the host refuses to register the resolve hook. */
  disable(reason: string): void {
    this.unavailable = reason;
  }

  get available(): boolean {
    return this.unavailable === undefined;
  }

  /**
   * Validate a mapping before any prompt is admitted. A missing mapping, an
   * unavailable model, or a provider change the hook cannot make all throw an
   * actionable error; none of them falls back to silent inheritance.
   *
   * One command route per session is supported. A second concurrent command in
   * the same session is blocked instead of relying on queue order.
   */
  async prepare(
    sessionID: string,
    alias: string,
  ): Promise<PreparedRoute> {
    if (this.unavailable) {
      throw new Error(
        `this host cannot route command model alias ${JSON.stringify(alias)} per request: ${this.unavailable}. ` +
          "Configure no alias for this command or switch the session model explicitly.",
      );
    }
    if (this.routes.has(sessionID) || this.reserved.has(sessionID)) {
      throw new Error(
        "another ARS command is already waiting for its first model request in this session. " +
          "Wait for it to finish or run this command in a new session; the command was not dispatched.",
      );
    }
    // Reserve BEFORE the first await so two simultaneous prepares cannot both
    // pass the check and overwrite each other's route.
    this.reserved.add(sessionID);
    try {
      const mapped = this.deps.alias(alias);
      if (!mapped) {
        throw new Error(
          `command model alias ${JSON.stringify(alias)} has no OpenCode mapping. ` +
            `Add models.aliases.${alias} to the plugin options; the command was not dispatched.`,
        );
      }
      const models = await this.deps.listModels();
      if (
        !models.some(
          (model) =>
            model.providerID === mapped.providerID && model.id === mapped.model,
        )
      ) {
        throw new Error(
          `models.aliases.${alias} names ${mapped.providerID}/${mapped.model}, which this host does not offer; the command was not dispatched.`,
        );
      }
      const current = await this.deps.sessionModel(sessionID);
      if (!current) {
        throw new Error(
          `the session has no selected model, so the adapter cannot verify a same-provider route for alias ${JSON.stringify(alias)}; select a model first.`,
        );
      }
      if (current.providerID !== mapped.providerID) {
        throw new Error(
          `alias ${JSON.stringify(alias)} maps to provider ${mapped.providerID} but this session uses ${current.providerID}. ` +
            "OpenCode can only redirect a request within the selected provider; switch the session model or map the alias on the current provider. The command was not dispatched.",
        );
      }
      const ref: HostModelRef = {
        providerID: mapped.providerID,
        id: mapped.model,
        ...(mapped.variant ? { variant: mapped.variant } : {}),
      };
      this.counter += 1;
      const routeId = `ars-route-${sessionID}-${this.counter}`;
      this.routes.set(sessionID, { id: routeId, ref, alias, applied: false });
      return { ref, routeId };
    } finally {
      this.reserved.delete(sessionID);
    }
  }

  /**
   * Called by the host hook for every request. The route applies only while
   * the latest user message carries its tag, so tool continuations keep the
   * alias and an unrelated prompt cannot consume it.
   */
  async handle(event: RouterEvent): Promise<void> {
    if (event.kind !== "primary") return;
    const route = this.routes.get(event.sessionID);
    if (!route) return;
    const latest = await this.deps.latestUserMessage(event.sessionID);
    if (!latest || latest.routeId !== route.id) {
      this.routes.delete(event.sessionID);
      if (route.applied) {
        // The command turn already ran; a later prompt owns this request.
        return;
      }
      throw new Error(
        `ARS model routing refused: alias ${JSON.stringify(route.alias)} could not be matched to the command prompt that is still pending ` +
          `(latest user message ${latest ? latest.id : "missing"}). The route was cleared; retry the command in a new session.`,
      );
    }
    if (event.model.providerID !== route.ref.providerID) {
      throw new Error(
        `ARS model routing refused: alias ${JSON.stringify(route.alias)} maps to ${route.ref.providerID}, but the request resolved on ${event.model.providerID}.`,
      );
    }
    event.model = { ...route.ref };
    route.applied = true;
    this.used.set(event.sessionID, { ref: route.ref, alias: route.alias });
  }

  /** Clear one exact pending route; a stale ID never clears a newer route. */
  clear(sessionID: string, routeId?: string): void {
    const route = this.routes.get(sessionID);
    if (!route) return;
    if (routeId !== undefined && route.id !== routeId) return;
    this.routes.delete(sessionID);
  }

  /**
   * Lifecycle cleanup after a finished execution or a failure/interruption.
   * An applied route is removed only when its own turn reached a terminal
   * event. An unapplied route is removed only when the session's latest user
   * message still carries that route tag, so a stale event cannot kill a newer
   * route that has been reserved but not admitted yet.
   */
  async finish(sessionID: string): Promise<void> {
    const route = this.routes.get(sessionID);
    if (!route) return;
    if (!route.applied) {
      const latest = await this.deps.latestUserMessage(sessionID);
      if (!latest || latest.routeId !== route.id) return;
    }
    this.routes.delete(sessionID);
  }

  /** Recorded routes for `ars_opencode_status` (bounded, newest last). */
  usedRoutes(): { sessionID: string; alias: string; model: string }[] {
    return [...this.used.entries()]
      .slice(-20)
      .map(([sessionID, value]) => ({
        sessionID,
        alias: value.alias,
        model: `${value.ref.providerID}/${value.ref.id}`,
      }));
  }
}
