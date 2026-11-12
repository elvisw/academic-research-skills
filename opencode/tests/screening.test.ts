import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  extractJson,
  parseExclusionCodes,
  parseExpectedIds,
  planScreening,
  roleOf,
  runScreening,
  splitLabel,
  validateDecisions,
  type ScreeningPort,
} from "../src/screening.ts";

const CONTEXT = "abcdef0123456789";

function taPrompt(count: number): string {
  return [
    "You are REVIEWER A.",
    "The recovery codes; checking the codes in this order: E1 (RCT only) > E2 (wrong population) > E6 (wrong outcome).",
    `The batch contains ${count} records, IDs R00001 to R${String(count).padStart(5, "0")}.`,
    'Reply with {"decisions": [...]}.',
  ].join("\n");
}

function ftPrompt(pdf: string): string {
  return [
    "You are REVIEWER FTA.",
    "Record R00001; title in the database: \"A study\"",
    `Use only the Read tool, on this file: ${pdf}`,
    "Return exactly one object {id, d, code, why, where}.",
  ].join("\n");
}

function fixture(): {
  root: string;
  work: string;
  emit: string;
  pdf: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ars-screening-"));
  const work = join(root, "work");
  const emit = join(root, "prompts");
  mkdirSync(join(work, "batches"), { recursive: true });
  mkdirSync(emit, { recursive: true });
  writeFileSync(join(work, "batches", "b001.txt"), "records\n", "utf8");
  writeFileSync(join(work, "records.json"), '{"unique":[]}\n', "utf8");
  const pdf = join(work, "paper.pdf");
  writeFileSync(pdf, "%PDF-1.4\n", "utf8");
  return { root, work, emit, pdf };
}

test("labels and roles resolve deterministically", () => {
  assert.deepEqual(splitLabel(`A:b001@${CONTEXT}`), {
    label: "A:b001",
    contextID: CONTEXT,
  });
  assert.equal(splitLabel("A:b001"), null);
  assert.equal(splitLabel(`A:b001@${CONTEXT}`)?.label, "A:b001");
  assert.equal(roleOf("A:b001"), "A");
  assert.equal(roleOf("FTADJ:R00001"), "FTADJ");
  assert.equal(roleOf("nope"), undefined);
});

test("expected IDs come from the emitted task text", () => {
  assert.deepEqual(parseExpectedIds(taPrompt(2)), ["R00001", "R00002"]);
  assert.deepEqual(
    parseExpectedIds("Screen exactly these 2 records: R00003, R00007."),
    ["R00003", "R00007"],
  );
  assert.deepEqual(parseExpectedIds("Record R00009; title in the database"), [
    "R00009",
  ]);
  assert.equal(parseExpectedIds("no ids here"), null);
});

test("exclusion codes come from the protocol rules", () => {
  const codes = parseExclusionCodes(taPrompt(2));
  assert.deepEqual([...(codes ?? [])], ["E1", "E2", "E6"]);
  assert.equal(codes?.has("RCT"), false);
  assert.equal(parseExclusionCodes("no codes"), null);
});

test("decision validation mirrors the source taker", () => {
  const codes = new Set(["E1", "E2"]);
  const valid = validateDecisions(
    '```json\n{"decisions":[{"id":"R00001","d":"include","code":"INC","why":"fits"},{"id":"R00002","d":"exclude","code":"E2","why":"wrong population"}]}\n```',
    ["R00001", "R00002"],
    codes,
  );
  assert.equal(valid.accepted.size, 2);
  assert.deepEqual(valid.rejected, []);

  const noWhy = validateDecisions(
    JSON.stringify({
      decisions: [{ id: "R00001", d: "include", code: "INC" }],
    }),
    ["R00001"],
    codes,
  );
  assert.equal(noWhy.accepted.size, 1);
  assert.equal(noWhy.accepted.get("R00001")?.why, "");

  const invalid = validateDecisions(
    JSON.stringify({
      decisions: [
        { id: "R00009", d: "include", code: "INC", why: "not expected" },
        { id: "R00001", d: "include", code: "E2", why: "disagree" },
        { id: "R00002", d: "exclude", code: "E9", why: "code not allowed" },
        { id: "R00002", d: "include", code: "INC", why: "duplicate" },
      ],
    }),
    ["R00001", "R00002"],
    codes,
  );
  assert.equal(invalid.accepted.size, 1);
  assert.equal(invalid.rejected.length, 3);
  assert.ok(invalid.accepted.has("R00002"));

  const prose = validateDecisions("I think these are fine.", ["R00001"], codes);
  assert.equal(prose.accepted.size, 0);
  assert.match(prose.rejected[0]?.reason ?? "", /no JSON/);
  assert.deepEqual(extractJson("prefix {\"decisions\":[]} suffix"), {
    decisions: [],
  });
});

