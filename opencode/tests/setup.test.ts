import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import {
  bareReviewerAgentType,
  formatSetupReport,
  loadNativeAgents,
  permissionsForTools,
  planInstallation,
  samePermissions,
  type HostSnapshot,
  type ModelInfoLike,
  type PermissionRule,
} from "../src/setup.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const catalog = loadCatalog(repoRoot);
const models: ModelInfoLike[] = [
  { providerID: "anthropic", id: "claude-sonnet-4-5" },
  { providerID: "anthropic", id: "claude-opus-4-1" },
];

function host(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    agents: [],
    skills: [],
    commands: [],
    models,
    capabilities: {
      skillTransform: true,
      commandTransform: true,
      toolTransform: true,
      permissionHook: true,
      sessionHook: true,
      shellHook: true,
    },
    ...overrides,
  };
}

test("four native agents are derived from the source files", () => {
  const { agents, problems } = loadNativeAgents(
    repoRoot,
    {},
    models,
  );
  assert.deepEqual(problems, []);
  assert.equal(agents.length, 4);
  assert.deepEqual(
    agents.map((agent) => agent.id).sort(),
    [
      "report-compiler-agent",
      "research-architect-agent",
      "screening-reviewer-agent",
      "synthesis-agent",
    ],
  );
  for (const agent of agents) {
    assert.equal(agent.mode, "subagent");
    assert.ok(agent.system.includes("Academic Research Skills compatibility"));
    assert.ok(agent.permissions.length > 0);
    assert.equal(agent.model, undefined, "source model inherit is preserved");
  }
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  assert.match(
    byId.get("synthesis-agent")?.system ?? "",
    /Write only inside the phase directory/,
  );
  assert.doesNotMatch(
    byId.get("report-compiler-agent")?.system ?? "",
    /Write only inside the phase directory/,
    "Bucket B must not receive a phase restriction the source does not have",
  );
});

test("installed agents are verified by system, mode, permissions and model", async () => {
  const { agents: specs } = loadNativeAgents(repoRoot, {}, models);
  const installed = (overrides: Record<string, unknown> = {}) =>
    host({
      agents: specs.map((agent) => ({
        id: agent.id,
        system: agent.system,
        mode: agent.mode,
        permissions: agent.permissions,
        model: agent.model,
        ...(overrides[agent.id] as object | undefined),
      })),
    });
  const ownedCommands = new Set(catalog.commands.map((command) => command.name));
  const ownedSkills = new Set(catalog.skills.map((skill) => skill.name));

  const expected = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: installed(),
    adapter: {},
    ownedCommands,
    ownedSkills,
    strictAgents: true,
  });
  assert.ok(
    !expected.checks.some(
      (check) => check.id === "agent" && /is not installed/.test(check.detail),
    ),
  );
  assert.ok(
    expected.checks.some(
      (check) =>
        check.id === "agent-collision" &&
        check.status === "ok" &&
        /screening-reviewer-agent/.test(check.detail),
    ),
  );

  const reviewer = specs.find((agent) => agent.id === "screening-reviewer-agent");
  assert.ok(reviewer);

  const HOST_DEFAULTS: PermissionRule[] = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
  ];
  // Observed on real OpenCode 2.2.7: the host appends these after agent rules.
  const HOST_TAILS: PermissionRule[] = [
    { action: "browser", resource: "*", effect: "deny" },
    { action: "skill", resource: "browser", effect: "deny" },
  ];
  const realHostPermissions = (rules: readonly PermissionRule[]) => [
    ...HOST_DEFAULTS,
    ...rules,
    ...HOST_TAILS,
  ];

  const withHostDefaults = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: host({
      agents: specs.map((agent) => ({
        id: agent.id,
        system: agent.system,
        mode: agent.mode,
        permissions: realHostPermissions(agent.permissions),
        model: agent.model,
      })),
    }),
    adapter: {},
    ownedCommands,
    ownedSkills,
    strictAgents: true,
  });
  assert.ok(
    !withHostDefaults.checks.some(
      (check) =>
        check.id === "agent-collision" &&
        check.status === "error" &&
        /screening-reviewer-agent/.test(check.detail),
    ),
  );

  const widened = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: installed({
      "screening-reviewer-agent": {
        permissions: reviewer.permissions.filter(
          (rule) => !(rule.action === "edit" && rule.effect === "deny"),
        ),
      },
    }),
    adapter: {},
    ownedCommands,
    ownedSkills,
    strictAgents: true,
  });
  assert.ok(
    widened.checks.some(
      (check) =>
        check.id === "agent-collision" &&
        check.status === "error" &&
        /screening-reviewer-agent.*permissions/.test(check.detail),
    ),
  );

  const synthesis = specs.find((agent) => agent.id === "synthesis-agent");
  assert.ok(synthesis);
  const configuredModel = { providerID: "anthropic", model: "claude-opus-4-1" };
  const modelMismatch = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: installed({
      "synthesis-agent": {
        model: { providerID: "anthropic", model: "claude-sonnet-4-5" },
      },
    }),
    adapter: { models: { agents: { "synthesis-agent": configuredModel } } },
    ownedCommands,
    ownedSkills,
    strictAgents: true,
  });
  assert.ok(
    modelMismatch.checks.some(
      (check) =>
        check.id === "agent-collision" &&
        check.status === "error" &&
        /model/.test(check.detail),
    ),
  );
});

