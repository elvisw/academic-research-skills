import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelRouter,
  type RouterMessage,
} from "../src/models.ts";

function router(options: {
  alias?: string;
  aliasRef?: { providerID: string; model: string; variant?: string };
  current?: { providerID: string; id: string } | null;
  models?: { providerID: string; id: string }[];
} = {}) {
  const state = { messages: [] as RouterMessage[] };
  const modelRouter = new ModelRouter({
    alias: (alias) =>
      alias === (options.alias ?? "sonnet") ? options.aliasRef : undefined,
    listModels: async () =>
      options.models ?? [
        { providerID: "p", id: "cheap" },
        { providerID: "p", id: "strong" },
      ],
    sessionModel: async () =>
      options.current === null
        ? undefined
        : (options.current ?? { providerID: "p", id: "cheap" }),
    latestUserMessage: async () => state.messages.at(-1),
  });
  return { router: modelRouter, state };
}

function primary(sessionID = "ses-1") {
  return {
    sessionID,
    kind: "primary" as const,
    model: { providerID: "p", id: "cheap" as const },
  };
}

test("the alias follows its tagged prompt across tool continuations", async () => {
  const { router: modelRouter, state } = router({
    aliasRef: { providerID: "p", model: "strong" },
  });
  const prepared = await modelRouter.prepare("ses-1", "sonnet");
  assert.deepEqual(prepared.ref, { providerID: "p", id: "strong" });
  state.messages.push({ id: "m1", routeId: prepared.routeId });

  const first = primary();
  await modelRouter.handle(first);
  assert.deepEqual(first.model, { providerID: "p", id: "strong" });

  // A tool continuation has no new user message: the same turn keeps the alias.
  const second = primary();
  await modelRouter.handle(second);
  assert.deepEqual(second.model, { providerID: "p", id: "strong" });
  assert.deepEqual(modelRouter.usedRoutes(), [
    { sessionID: "ses-1", alias: "sonnet", model: "p/strong" },
  ]);
});

test("an unrelated prompt cannot consume a pending route", async () => {
  const { router: modelRouter, state } = router({
    aliasRef: { providerID: "p", model: "strong" },
  });
  await modelRouter.prepare("ses-1", "sonnet");
  state.messages.push({ id: "m-unrelated" });

  const event = primary();
  await assert.rejects(
    () => modelRouter.handle(event),
    /could not be matched to the command prompt/,
  );
  assert.deepEqual(event.model, { providerID: "p", id: "cheap" });

  // The ambiguous route is cleared, so a retry can be prepared.
  const retry = await modelRouter.prepare("ses-1", "sonnet");
  state.messages.push({ id: "m-command", routeId: retry.routeId });
  const accepted = primary();
  await modelRouter.handle(accepted);
  assert.deepEqual(accepted.model, { providerID: "p", id: "strong" });
});

test("a route admitted after a different message fails visibly", async () => {
  const { router: modelRouter, state } = router({
    aliasRef: { providerID: "p", model: "strong" },
  });
  await modelRouter.prepare("ses-1", "sonnet");
  // Admission order reversed: another prompt is latest when the request runs.
  state.messages.push({ id: "m2" });

  await assert.rejects(
    () => modelRouter.handle(primary()),
    /retry the command in a new session/,
  );
});

test("a failed admission clears only its own route", async () => {
  const { router: modelRouter, state } = router({
    aliasRef: { providerID: "p", model: "strong" },
  });
  const first = await modelRouter.prepare("ses-1", "sonnet");
  modelRouter.clear("ses-1", "not-this-route");
  // The mismatched clear did not remove the real route.
  await assert.rejects(
    () => modelRouter.prepare("ses-1", "sonnet"),
    /already waiting/,
  );
  modelRouter.clear("ses-1", first.routeId);
  const second = await modelRouter.prepare("ses-1", "sonnet");
  state.messages.push({ id: "m2", routeId: second.routeId });
  const event = primary();
  await modelRouter.handle(event);
  assert.deepEqual(event.model, { providerID: "p", id: "strong" });
});

