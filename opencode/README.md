# ARS OpenCode V2 adapter

A thin adapter that makes the Academic Research Skills (ARS) plugin usable in
OpenCode V2 **without copying or editing the ARS core**. The Claude Code files
stay the source of truth; this package only translates host contracts at
runtime.

Tested baseline (only this combination was exercised):

- Windows, OpenCode `v2.2.7`
- `@opencode/plugin` `2.2.7`
- Node.js 24 (the plugin and tests run TypeScript directly)

Other operating systems and other OpenCode/plugin versions are untested. The
adapter refuses to register when a required host-contract member is missing
instead of guessing.

**Real-host status.** An isolated OpenCode 2.2.7 project verified 5 skills,
16 commands, 4 configured agents, permission decisions, and real write/edit/
patch/move/delete executors. A local protocol fixture verified model IDs across
command turns and tool continuation without calling an external model. Actual
provider calls, native subagent dispatch, and the full research pipeline remain
unverified; see Development below. Tests also use the installed SDK, in-memory
callbacks, and real Python guard/screening fixtures, none of which substitutes
for full workflow acceptance.

## What is reused unchanged

- 5 skills (`academic-paper`, `academic-paper-reviewer`, `academic-pipeline`, `deep-research`, `sr-screener`)
- 16 `/ars-*` commands
- 4 plugin-exposed agents (`research-architect-agent`, `synthesis-agent`, `report-compiler-agent`, `screening-reviewer-agent`)
- `scripts/ars_write_scope_guard.py` and `scripts/ars_phase_scope_manifest.json`
- `sr-screener/scripts/*.py` and `sr-screener/templates/*`

Core source and user configuration are not automatically rewritten. There is no
background job, scheduled maintenance, publish, commit, or paid run.

## Dependencies

- A real Python 3 interpreter for the write-scope guard and the three CLI
  commands (`ars-mark-read`, `ars-unmark-read`, `ars-cache-invalidate`).
  `py -3`, `python3`, and `python` are tried in that order; Microsoft Store
  stubs are rejected by requiring a marker output.
- PyYAML for the mark-read CLI and other Python tooling. Mark/unmark preflight
  checks its import using the selected interpreter; legitimate user-site
  dependencies are available to CLI commands, while the guard stays isolated.
- Pandoc/Tectonic only for modes that already require them in the ARS docs.
- Full-text screening needs readable PDF paths; title/abstract screening needs
  the batch files under `<work>/batches/`.

## Install (manual, preview only)

