import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  agentFilePath,
  agentMarkdownDigest,
  renderAgentMarkdown,
} from "../src/agent-storage.ts";
import { loadNativeAgents, type NativeAgentSpec } from "../src/setup.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

interface Baseline {
  schemaVersion: number;
  agents: Record<
    string,
    {
      description: string;
      bodySha256: string;
      mode: string;
      model: string | null;
      permissionCount: number;
      frontmatter: string;
    }
  >;
  variant: { id: string; model: string; frontmatter: string };
}

const baseline = JSON.parse(
  readFileSync(join(fixtureRoot, "agent-storage-baseline.json"), "utf8"),
) as Baseline;

function load(
  models?: Parameters<typeof loadNativeAgents>[1],
): NativeAgentSpec[] {
  const result = loadNativeAgents(repoRoot, models ?? {}, [], {
    validateModels: false,
  });
  assert.deepEqual(result.problems, []);
  return result.agents;
}

function split(text: string): { frontmatter: string; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  assert.ok(normalized.startsWith("---\n"), "frontmatter fence");
  const end = normalized.indexOf("\n---", 4);
  assert.notEqual(end, -1, "closing fence");
  return {
    frontmatter: normalized.slice(4, end),
    // The blank line after the closing fence is a separator, not body content.
    body: normalized.slice(end + 4).replace(/^\n+/, ""),
  };
}

function withDescription(agent: NativeAgentSpec, description: string): NativeAgentSpec {
  return { ...agent, description };
}

test("agentFilePath keeps the agent id as the file name in the given directory", () => {
  assert.equal(
    agentFilePath(join("project", ".opencode", "agents"), "synthesis-agent"),
    join("project", ".opencode", "agents", "synthesis-agent.md"),
  );
  assert.equal(
    agentFilePath(join("home", ".config", "opencode", "agents"), "screening-reviewer-agent"),
    join("home", ".config", "opencode", "agents", "screening-reviewer-agent.md"),
  );
});

test("every rendered agent keeps its exact system prompt as the body", () => {
  for (const agent of load()) {
    const { body } = split(renderAgentMarkdown(agent));
    assert.equal(body, `${agent.system}\n`, agent.id);
    assert.equal(body.endsWith("\n\n"), false, `${agent.id} has exactly one trailing newline`);
  }
});

test("frontmatter matches the checked-in baseline for all four agents", () => {
  const rendered = load();
  assert.deepEqual(
    rendered.map((agent) => agent.id).sort(),
    Object.keys(baseline.agents).sort(),
  );
  for (const agent of rendered) {
    const expected = baseline.agents[agent.id]!;
    const { frontmatter } = split(renderAgentMarkdown(agent));
    assert.equal(frontmatter, expected.frontmatter, agent.id);
    assert.equal(agent.description, expected.description, `${agent.id} description`);
    const portableBody = agent.system
      .replaceAll(repoRoot.replace(/\\/g, "/"), "<package-root>")
      .replace(/\r\n/g, "\n");
    assert.equal(
      createHash("sha256").update(portableBody).digest("hex"),
      expected.bodySha256,
      `${agent.id} portable body digest`,
    );
    assert.equal(agent.mode, expected.mode, `${agent.id} mode`);
    assert.equal(agent.model ?? null, expected.model, `${agent.id} model`);
    assert.equal(agent.permissions.length, expected.permissionCount, `${agent.id} permissions`);
  }
});

test("permission rules keep source order, one list item per rule", () => {
  for (const agent of load()) {
    const { frontmatter } = split(renderAgentMarkdown(agent));
    const triples = [...frontmatter.matchAll(
      /^ {2}- action: (.+)\n {4}resource: (.+)\n {4}effect: (.+)$/gm,
    )].map((match) => ({
      action: match[1]!,
      resource: match[2]!,
      effect: match[3]!,
    }));
    assert.deepEqual(
      triples,
      agent.permissions.map((rule) => ({
        action: rule.action,
        resource: JSON.stringify(rule.resource),
        effect: rule.effect,
      })),
      agent.id,
    );
  }
});

