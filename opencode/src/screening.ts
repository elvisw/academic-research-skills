/**
 * sr-screener prompt adaptation for hosts without the Claude Workflow tool.
 *
 * The research algorithms stay in Python: `build_workflow.py --emit-prompts`
 * produces one self-contained prompt per reviewer call and an `index.json`.
 * This module validates those prompts, dispatches each one into a fresh child
 * session of the read-only reviewer agent, applies the source's decision
 * validation + one missing-item retry + pending behavior, and writes results in
 * the `{label, decisions}` shape `merge_decisions.py` already accepts.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { bareReviewerAgentType, type ModelRef } from "./setup.ts";

export const SCREENING_AGENT = "screening-reviewer-agent";

export const TA_ROLES = ["A", "B", "ADJ", "QC"] as const;
export const FT_ROLES = ["FTA", "FTB", "FTADJ"] as const;

export interface ScreeningContext {
  context_id?: string;
  [key: string]: unknown;
}

export interface ScreeningIndexEntry {
  label: string;
  context: ScreeningContext;
  prompt_file: string;
  model?: string;
}

export interface ScreeningDecision {
  id: string;
  d: "include" | "unclear" | "exclude";
  code: string;
  why: string;
  where?: string;
}

export interface ScreeningPlan {
  stage: "ta" | "ft";
  contextID?: string;
  calls: number;
  /** Initial calls plus at most one retry per call. */
  maxCalls: number;
  roleCounts: Record<string, number>;
  missingModels: string[];
  missingFiles: string[];
  unreadablePdfs: string[];
  warnings: string[];
  entries: ScreeningIndexEntry[];
}

export interface ScreeningPort {
  create(title: string): Promise<string>;
  switchAgent(sessionID: string, agent: string): Promise<void>;
  switchModel(sessionID: string, ref: ModelRef): Promise<void>;
  sessionModel(
    sessionID: string,
  ): Promise<{ providerID: string; id: string } | undefined>;
  prompt(sessionID: string, text: string): Promise<void>;
  wait(sessionID: string): Promise<void>;
  lastAssistantText(sessionID: string): Promise<string>;
  remove(sessionID: string): Promise<void>;
}

export interface ScreeningRunOptions {
  plan: ScreeningPlan;
  workDir: string;
  outFile: string;
  port: ScreeningPort;
  /** Cost approval must be explicit; a plan object is not consent. */
  approve: boolean;
  roleModels?: Record<string, ModelRef>;
  availableModels?: readonly { providerID: string; id: string }[];
  onProgress?: (message: string) => void;
}

export interface ScreeningRunResult {
  contextID?: string;
  results: { label: string; decisions: ScreeningDecision[] }[];
  pending: { label: string; missing: string[] }[];
  rejected: { label: string; id?: string; reason: string }[];
  calls: number;
  sessions: string[];
}

const ROLE_PATTERN = /^(A|B|ADJ|QC|FTA|FTB|FTADJ)[:|·_ ]+/;

export function roleOf(label: string): string | undefined {
  const match = ROLE_PATTERN.exec(label);
  return match?.[1];
}

/** `A:b001@<context>` -> `{ label, contextID }`; any mismatch is refused. */
export function splitLabel(
  label: string,
): { label: string; contextID: string } | null {
  const at = label.lastIndexOf("@");
  if (at <= 0 || at === label.length - 1) return null;
  const name = label.slice(0, at);
  const contextID = label.slice(at + 1);
  if (!/^[0-9a-f]{8,}$/i.test(contextID)) return null;
  return { label: name, contextID };
}