test("relative prompt_file paths resolve against the emit directory", () => {
  const { root, work, emit } = fixture();
  try {
    writeFileSync(join(emit, "A_b001.txt"), taPrompt(2), "utf8");
    writeFileSync(
      join(emit, "index.json"),
      JSON.stringify([
        {
          label: `A:b001@${CONTEXT}`,
          context: { context_id: CONTEXT },
          prompt_file: "A_b001.txt",
        },
      ]),
      "utf8",
    );
    const plan = planScreening({ stage: "ta", workDir: work, emitDir: emit });
    assert.deepEqual(plan.missingFiles, []);
    assert.equal(plan.entries[0]?.prompt_file, join(emit, "A_b001.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan validates context binding, batches, PDFs and role models", () => {
  const { root, work, emit, pdf } = fixture();
  try {
    writeFileSync(
      join(emit, "A_b001.txt"),
      taPrompt(2),
      "utf8",
    );
    writeFileSync(join(emit, "B_b001.txt"), taPrompt(2), "utf8");
    writeFileSync(
      join(emit, "index.json"),
      JSON.stringify([
        {
          label: `A:b001@${CONTEXT}`,
          context: { context_id: CONTEXT },
          prompt_file: join(emit, "A_b001.txt"),
          model: "sonnet",
        },
        {
          label: `B:b001@${CONTEXT}`,
          context: { context_id: CONTEXT },
          prompt_file: join(emit, "B_b001.txt"),
          model: "sonnet",
        },
      ]),
      "utf8",
    );

    const blocked = planScreening({ stage: "ta", workDir: work, emitDir: emit });
    assert.equal(blocked.calls, 2);
    assert.deepEqual(blocked.roleCounts, { A: 1, B: 1 });
    assert.equal(blocked.missingModels.length, 2);

    const plan = planScreening({
      stage: "ta",
      workDir: work,
      emitDir: emit,
      roleModels: {
        A: { providerID: "anthropic", model: "claude-sonnet-4-5" },
        B: { providerID: "anthropic", model: "claude-sonnet-4-5" },
      },
      availableModels: [
        { providerID: "anthropic", id: "claude-sonnet-4-5" },
      ],
    });
    assert.deepEqual(plan.missingModels, []);
    assert.deepEqual(plan.missingFiles, []);
    assert.equal(plan.contextID, CONTEXT);

    // A mismatched label/context is refused, not "fixed".
    writeFileSync(
      join(emit, "index.json"),
      JSON.stringify([
        {
          label: `A:b001@deadbeefdeadbeef`,
          context: { context_id: CONTEXT },
          prompt_file: join(emit, "A_b001.txt"),
        },
      ]),
      "utf8",
    );
    assert.throws(
      () => planScreening({ stage: "ta", workDir: work, emitDir: emit }),
      /does not match its context/,
    );

    // Full text: an unreadable PDF blocks the run.
    writeFileSync(
      join(emit, "FTA.txt"),
      ftPrompt(join(work, "missing.pdf")),
      "utf8",
    );
    writeFileSync(
      join(emit, "index.json"),
      JSON.stringify([
        {
          label: `FTA:R00001@${CONTEXT}`,
          context: { context_id: CONTEXT },
          prompt_file: join(emit, "FTA.txt"),
          model: "sonnet",
        },
      ]),
      "utf8",
    );
    const ft = planScreening({
      stage: "ft",
      workDir: work,
      emitDir: emit,
      roleModels: { FTA: { providerID: "anthropic", model: "claude-sonnet-4-5" } },
      availableModels: [{ providerID: "anthropic", id: "claude-sonnet-4-5" }],
    });
    assert.equal(ft.unreadablePdfs.length, 1);
    assert.ok(ft.unreadablePdfs[0]?.endsWith("missing.pdf"));

    // A readable PDF passes.
    writeFileSync(join(emit, "FTA.txt"), ftPrompt(pdf), "utf8");
    const ok = planScreening({
      stage: "ft",
      workDir: work,
      emitDir: emit,
      roleModels: { FTA: { providerID: "anthropic", model: "claude-sonnet-4-5" } },
      availableModels: [{ providerID: "anthropic", id: "claude-sonnet-4-5" }],
    });
    assert.deepEqual(ok.unreadablePdfs, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface FakePort extends ScreeningPort {
  created: string[];
  prompts: { sessionID: string; text: string }[];
  removed: string[];
  models: { providerID: string; model: string }[];
}

function fakePort(
  replies: string[][],
  options: { effective?: { providerID: string; id: string } } = {},
): FakePort {
  const created: string[] = [];
  const prompts: { sessionID: string; text: string }[] = [];
  const removed: string[] = [];
  const models: { providerID: string; model: string }[] = [];
  const cursors = new Map<string, number>();
  const current = new Map<string, { providerID: string; id: string }>();
  return {
    created,
    prompts,
    removed,
    models,
    async create() {
      const id = `ses-${created.length + 1}`;
      created.push(id);
      cursors.set(id, 0);
      return id;
    },
    async switchAgent() {},
    async switchModel(sessionID, ref) {
      models.push({ providerID: ref.providerID, model: ref.model });
      current.set(sessionID, { providerID: ref.providerID, id: ref.model });
    },
    async sessionModel(sessionID) {
      return options.effective ?? current.get(sessionID);
    },
    async prompt(sessionID, text) {
      prompts.push({ sessionID, text });
    },
    async wait() {},
    async lastAssistantText(sessionID) {
      const entry = created.indexOf(sessionID);
      const index = cursors.get(sessionID) ?? 0;
      cursors.set(sessionID, index + 1);
      return replies[entry]?.[index] ?? "";
    },
    async remove(sessionID) {
      removed.push(sessionID);
    },
  };
}

function taPlanFixture(model = ""): {
  root: string;
  work: string;
  emit: string;
  plan: ReturnType<typeof planScreening>;
} {
  const { root, work, emit } = fixture();
  writeFileSync(join(emit, "A_b001.txt"), taPrompt(2), "utf8");
  writeFileSync(
    join(emit, "index.json"),
    JSON.stringify([
      {
        label: `A:b001@${CONTEXT}`,
        context: { context_id: CONTEXT },
        prompt_file: join(emit, "A_b001.txt"),
        model,
      },
    ]),
    "utf8",
  );
  const plan = planScreening({
    stage: "ta",
    workDir: work,
    emitDir: emit,
    ...(model
      ? {
          roleModels: {
            A: { providerID: "fixture", model: "model" },
          },
          availableModels: [{ providerID: "fixture", id: "model" }],
        }
      : {}),
  });
  return { root, work, emit, plan };
}

test("dispatch needs explicit approval and refuses missing model mappings", async () => {
  const { root, work, emit, plan } = taPlanFixture();
  try {
    const out = join(work, "out.json");
    await assert.rejects(
      () => runScreening({ plan, workDir: work, outFile: out, port: fakePort([]), approve: false }),
      /cost approval/,
    );
    const blocked = { ...plan, missingModels: ["A (sonnet)"] };
    await assert.rejects(
      () => runScreening({ plan: blocked, workDir: work, outFile: out, port: fakePort([]), approve: true }),
      /no OpenCode model mapping/,
    );
    assert.equal(emit.length > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a complete reply is validated and written with label@context", async () => {
  const { root, work, plan } = taPlanFixture();
  try {
    const out = join(work, "out.json");
    const port = fakePort([
      [
        JSON.stringify({
          decisions: [
            { id: "R00001", d: "include", code: "INC", why: "fits" },
            { id: "R00002", d: "exclude", code: "E1", why: "not eligible" },
          ],
        }),
      ],
    ]);
    const result = await runScreening({
      plan,
      workDir: work,
      outFile: out,
      port,
      approve: true,
    });
    assert.equal(result.calls, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.label, `A:b001@${CONTEXT}`);
    assert.equal(result.results[0]?.decisions.length, 2);
    assert.deepEqual(result.pending, []);
    assert.deepEqual(port.removed, port.created);
    const written = JSON.parse(readFileSync(out, "utf8")) as {
      label: string;
      decisions: unknown[];
    }[];
    assert.ok(Array.isArray(written));
    assert.equal(written[0]?.label, `A:b001@${CONTEXT}`);
    const audit = JSON.parse(
      readFileSync(out.replace(/\.json$/, ".audit.json"), "utf8"),
    ) as { context_id: string; pending: unknown[] };
    assert.equal(audit.context_id, CONTEXT);
    assert.deepEqual(audit.pending, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one missing-item retry recovers the omitted records", async () => {
  const { root, work, plan } = taPlanFixture();
  try {
    const out = join(work, "out.json");
    const port = fakePort([
      [
        JSON.stringify({
          decisions: [{ id: "R00001", d: "include", code: "INC", why: "fits" }],
        }),
        JSON.stringify({
          decisions: [{ id: "R00002", d: "exclude", code: "E2", why: "population" }],
        }),
      ],
    ]);
    const result = await runScreening({
      plan,
      workDir: work,
      outFile: out,
      port,
      approve: true,
    });
    assert.equal(port.created.length, 1, "the retry stays in the same reviewer session");
    assert.equal(port.prompts.length, 2);
    assert.match(port.prompts[1]?.text ?? "", /RETRY/);
    assert.equal(result.calls, 2, "the retry is counted as a real call");
    assert.deepEqual(result.pending, []);
    assert.equal(result.results[0]?.decisions.length, 2);
    const audit = JSON.parse(
      readFileSync(out.replace(/\.json$/, ".audit.json"), "utf8"),
    ) as { calls: number };
    assert.equal(audit.calls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one malformed prompt does not discard earlier paid decisions", async () => {
  const { root, work, emit } = fixture();
  try {
    writeFileSync(join(emit, "A_b001.txt"), taPrompt(2), "utf8");
    writeFileSync(join(emit, "B_b001.txt"), "no ids and no codes here", "utf8");
    writeFileSync(
      join(emit, "index.json"),
      JSON.stringify([
        {
          label: `A:b001@${CONTEXT}`,
          context: { context_id: CONTEXT },
          prompt_file: join(emit, "A_b001.txt"),
        },
        {
          label: `B:b001@${CONTEXT}`,
          context: { context_id: CONTEXT },
          prompt_file: join(emit, "B_b001.txt"),
        },
      ]),
      "utf8",
    );
    const plan = planScreening({ stage: "ta", workDir: work, emitDir: emit });
    const out = join(work, "out.json");
    const result = await runScreening({
      plan,
      workDir: work,
      outFile: out,
      port: fakePort([
        [
          JSON.stringify({
            decisions: [
              { id: "R00001", d: "include", code: "INC", why: "fits" },
              { id: "R00002", d: "include", code: "INC", why: "fits" },
            ],
          }),
        ],
      ]),
      approve: true,
    });
    assert.equal(result.calls, 1);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0]?.decisions.length, 2);
    assert.equal(result.results[1]?.decisions.length, 0);
    assert.match(result.rejected[0]?.reason ?? "", /cannot derive/);
    assert.deepEqual(result.pending, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid decisions stay pending and are never filled in", async () => {
  const { root, work, plan } = taPlanFixture();
  try {
    const out = join(work, "out.json");
    const port = fakePort([
      [
        JSON.stringify({
          decisions: [
            { id: "R00001", d: "include", code: "E1", why: "disagree" },
            { id: "R00002", d: "exclude", code: "E9", why: "unknown code" },
          ],
        }),
        "still nothing useful",
      ],
    ]);
    const result = await runScreening({
      plan,
      workDir: work,
      outFile: out,
      port,
      approve: true,
    });
    assert.equal(result.results[0]?.decisions.length, 0);
    assert.deepEqual(result.pending, [
      { label: `A:b001@${CONTEXT}`, missing: ["R00001", "R00002"] },
    ]);
    assert.ok(result.rejected.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed reviewer session leaves its records pending", async () => {
  const { root, work, plan } = taPlanFixture();
  try {
    const base = fakePort([]);
    const port: ScreeningPort = {
      ...base,
      async prompt() {
        throw new Error("model unavailable");
      },
    };
    const result = await runScreening({
      plan,
      workDir: work,
      outFile: join(work, "out.json"),
      port,
      approve: true,
    });
    assert.equal(result.results[0]?.decisions.length, 0);
    assert.deepEqual(result.pending, [
      { label: `A:b001@${CONTEXT}`, missing: ["R00001", "R00002"] },
    ]);
    assert.match(result.rejected[0]?.reason ?? "", /model unavailable/);
    assert.deepEqual(base.removed, base.created);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the configured role model is applied and verified before the prompt", async () => {
  const { root, work, plan } = taPlanFixture("fixture-model");
  try {
    const port = fakePort([
      [
        JSON.stringify({
          decisions: [
            { id: "R00001", d: "include", code: "INC", why: "fits" },
            { id: "R00002", d: "include", code: "INC", why: "fits" },
          ],
        }),
      ],
    ]);
    const out = join(work, "out.json");
    const result = await runScreening({
      plan,
      workDir: work,
      outFile: out,
      port,
      approve: true,
      roleModels: { A: { providerID: "fixture", model: "model" } },
      availableModels: [{ providerID: "fixture", id: "model" }],
    });
    assert.deepEqual(port.models, [{ providerID: "fixture", model: "model" }]);
    assert.deepEqual(result.pending, []);
    assert.equal(result.results[0]?.decisions.length, 2);
    const audit = JSON.parse(
      readFileSync(out.replace(/\.json$/, ".audit.json"), "utf8"),
    ) as { routes: { role: string; requested: string; effective: string }[] };
    assert.deepEqual(audit.routes, [
      {
        label: `A:b001@${CONTEXT}`,
        role: "A",
        requested: "fixture-model",
        effective: "fixture/model",
        sessionID: port.created[0],
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wrong effective model blocks the call and leaves it pending", async () => {
  const { root, work, plan } = taPlanFixture("fixture-model");
  try {
    const port = fakePort([], {
      effective: { providerID: "fixture", id: "different-model" },
    });
    const result = await runScreening({
      plan,
      workDir: work,
      outFile: join(work, "out.json"),
      port,
      approve: true,
      roleModels: { A: { providerID: "fixture", model: "model" } },
      availableModels: [{ providerID: "fixture", id: "model" }],
    });
    assert.equal(result.results[0]?.decisions.length, 0);
    assert.deepEqual(result.pending, [
      { label: `A:b001@${CONTEXT}`, missing: ["R00001", "R00002"] },
    ]);
    assert.match(result.rejected[0]?.reason ?? "", /could not be routed/);
    assert.equal(port.prompts.length, 0, "no prompt after a failed route check");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retry failure preserves decisions accepted from the first reply", async () => {
  const { root, work, plan } = taPlanFixture();
  try {
    const base = fakePort([
      [
        JSON.stringify({
          decisions: [{ id: "R00001", d: "include", code: "INC", why: "fits" }],
        }),
      ],
    ]);
    let calls = 0;
    const port: ScreeningPort = {
      ...base,
      async prompt(sessionID, text) {
        calls += 1;
        if (calls === 2) throw new Error("retry transport failed");
        await base.prompt(sessionID, text);
      },
    };
    const result = await runScreening({
      plan,
      workDir: work,
      outFile: join(work, "out.json"),
      port,
      approve: true,
    });
    assert.deepEqual(
      result.results[0]?.decisions.map((decision) => decision.id),
      ["R00001"],
    );
    assert.deepEqual(result.pending, [
      { label: `A:b001@${CONTEXT}`, missing: ["R00002"] },
    ]);
    assert.match(result.rejected[0]?.reason ?? "", /retry failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each reviewer call is its own session and cannot see a peer prompt", async () => {
  const { root, work, emit } = fixture();
  try {
    writeFileSync(join(emit, "A_b001.txt"), taPrompt(2), "utf8");
    writeFileSync(
      join(emit, "B_b001.txt"),
      taPrompt(2).replace("REVIEWER A", "REVIEWER B"),
      "utf8",
    );
    writeFileSync(
      join(emit, "index.json"),
      JSON.stringify([
        {
          label: `A:b001@${CONTEXT}`,
          context: { context_id: CONTEXT },
          prompt_file: join(emit, "A_b001.txt"),
        },
        {
          label: `B:b001@${CONTEXT}`,
          context: { context_id: CONTEXT },
          prompt_file: join(emit, "B_b001.txt"),
        },
      ]),
      "utf8",
    );
    const plan = planScreening({ stage: "ta", workDir: work, emitDir: emit });
    const reply = JSON.stringify({
      decisions: [
        { id: "R00001", d: "include", code: "INC", why: "fits" },
        { id: "R00002", d: "include", code: "INC", why: "fits" },
      ],
    });
    const port = fakePort([[reply], [reply]]);
    await runScreening({
      plan,
      workDir: work,
      outFile: join(work, "out.json"),
      port,
      approve: true,
    });
    assert.equal(port.created.length, 2);
    assert.notEqual(port.created[0], port.created[1]);
    assert.equal(port.prompts[0]?.sessionID, port.created[0]);
    assert.equal(port.prompts[1]?.sessionID, port.created[1]);
    assert.match(port.prompts[0]?.text ?? "", /REVIEWER A/);
    assert.match(port.prompts[1]?.text ?? "", /REVIEWER B/);
    // The adapter never injects one reviewer's prompt or decisions into another.
    assert.ok(!(port.prompts[1]?.text ?? "").includes("REVIEWER A"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