test("real host permission shape keeps the expected block contiguous", () => {
  const expected = permissionsForTools(new Set(["read", "grep"]));
  const defaults: PermissionRule[] = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
  ];
  const tails: PermissionRule[] = [
    { action: "browser", resource: "*", effect: "deny" },
    { action: "skill", resource: "browser", effect: "deny" },
  ];
  const effective = [...defaults, ...expected, ...tails];

  assert.equal(samePermissions(expected, effective), true);

  const appendedEditAllow = [
    ...effective,
    { action: "edit", resource: "*", effect: "allow" as const },
  ];
  assert.equal(samePermissions(expected, appendedEditAllow), false);

  const appendedScopedEditAllow = [
    ...effective,
    { action: "edit", resource: "phase3_*/**", effect: "allow" as const },
  ];
  assert.equal(samePermissions(expected, appendedScopedEditAllow), false);

  const appendedWildcardAllow = [
    ...effective,
    { action: "*", resource: "*", effect: "allow" as const },
  ];
  assert.equal(samePermissions(expected, appendedWildcardAllow), false);

  const appendedEditAsk = [
    ...effective,
    { action: "edit", resource: "*", effect: "ask" as const },
  ];
  assert.equal(samePermissions(expected, appendedEditAsk), false);

  const widenedShell = expected.map((rule) =>
    rule.action === "shell" && rule.effect === "deny"
      ? { ...rule, effect: "allow" as const }
      : rule,
  );
  assert.equal(samePermissions(widenedShell, effective), false);

  const withoutDeny = expected.filter(
    (rule) => !(rule.action === "shell" && rule.effect === "deny"),
  );
  assert.equal(samePermissions(withoutDeny, effective), false);

  const interleaved = [
    ...defaults,
    ...expected.slice(0, 2),
    { action: "edit", resource: "*", effect: "allow" as const },
    ...expected.slice(2),
    ...tails,
  ];
  assert.equal(samePermissions(expected, interleaved), false);
});

test("a missing native agent is an error only in strict status mode", async () => {
  const { agents: specs } = loadNativeAgents(repoRoot, {}, models);
  const hostWithoutAgents = host();
  const preview = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: hostWithoutAgents,
    adapter: {},
    strictAgents: false,
  });
  assert.ok(
    preview.checks.some(
      (check) => check.id === "agent" && check.status === "warn",
    ),
  );
  const status = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: hostWithoutAgents,
    adapter: {},
    strictAgents: true,
  });
  assert.ok(
    status.checks.some(
      (check) => check.id === "agent" && check.status === "error",
    ),
  );
  assert.equal(specs.length, 4);
});