test("a model variant renders as provider/model#variant and matches the baseline", () => {
  const agents = load({
    models: {
      agents: {
        "synthesis-agent": { providerID: "probe", model: "model", variant: "high" },
      },
    },
  });
  const synthesis = agents.find((agent) => agent.id === "synthesis-agent");
  assert.ok(synthesis);
  assert.equal(synthesis.model?.variant, "high");
  const { frontmatter } = split(renderAgentMarkdown(synthesis));
  assert.match(frontmatter, /^model: probe\/model#high$/m);
  assert.equal(frontmatter, baseline.variant.frontmatter);
  assert.equal(baseline.variant.id, "synthesis-agent");
  assert.equal(baseline.variant.model, "probe/model#high");
  // The other agents keep no model line at all.
  for (const agent of agents.filter((item) => item.id !== "synthesis-agent")) {
    assert.doesNotMatch(split(renderAgentMarkdown(agent)).frontmatter, /^model:/m, agent.id);
  }
});

test("YAML-hostile descriptions are quoted; double-quoted scalars are JSON-parseable", () => {
  const [agent] = load();
  assert.ok(agent);
  const cases: [string, (line: string) => boolean][] = [
    ["Blinded reviewer for sr-screener: applies a protocol", (line) => /^description: ".*"$/.test(line)],
    ["plain description without punctuation", (line) => /^description: plain description without punctuation$/.test(line)],
    ["ends with a colon:", (line) => /^description: ".*"$/.test(line)],
    ["has a # hash", (line) => /^description: ".*"$/.test(line)],
    ["true", (line) => /^description: "true"$/.test(line)],
    ["2024", (line) => /^description: "2024"$/.test(line)],
    ["1.5", (line) => /^description: "1.5"$/.test(line)],
    ["0x1F", (line) => /^description: "0x1F"$/.test(line)],
    ["2024-01-01", (line) => /^description: "2024-01-01"$/.test(line)],
    ["quote \" and backslash \\ inside", (line) => /^description: ".*"$/.test(line)],
    ["line one\nline two", (line) => /^description: ".*\\n.*"$/.test(line)],
    ["", (line) => line === 'description: ""'],
  ];
  for (const [description, acceptable] of cases) {
    const { frontmatter } = split(
      renderAgentMarkdown(withDescription(agent, description)),
    );
    const line = frontmatter.split("\n")[0]!;
    assert.ok(acceptable(line), `${JSON.stringify(description)} rendered as ${line}`);
    if (line.startsWith('description: "')) {
      const quoted = line.slice("description: ".length);
      assert.equal(JSON.parse(quoted), description, "quoted scalar round-trips");
    }
    // One frontmatter line per field: a raw newline would break the block.
    assert.equal(frontmatter.split("\n").filter((item) => item.startsWith("description:")).length, 1);
    assert.equal(frontmatter.includes('end with a colon: "'), false);
  }
});

test("the rendered file is project-portable and embeds no project directory", () => {
  const projectRoot = resolve(repoRoot, "..", "some-other-project");
  for (const agent of load()) {
    const text = renderAgentMarkdown(agent);
    assert.equal(text.includes(projectRoot), false, agent.id);
    assert.equal(text.includes(projectRoot.replace(/\\/g, "/")), false, agent.id);
    assert.match(text, /project-portable/, agent.id);
  }
});

test("the digest is a stable sha256 of the exact content", () => {
  const [agent] = load();
  assert.ok(agent);
  const content = renderAgentMarkdown(agent);
  assert.match(agentMarkdownDigest(content), /^[0-9a-f]{64}$/);
  assert.equal(agentMarkdownDigest(content), agentMarkdownDigest(content));
  assert.notEqual(agentMarkdownDigest(content), agentMarkdownDigest(`${content}\n`));
  assert.equal(
    agentMarkdownDigest(content),
    baselineDigest(content),
    "cross-checks the digest against node:crypto",
  );
});

/** Independent sha256 so the module's own helper is not the only witness. */
function baselineDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