test("concurrent commands in one session are blocked, separate sessions are not", async () => {
  const { router: modelRouter, state } = router({
    aliasRef: { providerID: "p", model: "strong" },
  });
  await modelRouter.prepare("ses-1", "sonnet");
  await assert.rejects(
    () => modelRouter.prepare("ses-1", "sonnet"),
    /another ARS command is already waiting/,
  );

  const other = await modelRouter.prepare("ses-2", "sonnet");
  state.messages.push({ id: "m2", routeId: other.routeId });
  const second = primary("ses-2");
  await modelRouter.handle(second);
  assert.deepEqual(second.model, { providerID: "p", id: "strong" });
});

test("a missing latest user message blocks instead of applying blindly", async () => {
  const { router: modelRouter, state } = router({
    aliasRef: { providerID: "p", model: "strong" },
  });
  await modelRouter.prepare("ses-1", "sonnet");
  state.messages.length = 0;
  await assert.rejects(
    () => modelRouter.handle(primary()),
    /latest user message missing/,
  );
});

test("simultaneous prepares reserve one route before any await", async () => {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const modelRouter = new ModelRouter({
    alias: () => ({ providerID: "p", model: "strong" }),
    listModels: async () => {
      await delay(10);
      return [
        { providerID: "p", id: "cheap" },
        { providerID: "p", id: "strong" },
      ];
    },
    sessionModel: async () => {
      await delay(10);
      return { providerID: "p", id: "cheap" };
    },
    latestUserMessage: async () => undefined,
  });
  const results = await Promise.allSettled([
    modelRouter.prepare("same", "sonnet"),
    modelRouter.prepare("same", "sonnet"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(
    (rejected as PromiseRejectedResult).reason.message,
    /already waiting/,
  );
});

test("finishing one command allows the next command in the same session", async () => {
  const { router: modelRouter, state } = router({
    aliasRef: { providerID: "p", model: "strong" },
  });
  const first = await modelRouter.prepare("ses-1", "sonnet");
  state.messages.push({ id: "m1", routeId: first.routeId });
  const firstEvent = primary();
  await modelRouter.handle(firstEvent);
  assert.deepEqual(firstEvent.model, { providerID: "p", id: "strong" });
  await modelRouter.finish("ses-1");

  const second = await modelRouter.prepare("ses-1", "sonnet");
  state.messages.push({ id: "m2", routeId: second.routeId });
  const secondEvent = primary();
  await modelRouter.handle(secondEvent);
  assert.deepEqual(secondEvent.model, { providerID: "p", id: "strong" });
});

test("auxiliary requests are never routed", async () => {
  const { router: modelRouter, state } = router({
    aliasRef: { providerID: "p", model: "strong" },
  });
  const prepared = await modelRouter.prepare("ses-1", "sonnet");
  state.messages.push({ id: "m1", routeId: prepared.routeId });
  const event = { ...primary(), kind: "title" };
  await modelRouter.handle(event);
  assert.deepEqual(event.model, { providerID: "p", id: "cheap" });
});

test("missing, unavailable and cross-provider mappings block before dispatch", async () => {
  const missing = router({ alias: "other" }).router;
  await assert.rejects(
    () => missing.prepare("ses-1", "sonnet"),
    /no OpenCode mapping/,
  );

  const unknown = router({
    aliasRef: { providerID: "p", model: "does-not-exist" },
  }).router;
  await assert.rejects(() => unknown.prepare("ses-1", "sonnet"), /does not offer/);

  const cross = router({
    aliasRef: { providerID: "q", model: "strong" },
    models: [
      { providerID: "p", id: "cheap" },
      { providerID: "q", id: "strong" },
    ],
    current: { providerID: "p", id: "cheap" },
  }).router;
  await assert.rejects(
    () => cross.prepare("ses-1", "sonnet"),
    /only redirect a request within the selected provider/,
  );

  const noSession = router({
    aliasRef: { providerID: "p", model: "strong" },
    current: null,
  }).router;
  await assert.rejects(
    () => noSession.prepare("ses-1", "sonnet"),
    /no selected model/,
  );
});

test("a host without the resolve hook blocks instead of inheriting", async () => {
  const { router: modelRouter } = router({
    aliasRef: { providerID: "p", model: "strong" },
  });
  modelRouter.disable("hook rejected");
  assert.equal(modelRouter.available, false);
  await assert.rejects(
    () => modelRouter.prepare("ses-1", "sonnet"),
    /cannot route command model alias/,
  );
});