test("permission matrices mirror the source tool lists", () => {
  const reviewer = loadNativeAgents(repoRoot, {}, models).agents.find(
    (agent) => agent.id === "screening-reviewer-agent",
  );
  assert.ok(reviewer);
  assert.ok(
    reviewer.permissions.some(
      (rule) =>
        rule.action === "edit" && rule.resource === "*" && rule.effect === "deny",
    ),
  );
  assert.ok(
    reviewer.permissions.some(
      (rule) => rule.action === "read" && rule.effect === "allow",
    ),
  );
  assert.ok(
    reviewer.permissions.some(
      (rule) => rule.action === "shell" && rule.effect === "deny",
    ),
  );
  assert.ok(
    !reviewer.permissions.some(
      (rule) => rule.action === "edit" && rule.effect === "allow",
    ),
  );

  const synthesis = loadNativeAgents(repoRoot, {}, models).agents.find(
    (agent) => agent.id === "synthesis-agent",
  );
  assert.ok(synthesis);
  assert.ok(
    synthesis.permissions.some(
      (rule) => rule.action === "edit" && rule.effect === "allow",
    ),
  );
  assert.ok(
    synthesis.permissions.some(
      (rule) => rule.action === "shell" && rule.effect === "deny",
    ),
  );

  const empty = permissionsForTools(new Set());
  assert.ok(empty.some((rule) => rule.action === "edit" && rule.effect === "deny"));
});

test("every sr-screener reviewer spelling maps to the bare native ID", () => {
  assert.equal(bareReviewerAgentType("screening-reviewer-agent"), "screening-reviewer-agent");
  assert.equal(bareReviewerAgentType("screening_reviewer_agent"), "screening-reviewer-agent");
  assert.equal(
    bareReviewerAgentType("academic-research-skills:screening_reviewer_agent"),
    "screening-reviewer-agent",
  );
  assert.equal(bareReviewerAgentType("screening-reviewer-agent"), "screening-reviewer-agent");
  assert.equal(bareReviewerAgentType(undefined), "screening-reviewer-agent");
});

test("installation check reports a collision instead of overwriting", async () => {
  const report = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: host({
      agents: [
        {
          id: "synthesis-agent",
          system: "a different local agent with the same ID",
        },
      ],
    }),
    adapter: {},
  });
  assert.equal(report.ok, false);
  const collision = report.checks.find(
    (check) => check.id === "agent-collision",
  );
  assert.equal(collision?.status, "error");
  assert.match(collision?.detail ?? "", /refusing to overwrite/);
});

test("identical agent and skill installs are accepted", async () => {
  const { agents } = loadNativeAgents(repoRoot, {}, models);
  const synthesis = agents.find((agent) => agent.id === "synthesis-agent");
  assert.ok(synthesis);
  const report = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: host({
      agents: [{ id: "synthesis-agent", system: synthesis.system }],
      skills: [
        {
          id: "academic-pipeline",
          content: catalog.skills.find((skill) => skill.name === "academic-pipeline")
            ?.content,
        },
      ],
    }),
    adapter: {},
  });
  assert.equal(
    report.checks.find((check) => check.id === "agent-collision")?.status,
    "ok",
  );
  assert.equal(
    report.checks.find((check) => check.id === "skill-collision")?.status,
    "ok",
  );
});

