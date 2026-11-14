/**
 * Pure Markdown rendering for native OpenCode agents.
 *
 * OpenCode V2 discovers subagents from Markdown files
 * (`.opencode/agents/<id>.md` or `~/.config/opencode/agents/<id>.md`) and reads
 * the frontmatter as the same fields as an `agents.<id>` configuration entry.
 * This module owns only the text form: paths, rendering and digests. It imports
 * no installer code, so the ownership/migration branches can reuse it without a
 * cycle.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { NativeAgentSpec, PermissionRule } from "./setup.ts";

/** One agent's Markdown path inside a resolved `agents` directory. */
export function agentFilePath(agentsDir: string, id: string): string {
  return join(agentsDir, `${id}.md`);
}

/** Content digest used as the ownership record for one Markdown agent. */
export function agentMarkdownDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Ownership digest for a Markdown agent file on disk: CRLF line endings are
 * folded to LF before hashing, so a file that only gained Windows line endings
 * still matches the digest the installer wrote. The installer always writes
 * the canonical LF form, so this digest equals `agentMarkdownDigest` for it.
 */
export function agentMarkdownOwnershipDigest(content: string): string {
  return agentMarkdownDigest(content.replace(/\r\n/g, "\n"));
}

/** YAML plain scalars that a reader would otherwise coerce or misparse. */
const RESERVED_SCALARS = new Set([
  "true",
  "false",
  "null",
  "~",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
]);

/**
 * Render one scalar safely. Values that are visibly plain and unambiguous stay
 * readable; everything else is double-quoted with escaped `"` and `\`.
 */
function yamlScalar(value: string): string {
  const plain =
    value !== "" &&
    !RESERVED_SCALARS.has(value.toLowerCase()) &&
    !/^[0-9]/.test(value) &&
    /^[A-Za-z0-9_][A-Za-z0-9_ .,()/#-]*$/.test(value) &&
    !/[:#-]$/.test(value) &&
    !/: | #/.test(value) &&
    !/\s$/.test(value);
  if (plain) return value;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** `provider/model` with the optional `#variant` suffix. */
function modelScalar(agent: NativeAgentSpec): string | undefined {
  const model = agent.model;
  if (!model) return undefined;
  const base = `${model.providerID}/${model.model}`;
  return model.variant ? `${base}#${model.variant}` : base;
}

function renderPermissions(rules: readonly PermissionRule[]): string[] {
  const lines = ["permissions:"];
  for (const rule of rules) {
    lines.push(`  - action: ${yamlScalar(rule.action)}`);
    lines.push(`    resource: ${yamlScalar(rule.resource)}`);
    lines.push(`    effect: ${yamlScalar(rule.effect)}`);
  }
  return lines;
}

/**
 * Serialize one agent as a Markdown agent file.
 *
 * The body is the exact `NativeAgentSpec.system` text (source prompt, host note
 * and compatibility note); only a single trailing newline is added so the file
 * ends like any other Markdown file.
 */
export function renderAgentMarkdown(agent: NativeAgentSpec): string {
  const header = [
    "---",
    `description: ${yamlScalar(agent.description)}`,
    `mode: ${yamlScalar(agent.mode)}`,
  ];
  const model = modelScalar(agent);
  if (model) header.push(`model: ${yamlScalar(model)}`);
  header.push(...renderPermissions(agent.permissions));
  header.push("---");
  const body = agent.system.replace(/\r\n/g, "\n");
  return `${header.join("\n")}\n\n${body.endsWith("\n") ? body : `${body}\n`}`;
}