1. Add the plugin to your OpenCode config (global
   `~/.config/opencode/opencode.json(c)` or project `opencode.json(c)`):

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["./academic-research-skills/opencode"]
   }
   ```

   An absolute path also works. `repoRoot` is derived from the adapter's own
   location; set the `repoRoot` option only when the package is moved away from
   the ARS checkout.

2. Start OpenCode and run the read-only installation check:

   ```text
   Use the ars_opencode_status tool.
   ```

   This tool is the adapter's `setup --check` equivalent: it writes nothing and
   reports catalog counts, effective agent instructions/mode/permissions/models,
   command ownership, collisions, model mappings, guard status, and the four
   native agent IDs. It deliberately does **not** return all four agents' full
   `system` text at once: a single bundle is about 96 KB, above the host's
   default 51,200-byte tool-output limit.

3. Request one complete agent fragment at a time:

   ```text
   Use ars_opencode_status with agent = "synthesis-agent"
   ```

   Repeat for `research-architect-agent`, `report-compiler-agent`, and
   `screening-reviewer-agent`. Each response carries the plugin entry plus only
   `agents.<id>`, so it stays well below the output limit. Merge the plugin
   entry once and each `agents.<id>` entry by hand. The adapter never writes
   configuration. A colliding command, skill or agent is a setup error:
   registration is refused rather than partially applied.

4. Reload (`/reload`) and check that `/ars-full`, the five skills, and the four
   agents resolve.

   The generated agent instructions embed the project root. Regenerate and
   re-merge the fragment when you move the checkout or use ARS in a different
   project; one global fragment cannot serve multiple project roots. A
   collision with an existing agent is refused rather than overwritten.

The adapter also registers two other tools: `ars_run_script` (shell-free CLI
execution, host-permission checked) and `ars_screening` (sr-screener dispatch).
Both are refused for the four native ARS subagents, whose tool boundary stays
the source `tools:` list.

OpenCode commands are user-invoked by the host; the adapter preserves the
source `disable-model-invocation` flag as metadata and does not expose a
model-callable command tool.

## Models

OpenCode has no Claude `sonnet`/`opus` aliases. The adapter enforces explicit
mappings:

- every command that declares a Claude alias must have `models.aliases.<alias>`;
  a missing or unavailable mapping **blocks that invocation** before any prompt
  is admitted — there is no inheritance fallback;
- command aliases are routed per request through the host's
  `experimental.model.resolve` hook, which OpenCode documents as same-provider
  only. The alias is bound to the admitted command prompt by a route tag and
  follows that turn's primary requests, including tool continuations. An
  unrelated prompt cannot consume it; if the route cannot be correlated, the
  request is blocked visibly instead of inheriting. Routes are released on
  normal idle and on the documented failure/interruption execution events, so
  the next aliased command in the same session can run. If the mapped model is
  on another provider than the current session, the command blocks with an
  actionable message instead of silently using the session model;
- native agents stay on source inheritance unless `models.agents.<id>` is set,
  and the installation check verifies the effective agent model;
- the status tool records the last routes actually applied.

```jsonc
{
  "plugins": [
    {
      "package": "./academic-research-skills/opencode",
      "options": {
        "repoRoot": "C:/work/academic-research-skills",
        "models": {
          "aliases": {
            "sonnet": { "providerID": "your-provider", "model": "your-model" },
            "opus": { "providerID": "your-provider", "model": "your-other-model" }
          },
          "agents": {
            "synthesis-agent": { "providerID": "your-provider", "model": "your-other-model" }
          }
        },
        "screening": {
          "roles": {
            "A": { "providerID": "your-provider", "model": "your-model" },
            "B": { "providerID": "your-provider", "model": "your-model" },
            "ADJ": { "providerID": "your-provider", "model": "your-model" },
            "QC": { "providerID": "your-provider", "model": "your-model" },
            "FTA": { "providerID": "your-provider", "model": "your-model" },
            "FTB": { "providerID": "your-provider", "model": "your-model" },
            "FTADJ": { "providerID": "your-provider", "model": "your-model" }
          }
        }
      }
    }
  ]
}
```

The seven screening roles must each be mapped when the emitted
`screening_config.json` names a model for them. The dispatcher switches each
child session's model, reads the effective model back, and refuses to prompt if
it does not match. Missing mappings block the dispatch.

## Write scope and permissions

The native permission matrix mirrors each agent's source `tools:` list:

- `screening-reviewer-agent` is read-only (no edit, no shell, no subagent, no web).
- `synthesis-agent` and `research-architect-agent` keep edit but lose shell,
  subagent, web, and skill actions.
- `report-compiler-agent` keeps edit and loses shell, subagent, web, and skill.

The CLI tool and the three CLI commands ask the host to evaluate `edit` on the
real write targets before starting a child process; targets outside the project
also pass the host's `external_directory` gate. The read-only reviewer is
refused outright.

The phase fence is **not** reimplemented. On every `edit` and `shell`
permission evaluation the adapter resolves the trusted actor — the explicit
hook actor when present, otherwise `ctx.session.get({ sessionID }).agent` — and
passes that ID and all targets to `scripts/ars_write_scope_guard.py`, then
forwards only a `deny`. If no trusted agent identity can be resolved, that
operation is denied visibly rather than treated as unscoped. A pass-through
leaves the host decision untouched, so the adapter can only narrow access,
never widen it.

Trusted roots are separated: the ARS checkout (`repoRoot`, derived from the
package location or the explicit option) and the current project
(`ctx.location.project.canonical`). Ambient `CLAUDE_*` variables are removed
from the guard child and from shell children, then the two roots are set
explicitly.

### Degraded modes (visible, never fail-open)

The guard is optional hardening. If no real Python is found, the guard script is
missing, a run times out, exits non-zero, prints unparseable output, or relays a
guard advisory (for example an unreadable manifest), the adapter passes the host
decision through and reports `degraded` in `ars_opencode_status` and in one
console warning. It never emits `allow` or `ask` on its own.

Only the two native Bucket A subagents are fenced (`synthesis-agent`,
`research-architect-agent`). Roles that run inline in a main session are not
fenced by the guard, matching the source scope. Reviewer independence for
screening comes from separate read-only sessions, not from the write guard.

## Commands and the three CLI wrappers

`/ars-full`, `/ars-*` mode commands, and the remaining commands are registered
with their original bodies. The adapter rewrites `${CLAUDE_PLUGIN_ROOT}` to the
trusted package root, explains OpenCode tool names, expands `$ARGUMENTS`, and
passes file/agent/skill attachments through (mention offsets are remapped).

Three commands are CLI wrappers and are **not** handed to a shell:

- `ars-cache-invalidate`
- `ars-mark-read`
- `ars-unmark-read`

The invocation arguments are tokenized deterministically (quotes and
backslashes only, no expansion), then validated for option/value pairing,
positional counts, duplicate flags, `--scope` values, `--locator` context,
`--note` context, and conflicting `--unmark` flags before any process starts.
The allowlist is a second check. There is no shell string and no model-assisted
parsing.

`ars-mark-read`/`ars-unmark-read` need the active Material Passport path. If the
invocation and `ARS_PASSPORT_PATH` both lack `--passport-path`, the adapter
returns an actionable no-execution message; it does not guess or hand the
arguments to the model. Before any CLI runs, the adapter asks the host to
evaluate `edit` on the real targets (the peer `_human_read_log.yaml` and its
lock, or the verification cache database). All four native ARS subagents are
refused outright by both adapter tools, so this tool cannot become an escape
hatch around their source `tools:` boundary. The same check runs for the three
slash commands.

## Screening dispatch

```bash
python sr-screener/scripts/build_workflow.py ta \
  --work W --protocol protocol.md --config screening_config.json \
  --jobs pilot --emit-prompts W/prompts