export function readScreeningIndex(emitDir: string): ScreeningIndexEntry[] {
  const path = join(emitDir, "index.json");
  if (!existsSync(path)) {
    throw new Error(`screening index not found: ${path} (run build_workflow.py --emit-prompts)`);
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("index.json is not an array");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`index.json entry ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.label !== "string" || typeof record.prompt_file !== "string") {
      throw new Error(`index.json entry ${index} is missing label/prompt_file`);
    }
    if (!record.context || typeof record.context !== "object") {
      throw new Error(`index.json entry ${index} is missing context`);
    }
    return {
      label: record.label,
      context: record.context as ScreeningContext,
      prompt_file: record.prompt_file,
      model: typeof record.model === "string" ? record.model : undefined,
    };
  });
}

function checkPdf(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function pdfPathFromPrompt(text: string): string | undefined {
  const match = /Use only the Read tool, on this file: (.+)$/m.exec(text);
  if (!match) return undefined;
  const raw = (match[1] ?? "").trim();
  if (!raw.toLowerCase().endsWith(".pdf")) return undefined;
  return raw;
}

/**
 * Resolve a `prompt_file` from a production `--emit-prompts` export.
 *
 * The unchanged emitter stores `os.path.join(out_dir, "<label>.txt")` verbatim.
 * A relative `out_dir` therefore yields a path like `work/prompts/A_b001.txt`
 * that is relative to the EMITTER's cwd, which the index does not record. The
 * adapter only knows the actual emit directory, so it strips the exported
 * out_dir prefix (identified by the emit directory's basename) and resolves the
 * remaining flat filename inside the emit directory. Prompt files are flat by
 * construction (`label.replace(":", "_") + ".txt"`), so this preserves the
 * export semantics without guessing the emitter cwd.
 */
function resolveEmittedPromptPath(
  promptFile: string,
  emitDir: string,
): string {
  if (isAbsolute(promptFile)) return promptFile;
  const normalized = promptFile.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  const emitBase = basename(emitDir);
  const index = parts.lastIndexOf(emitBase);
  if (index !== -1 && index < parts.length - 1) {
    return resolve(emitDir, ...parts.slice(index + 1));
  }
  return resolve(emitDir, promptFile);
}

/**
 * Build a dispatch plan and validate every prerequisite the source checks at
 * build time: context binding, prompt files, batch/PDF access, role models.
 */
export function planScreening(options: {
  stage: "ta" | "ft";
  workDir: string;
  emitDir: string;
  roleModels?: Record<string, ModelRef>;
  availableModels?: readonly { providerID: string; id: string }[];
}): ScreeningPlan {
  const workDir = resolve(options.workDir);
  const emitDir = resolve(options.emitDir);
  const entries = readScreeningIndex(emitDir).map((entry) => ({
    ...entry,
    prompt_file: resolveEmittedPromptPath(entry.prompt_file, emitDir),
  }));
  const missingFiles: string[] = [];
  const unreadablePdfs: string[] = [];
  const missingModels: string[] = [];
  const warnings: string[] = [];
  const roleCounts: Record<string, number> = {};
  const contexts = new Set<string>();
  const roles = options.stage === "ta" ? TA_ROLES : FT_ROLES;

  for (const entry of entries) {
    const split = splitLabel(entry.label);
    if (!split) {
      throw new Error(
        `screening label ${JSON.stringify(entry.label)} is not "label@<context_id>"`,
      );
    }
    if (entry.context.context_id !== split.contextID) {
      throw new Error(
        `screening label ${JSON.stringify(entry.label)} does not match its context ${JSON.stringify(entry.context.context_id)}`,
      );
    }
    contexts.add(split.contextID);
    const role = roleOf(split.label);
    if (!role || !(roles as readonly string[]).includes(role)) {
      throw new Error(
        `screening label ${JSON.stringify(entry.label)} has no ${options.stage} role`,
      );
    }
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;

    if (!existsSync(entry.prompt_file)) {
      missingFiles.push(entry.prompt_file);
      continue;
    }
    const promptText = readFileSync(entry.prompt_file, "utf8");

    if (options.stage === "ta") {
      const batch = split.label.split(/[:·_ ]+/)[1];
      if (!batch) {
        missingFiles.push(`${entry.label}: no batch name`);
      } else if (!existsSync(join(workDir, "batches", `${batch}.txt`))) {
        missingFiles.push(join(workDir, "batches", `${batch}.txt`));
      }
    } else {
      const pdf = pdfPathFromPrompt(promptText);
      if (!pdf) {
        unreadablePdfs.push(`${entry.label}: prompt names no PDF`);
      } else if (!checkPdf(pdf)) {
        unreadablePdfs.push(pdf);
      }
    }

    const roleModel = options.roleModels?.[role];
    if (entry.model) {
      if (!roleModel) {
        missingModels.push(`${role} (${entry.model})`);
      } else if (
        options.availableModels &&
        !options.availableModels.some(
          (model) =>
            model.providerID === roleModel.providerID &&
            model.id === roleModel.model,
        )
      ) {
        missingModels.push(
          `${role} -> ${roleModel.providerID}/${roleModel.model} (not offered by this host)`,
        );
      }
    }
  }

  if (contexts.size > 1) {
    throw new Error(
      `screening index mixes context IDs (${[...contexts].join(", ")}); regenerate the prompts`,
    );
  }

  const contextID = [...contexts][0];
  if (contextID) {
    const statePath = join(workDir, "review_state.json");
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<
          string,
          { context_id?: string }
        >;
        const current = state[options.stage]?.context_id;
        if (current && current !== contextID) {
          warnings.push(
            `the emitted prompts were bound to ${contextID} but the active stage context is ${current}; a protocol/profile change archives earlier decisions`,
          );
        }
      } catch {
        warnings.push("review_state.json could not be read; context binding was not cross-checked");
      }
    }
  }

  return {
    stage: options.stage,
    contextID,
    calls: entries.length,
    maxCalls: entries.length * 2,
    roleCounts,
    missingModels: [...new Set(missingModels)],
    missingFiles: [...new Set(missingFiles)],
    unreadablePdfs: [...new Set(unreadablePdfs)],
    warnings,
    entries,
  };
}

export function describePlan(plan: ScreeningPlan): string {
  const roles = Object.entries(plan.roleCounts)
    .map(([role, count]) => `${role}=${count}`)
    .join(", ");
  const lines = [
    `ARS screening dispatch (${plan.stage})`,
    `context: ${plan.contextID ?? "unknown"}`,
    `calls: ${plan.calls} (at most ${plan.maxCalls} with one missing-item retry per call) (${roles || "none"})`,
    plan.missingModels.length
      ? `blocked models: ${plan.missingModels.join("; ")}`
      : "models: mapped",
    plan.missingFiles.length
      ? `missing files: ${plan.missingFiles.length}`
      : "files: present",
    plan.unreadablePdfs.length
      ? `unreadable PDFs: ${plan.unreadablePdfs.length}`
      : "PDFs: present",
  ];
  for (const warning of plan.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

/** Parse the expected record IDs out of the emitted task text. */
export function parseExpectedIds(prompt: string): string[] | null {
  const batch = /The batch contains (\d+) records, IDs (R\d+) to (R\d+)\./.exec(
    prompt,
  );
  if (batch) {
    const count = Number(batch[1]);
    const first = Number((batch[2] as string).slice(1));
    const last = Number((batch[3] as string).slice(1));
    const width = (batch[2] as string).length - 1;
    if (!Number.isFinite(count) || count !== last - first + 1) return null;
    const ids: string[] = [];
    for (let value = first; value <= last; value += 1) {
      ids.push(`R${String(value).padStart(width, "0")}`);
    }
    return ids;
  }
  const subset = /Screen exactly these (\d+) records: ([^.\n]+)\./.exec(prompt);
  if (subset) {
    const ids = (subset[2] as string)
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^R\d+$/.test(value));
    if (ids.length !== Number(subset[1])) return null;
    return ids;
  }
  const single = /^Record (R\d+);/m.exec(prompt);
  if (single) return [single[1] as string];
  return null;
}

export function parseExclusionCodes(prompt: string): Set<string> | null {
  const match = /checking the codes in this order:([^\n]*)/.exec(prompt);
  if (!match) return null;
  const segment = match[1] as string;
  // srlib.codes_text emits "E1 (short label) > E2 (short label)". Match only
  // the code immediately before the label parenthesis; a generic uppercase
  // word scan would also accept label words such as "RCT".
  const codes = [
    ...segment.matchAll(/\b([A-Z][A-Z0-9_-]{0,9})\s*\(/g),
  ]
    .map((entry) => entry[1] as string)
    .filter((code) => code !== "INC" && code !== "UNC");
  return codes.length ? new Set(codes) : null;
}

/** Extract the first JSON object/array in a reply (fenced or bare). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const candidates = fenced ? [fenced[1] as string, text] : [text];
  for (const candidate of candidates) {
    const start = candidate.search(/[[{]/);
    if (start === -1) continue;
    const slice = candidate.slice(start);
    for (let end = slice.length; end > 1; end -= 1) {
      const last = slice[end - 1];
      if (last !== "}" && last !== "]") continue;
      try {
        return JSON.parse(slice.slice(0, end));
      } catch {
        /* keep shrinking */
      }
    }
  }
  return null;
}

export interface DecisionValidation {
  accepted: Map<string, ScreeningDecision>;
  rejected: { id?: string; reason: string }[];
}

/**
 * Source validation: expected ID, no duplicate, label and code must agree.
 * Anything else is dropped; the record is retried or left pending.
 */
export function validateDecisions(
  replyText: string,
  expected: readonly string[],
  codes: ReadonlySet<string>,
): DecisionValidation {
  const accepted = new Map<string, ScreeningDecision>();
  const rejected: { id?: string; reason: string }[] = [];
  const parsed = extractJson(replyText);
  if (!parsed) {
    rejected.push({ reason: "reply contained no JSON object" });
    return { accepted, rejected };
  }
  const list =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { decisions?: unknown }).decisions)
        ? ((parsed as { decisions: unknown[] }).decisions)
        : null;
  if (!list) {
    rejected.push({ reason: "reply JSON has no decisions array" });
    return { accepted, rejected };
  }
  const allow = new Set(expected);
  for (const item of list) {
    if (!item || typeof item !== "object") {
      rejected.push({ reason: "decision is not an object" });
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    if (!id) {
      rejected.push({ reason: "decision has no id" });
      continue;
    }
    if (!allow.has(id)) {
      rejected.push({ id, reason: "id is not in the records this call was given" });
      continue;
    }
    if (accepted.has(id)) {
      rejected.push({ id, reason: "duplicate decision" });
      continue;
    }
    const d = record.d;
    const code = record.code;
    const why = record.why;
    if (d !== "include" && d !== "unclear" && d !== "exclude") {
      rejected.push({ id, reason: "d must be include, unclear or exclude" });
      continue;
    }
    if (typeof code !== "string") {
      rejected.push({ id, reason: "code is required" });
      continue;
    }
    // srlib.valid_decision checks d/code only; merge_decisions.py accepts a
    // missing why. Do not reject a decision the source merge would accept.
    const whyText = typeof why === "string" ? why.trim() : "";
    const consistent =
      (d === "include" && code === "INC") ||
      (d === "unclear" && code === "UNC") ||
      (d === "exclude" && codes.has(code));
    if (!consistent) {
      rejected.push({ id, reason: `label ${d} and code ${code} disagree` });
      continue;
    }
    const decision: ScreeningDecision = { id, d, code, why: whyText };
    if (typeof record.where === "string" && record.where.trim()) {
      decision.where = record.where.trim();
    }
    accepted.set(id, decision);
  }
  return { accepted, rejected };
}

function missingPrompt(
  prompt: string,
  role: string,
  missing: readonly string[],
): string {
  const header = [
    `RETRY: your previous reply omitted ${missing.length} record(s).`,
    `Return exactly one object {id, d, code, why} for each of these IDs: ${missing.join(", ")}.`,
    "Reply with only the JSON object {\"decisions\": [...]}.",
    "",
    "--- original task ---",
    "",
  ].join("\n");
  return `${header}${prompt}`;
}

/** Dispatch every emitted prompt into its own independent session. */
export async function runScreening(
  options: ScreeningRunOptions,
): Promise<ScreeningRunResult> {
  const { plan, port } = options;
  if (!options.approve) {
    throw new Error(
      "screening dispatch needs explicit cost approval; pass approve=true only after the user approved the call count and models",
    );
  }
  if (plan.missingModels.length) {
    throw new Error(
      `screening is blocked: no OpenCode model mapping for ${plan.missingModels.join("; ")}`,
    );
  }
  if (plan.missingFiles.length) {
    throw new Error(
      `screening is blocked: missing files ${plan.missingFiles.join(", ")}`,
    );
  }
  if (plan.unreadablePdfs.length) {
    throw new Error(
      `full-text screening is blocked: unreadable PDFs ${plan.unreadablePdfs.join(", ")}`,
    );
  }

  const results: ScreeningRunResult["results"] = [];
  const pending: ScreeningRunResult["pending"] = [];
  const rejected: ScreeningRunResult["rejected"] = [];
  const sessions: string[] = [];
  const routes: {
    label: string;
    role: string;
    requested: string;
    effective: string;
    sessionID: string;
  }[] = [];
  let calls = 0;

  for (const entry of plan.entries) {
    const role = roleOf(entry.label) as string;
    const accepted = new Map<string, ScreeningDecision>();
    let expected: string[] = [];
    let missing: string[] = [];
    let sessionID: string | undefined;
    try {
      // Parse inside the per-entry boundary: one malformed prompt must not
      // discard decisions already bought from earlier reviewer calls.
      const prompt = readFileSync(entry.prompt_file, "utf8");
      const parsedExpected = parseExpectedIds(prompt);
      if (!parsedExpected) {
        throw new Error(
          `cannot derive the expected record IDs from ${entry.prompt_file}; refusing to dispatch an unvalidated call`,
        );
      }
      expected = parsedExpected;
      missing = [...expected];
      const codes = parseExclusionCodes(prompt);
      if (!codes) {
        throw new Error(
          `cannot derive the exclusion codes from ${entry.prompt_file}; refusing to dispatch an unvalidated call`,
        );
      }

      sessionID = await port.create(`ARS screening ${entry.label}`);
      sessions.push(sessionID);
      await port.switchAgent(sessionID, bareReviewerAgentType(SCREENING_AGENT));

      // Apply and verify the role model before any prompt is admitted.
      if (entry.model) {
        const roleModel = options.roleModels?.[role];
        if (!roleModel) {
          throw new Error(
            `no OpenCode model mapping for screening role ${role}; the call was not dispatched`,
          );
        }
        if (
          options.availableModels &&
          !options.availableModels.some(
            (model) =>
              model.providerID === roleModel.providerID &&
              model.id === roleModel.model,
          )
        ) {
          throw new Error(
            `screening role ${role} maps to ${roleModel.providerID}/${roleModel.model}, which this host does not offer; the call was not dispatched`,
          );
        }
        await port.switchModel(sessionID, roleModel);
        const applied = await port.sessionModel(sessionID);
        if (
          !applied ||
          applied.providerID !== roleModel.providerID ||
          applied.id !== roleModel.model
        ) {
          throw new Error(
            `screening role ${role} could not be routed: expected ${roleModel.providerID}/${roleModel.model}, effective ${applied ? `${applied.providerID}/${applied.id}` : "none"}; the call was not dispatched`,
          );
        }
        routes.push({
          label: entry.label,
          role,
          requested: entry.model,
          effective: `${roleModel.providerID}/${roleModel.model}`,
          sessionID,
        });
      } else {
        routes.push({
          label: entry.label,
          role,
          requested: "inherit",
          effective: "inherit",
          sessionID,
        });
      }

      calls += 1;
      await port.prompt(sessionID, prompt);
      await port.wait(sessionID);
      let text = await port.lastAssistantText(sessionID);
      let validation = validateDecisions(text, expected, codes);
      for (const [id, decision] of validation.accepted) accepted.set(id, decision);
      rejected.push(
        ...validation.rejected.map((item) => ({
          label: entry.label,
          id: item.id,
          reason: item.reason,
        })),
      );
      missing = expected.filter((id) => !accepted.has(id));

      if (missing.length) {
        try {
          calls += 1;
          await port.prompt(sessionID, missingPrompt(prompt, role, missing));
          await port.wait(sessionID);
          text = await port.lastAssistantText(sessionID);
          validation = validateDecisions(text, missing.slice(), codes);
          for (const [id, decision] of validation.accepted) {
            accepted.set(id, decision);
          }
          rejected.push(
            ...validation.rejected.map((item) => ({
              label: entry.label,
              id: item.id,
              reason: item.reason,
            })),
          );
          missing = expected.filter((id) => !accepted.has(id));
        } catch (retryError) {
          // Keep the decisions already accepted from the first reply; only
          // the still-missing records remain pending.
          rejected.push({
            label: entry.label,
            reason: `retry failed: ${(retryError as Error).message}`,
          });
          missing = expected.filter((id) => !accepted.has(id));
        }
      }
    } catch (error) {
      // A failed prompt/session/model route leaves its records pending; it never
      // fills them in and never stops the rest of the run.
      rejected.push({
        label: entry.label,
        reason: `dispatch failed: ${(error as Error).message}`,
      });
      missing = expected.filter((id) => !accepted.has(id));
    } finally {
      results.push({
        label: entry.label,
        decisions: expected
          .filter((id) => accepted.has(id))
          .map((id) => accepted.get(id) as ScreeningDecision),
      });
      if (missing.length) pending.push({ label: entry.label, missing });
      options.onProgress?.(
        `${entry.label}: ${accepted.size}/${expected.length} decided${missing.length ? `, ${missing.length} pending` : ""}`,
      );
      if (sessionID) {
        try {
          await port.remove(sessionID);
        } catch {
          /* the session may already be gone */
        }
      }
    }
  }

  // The primary file is a plain array of {label, decisions}: that is the shape
  // merge_decisions.py accepts. Audit detail goes to a sidecar so the merge
  // input stays exactly the source contract.
  writeFileSync(
    resolve(options.outFile),
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8",
  );
  const auditFile = options.outFile.replace(/\.json$/i, "") + ".audit.json";
  writeFileSync(
    resolve(auditFile),
    `${JSON.stringify(
      {
        version: 1,
        stage: plan.stage,
        context_id: plan.contextID,
        calls,
        max_calls: plan.maxCalls,
        sessions,
        routes,
        pending,
        rejected,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    contextID: plan.contextID,
    results,
    pending,
    rejected,
    calls,
    sessions,
  };
}