test("existing commands are a collision, never silently replaced", async () => {
  const report = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: host({ commands: [{ name: "ars-full" }] }),
    adapter: {},
  });
  assert.equal(report.ok, false);
  assert.ok(
    report.checks.some(
      (check) => check.id === "command-collision" && check.status === "error",
    ),
  );

  const full = catalog.commands.find((command) => command.name === "ars-full");
  const unowned = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: host({
      commands: [{ name: "ars-full", description: full?.description }],
    }),
    adapter: {},
  });
  assert.equal(
    unowned.checks.find((check) => check.id === "command-collision")?.status,
    "error",
  );

  const owned = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: host({
      commands: [{ name: "ars-full", description: full?.description }],
    }),
    adapter: {},
    ownedCommands: new Set(["ars-full"]),
  });
  assert.equal(
    owned.checks.find((check) => check.id === "command-collision")?.status,
    "ok",
  );
});

test("model mappings are validated and never silently substituted", async () => {
  const unknown = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: host({ agents: [] }),
    adapter: {
      models: {
        agents: {
          "synthesis-agent": { providerID: "nope", model: "missing" },
        },
      },
    },
  });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.checks.some((check) => /does not offer/.test(check.detail)));

  const missing = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: host(),
    adapter: {},
  });
  const alias = missing.checks.find((check) => check.id === "model-alias");
  assert.equal(alias?.status, "error");
  assert.match(alias?.detail ?? "", /blocked until models\.aliases/);

  const mapped = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: host(),
    adapter: {
      models: { aliases: { sonnet: { providerID: "anthropic", model: "claude-sonnet-4-5" } } },
    },
  });
  assert.equal(
    mapped.checks.find((check) => check.id === "model-alias")?.status,
    "ok",
  );
});

test("missing host capabilities fail the installation check", async () => {
  const report = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: host({
      capabilities: {
        skillTransform: true,
        commandTransform: false,
        toolTransform: true,
        permissionHook: false,
        sessionHook: true,
        shellHook: true,
      },
    }),
    adapter: {},
  });
  assert.equal(report.ok, false);
  const contract = report.checks.find((check) => check.id === "host-contract");
  assert.equal(contract?.status, "error");
  assert.match(contract?.detail ?? "", /commandTransform/);
});

test("an external project fixture resolves 5/16/4 and is left untouched", async () => {
  const project = mkdtempSync(join(tmpdir(), "ars-project-"));
  const configPath = join(project, "opencode.json");
  const config = `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugins: [join(repoRoot, "opencode")],
    },
    null,
    2,
  )}\n`;
  writeFileSync(configPath, config, "utf8");
  try {
    const report = await planInstallation({
      catalog,
      projectRoot: project,
      host: host(),
      adapter: {},
    });
    assert.equal(report.agents.length, 4);
    assert.equal(catalog.skills.length, 5);
    assert.equal(catalog.commands.length, 16);
    const registration = report.checks.find(
      (check) => check.id === "registration",
    );
    assert.equal(registration?.status, "ok");
    // The check is read-only: the user's config is byte-identical afterwards.
    assert.equal(readFileSync(configPath, "utf8"), config);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("the preview fragment names the package, four agents and their permissions", async () => {
  const report = await planInstallation({
    catalog,
    projectRoot: repoRoot,
    host: host(),
    adapter: {},
  });
  assert.equal(report.agents.length, 4);
  const fragment = report.fragment as {
    plugins: { package: string; options: { repoRoot: string } }[];
    agents: Record<string, { mode: string; permissions: unknown[] }>;
  };
  assert.equal(fragment.plugins.length, 1);
  assert.match(fragment.plugins[0]?.package ?? "", /opencode/);
  assert.equal(fragment.plugins[0]?.options.repoRoot.replace(/\\/g, "/"), repoRoot.replace(/\\/g, "/"));
  assert.equal(Object.keys(fragment.agents).length, 4);
  assert.equal(fragment.agents["synthesis-agent"]?.mode, "subagent");
  assert.ok((fragment.agents["synthesis-agent"]?.permissions.length ?? 0) > 0);
  assert.match(formatSetupReport(report), /Preview fragment/);
});