```

Then call `ars_screening` with `{ "stage": "ta", "work": "W", "emit": "W/prompts" }`
(optionally `out`). Without `"approve": true` the tool returns the call-count
preview and dispatches nothing; set it only after the user has approved that
preview. The adapter:

1. validates `label@context_id`, batch files or PDFs, and the seven role models;
   it also re-verifies the installed `screening-reviewer-agent` system, mode,
   permissions and model at the dispatch boundary, and blocks before any child
   session or cost prompt if that contract differs;
2. warns when the emitted prompts are bound to a stale context (a profile change
   archives earlier decisions);
3. asks the host to evaluate `edit` on the results file and its `.audit.json`
   sidecar before writing either;
4. calls the host permission check
   `permission.assert({ action: "ars_screening_dispatch", resources: [plan] })`
   for the initial calls **and** the bounded one-retry-per-call maximum. A
   confirmation prompt appears only when your permission rules make that action
   `ask` or stricter; if a global rule allows it automatically, the adapter does
   not add a second confirmation. Configure it explicitly, for example:

   ```jsonc
   {
     "permissions": [
       { "action": "ars_screening_dispatch", "resource": "*", "effect": "ask" }
     ]
   }
   ```
5. dispatches each prompt into its own fresh `screening-reviewer-agent` session
   (no peer outputs are visible), applies the configured role model, and reads
   the effective model back before prompting;
6. applies the source decision checks (`d`/`code` agreement, expected IDs,
   duplicates), retries once for missing IDs, and leaves anything still missing
   pending — never filled in by default. A retry failure keeps decisions already
   accepted from the first reply;
7. writes `opencode_screening_<stage>.json` as a plain array of
   `{ "label": "A:b001@<context>", "decisions": [...] }`, plus a
   `.audit.json` sidecar with pending/rejected items, actual call count, and the
   effective model route for each entry.

Merge with the unchanged script:

```bash
python sr-screener/scripts/merge_decisions.py --work W --from W/opencode_screening_ta.json --config screening_config.json --protocol protocol.md --stage ta
```

The pilot gate, protocol identity, and revision archiving remain owned by the
Python tooling.

## Update and uninstall

- **Update:** pull the ARS checkout; the adapter reads files at load time.
  Re-run `npm ci`, `npm run typecheck`, and `npm test` in `opencode/` when the
  adapter itself changed. Re-run `ars_opencode_status` after a source change.
- **Uninstall:** remove the plugin entry from your config and delete the merged
  `agents` entries. Nothing else was written, so there is nothing else to clean.
- **Move the checkout:** set `repoRoot` to the new absolute path and regenerate
  the preview fragment; do not copy stale paths.

## Development

```bash
cd opencode
npm ci
npm run typecheck
npm test
```

`npm ci` reports 24 moderate advisories, with no high or critical findings.
`npm audit` attributes the direct risk to the required
`@opencode/plugin@2.2.7` dependency and its `@opencode/util` npm toolchain.
That direct chain has no fix available, but three transitive packages report
`fixAvailable: true`. They are reported, not automatically fixed or suppressed;
no audit fix or lockfile update is applied here.

The tests cover catalog counts (5/16/4), `$ARGUMENTS` and attachment remapping,
argv tokenization/pairing/conflict validation, the real Python guard (in-scope
allow, out-of-scope and shell deny, move/delete resource coverage, user files
with infra names, malformed targets, timeout/malformed degradation,
environment isolation, host ask/deny preservation), model routing (hook
application, missing/unavailable/cross-provider blocks, no fallback), native
permission matrices and effective-agent diagnostics, script-tool permission
checks, hard denials for all four native ARS agents on both adapter mutation
tools, per-agent status fragments (size and full `system` content), and real
Python TA/ADJ/QC/FT prompt fixtures with routed role models and a real
`merge_decisions.py` pass. Real cache CLI tests assert exit status, DB creation,
WAL/SHM permission coverage, and no package-local bytecode. A host permission
deny is exercised before execution.

Independent Windows/OpenCode 2.2.7 probes also checked registration, explicit
and session-derived permission actors, and real built-in write/edit/patch
(including move/delete) executors. Refused mutations left files unchanged.
Reviewer dispatch checks detected a missing agent, changed instructions, and
weakened permissions. A loopback-only protocol fixture verified command model
IDs across sequential turns and a real host tool continuation; it was not a
real model or external provider. Probe evidence stays private.

Still unverified: real provider model routing, native subagent dispatch,
interruption/recovery, screening approval UI, and the complete academic
pipeline. These require separately approved samples, models, and budget.
The in-memory host in `tests/runtime.test.ts` proves callback behavior only;
the direct host probes do not by themselves prove a model-driven workflow.
