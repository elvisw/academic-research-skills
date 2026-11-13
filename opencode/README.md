# ARS OpenCode V2 adapter

> [简体中文](README.zh-CN.md)

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
patch/move/delete executors in the pre-installer baseline. The installation gate
also passed both channels at both scopes on Node `24.21.0`, with no skipped
cases: native skill/resource loading, assembled instructions, and legitimate/
ARS-refused writes in two locations of one global-config server. Configuration
presence alone is not acceptance. A real `/ars-full` run completed Stage 1–6 on
Windows 11 with `commandcode/deepseek/deepseek-v4.1-flash` (USD 0.2328), and all
16 public commands were invoked (15 stopped at their first checkpoint;
`/ars-full` was the complete workflow). One native subagent dispatch probe
succeeded. Full multi-agent orchestration (the pipeline dispatching native
subagents) remains unverified, as do PDF export, Windows durable ledger, and
Claude/Pi runtime regression; those are recorded limits in the acceptance
matrix. A local protocol fixture verified model IDs across command turns and
tool continuation without calling an external model. Tests also use the installed
SDK, in-memory callbacks, and real Python guard/screening fixtures, none of which
substitutes for full multi-agent orchestration acceptance.

## What is reused unchanged

- 5 skills (`academic-paper`, `academic-paper-reviewer`, `academic-pipeline`, `deep-research`, `sr-screener`)
- 16 `/ars-*` commands
- 4 plugin-exposed agents (`research-architect-agent`, `synthesis-agent`, `report-compiler-agent`, `screening-reviewer-agent`)
- `scripts/ars_write_scope_guard.py` and `scripts/ars_phase_scope_manifest.json`
- `sr-screener/scripts/*.py` and `sr-screener/templates/*`

Core source and user configuration are not automatically rewritten. There is no
background job, scheduled maintenance, publish, commit, or paid run.

## Dependencies

- Node 24+ and npm. Run `npm ci` in `opencode/` before the first install. Only
  Windows 11 + OpenCode 2.2.7 + Node 24 is validated; macOS and Linux paths are
  implemented but untested in this repository.
- A complete ARS checkout: the five skill directories, `.claude-plugin/`,
  `shared/`, `scripts/` and the checked-out `opencode/` package. The installer
  registers or copies those assets; it is not a standalone distribution.
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

## Quick install (from zero)

This is the shortest path to a project-scoped plugin install on Windows. Run
PowerShell from the ARS checkout and replace the two example paths.

1. **Check the prerequisites.**

   ```powershell
   node --version       # must be 24+
   opencode --version   # tested with 2.2.7; 2.3.0 is newer and untested
   py -3 --version
   py -3 -c "import yaml; print(yaml.__version__)"
   ```

   If PyYAML is missing for that interpreter, install it with
   `py -3 -m pip install pyyaml`. Without Python the write guard degrades
   visibly; without PyYAML the mark/unmark CLI commands fail.

2. **Install the adapter dependencies.**

   ```powershell
   cd "C:/work/academic-research-skills"
   npm --prefix opencode ci
   ```

3. **Choose the project that will use ARS.** The examples use
   `C:/research/my-project`; it must already exist and must not be the ARS
   checkout itself.

4. **Find a model ID and create the mapping file.**

   ```powershell
   opencode models
   ```

   Each line is `provider/model`. Pick a model that is available on the same
   provider as the session you will use. Create `C:/research/ars-models.json`:

   ```json
   {
     "aliases": {
       "sonnet": { "providerID": "your-provider", "model": "your-model" }
     }
   }
   ```

   The 16 source commands declare `model: sonnet`, so `sonnet` is the minimum
   mapping. Add `opus` only if you later add a command or agent that uses it.
   If you use screening, add the seven roles (`A`, `B`, `ADJ`, `QC`, `FTA`,
   `FTB`, `FTADJ`) under `screening.roles` as shown in [Models](#models).

5. **Preview the installation.** This writes nothing.

   ```powershell
   node "C:/work/academic-research-skills/opencode/install.ts" install `
     --channel plugin --scope project `
     --project "C:/research/my-project"
   ```

   Read the planned paths and any collision. The installer refuses ambiguous
   or malformed configuration instead of guessing.

6. **Apply after reviewing the preview.**

   ```powershell
   node "C:/work/academic-research-skills/opencode/install.ts" install `
     --channel plugin --scope project `
     --project "C:/research/my-project" `
     --models "C:/research/ars-models.json" --apply
   ```

7. **Verify and reload.**

   ```powershell
   node "C:/work/academic-research-skills/opencode/install.ts" check `
     --channel plugin --scope project `
     --project "C:/research/my-project"
   ```

   `check` must exit `0`. Then run `opencode reload`, or restart the host.

8. **Run a command.**

   ```powershell
   cd "C:/research/my-project"
   opencode
   ```

   In the TUI, type a command such as
   `/ars-plan help me plan a paper on ...`. For a one-shot run:

   ```powershell
   opencode run --model "your-provider/your-model" "/ars-plan help me plan a paper on ..."
   ```

9. **Skills-only alternative.** This installs the five skill directories and
   the reviewer, but no commands, plugin tools or write guard:

   ```powershell
   node "C:/work/academic-research-skills/opencode/install.ts" install `
     --channel skills --scope project `
     --project "C:/research/my-project" --apply
   ```

10. **Global alternative.** Replace `--scope project` with `--scope global`
    and keep the same `--project` only when you want to preview against that
    project. A global profile is one fixed checkout/profile, not an automatic
    per-project clone selector.

If a command is blocked with `no OpenCode mapping`, fix
`models.aliases.sonnet`. If it reports a cross-provider route, the session and
the alias are on different providers; select a session model on the mapped
provider. `install` without `--apply` is always a preview, and `check` never
writes.

## Installation channels

The installer completes the routes the original project documents. Both
channels support project and user-global scope; each keeps its own capability
boundary.

| Channel | What it installs | What it does not install |
|---|---|---|
| `plugin` | The adapter registration plus its four portable native agents. The plugin supplies the five skills, sixteen `/ars-*` commands, adapter tools and write-scope guard at runtime. | No skill copy. A second skills installation is never required. |
| `skills` | The five complete skill directories in native OpenCode discovery, the `screening-reviewer-agent` native subagent, and one managed instruction file. Project scope embeds the routing core; global scope writes a compatibility note only. | No plugin entry, commands, adapter tools, hooks or write-scope guard. `sr-screener` uses its own reviewer, not plugin dispatch. |

```powershell
# Keep the complete checkout; replace both paths with your actual directories.
npm --prefix "C:/work/academic-research-skills/opencode" ci

# Preview (default): writes nothing.
node "C:/work/academic-research-skills/opencode/install.ts" install --channel plugin --scope project --project "C:/research/my-project"

# Apply after reviewing the preview.
node "C:/work/academic-research-skills/opencode/install.ts" install --channel plugin --scope project --project "C:/research/my-project" --models "C:/research/ars-models.json" --apply

# Read-only diagnostics.
node "C:/work/academic-research-skills/opencode/install.ts" check --channel plugin --scope project --project "C:/research/my-project"
```

These are alternative routes, not four installations to stack. For a global
plugin use `--scope global` with the same checkout/models profile. For skills-only
use `--channel skills` at either scope and omit `--models`. Keep `--project`
explicit. Installing into the ARS checkout itself is refused; `--allow-checkout`
is reserved for adapter development and writes managed files into the source
tree.

`install`, `check`, `update` and `uninstall` are the supported actions.
`--channel plugin|skills` is required. `--scope project|global` defaults to the
scope that already has a configuration (project is preferred when both do);
pass it explicitly when both scopes already have unrelated configs.
`--project <dir>` selects the project (default: the current directory).
`--models <json|file>` adds explicit model mappings for the plugin channel only;
the skills channel keeps the source `inherit` model and rejects the option.
`--adopt-legacy` is accepted by `install` and `update`, not by `check` or
`uninstall`.

Exit codes: `0` success, `1` refused or failed checks, `2` usage error. `check`
returns `1` when any check reports an error (for example Node below 24 or a
missing `opencode/node_modules/@opencode/plugin`).

Installation paths:

- Project plugin config: `opencode.json` (or an existing `opencode.jsonc` /
  `.opencode/opencode.json(c)`). More than one existing project config in the
  same scope is refused as ambiguous; nothing is guessed.
- Global plugin config: `~/.config/opencode/opencode.json(c)` (respects
  `XDG_CONFIG_HOME`).
- Project skills: `<project>/.opencode/skills/<name>/`, managed instructions at
  `<project>/.opencode/ars-instructions.md`, referenced from `instructions`.
- Global skills: `~/.config/opencode/skills/<name>/`, managed instructions at
  `~/.config/opencode/ars-instructions.md`.

The install is conservative:

- Every mutation is previewed. `--apply` is required; `check` never writes.
- JSONC is edited with `jsonc-parser`: comments, spacing, Unicode and unrelated
  keys (including existing secret values) survive. A UTF-8 BOM is accepted and
  removed on rewrite. Logs never print config contents.
- A defined but malformed `plugins` or `instructions` value is refused, never
  silently replaced by an array. A source skill tree containing a symbolic link
  is refused because a copy would be incomplete.
- Backups and the ownership manifest live under
  `~/.ars/opencode-install/` (override `ARS_OPENCODE_STATE_DIR`), outside the
  project VCS. A state directory inside the project or any enclosing Git
  worktree, including a resolved junction, is refused.
- Sensitive staging also stays in the private state directory. Atomic replacement
  needs the state and destination on the same filesystem. Cross-filesystem
  replacement fails visibly, without an in-place copy fallback; choose a private
  state location on that filesystem **before the initial install**. Keep the same
  state location for later lifecycle commands.
- An installer lock and a pre-write re-read abort on concurrent edits.
- Ownership is digest-based. A second apply is a no-op; a user-modified entry is
  retained and reported, never overwritten. Uninstall removes only unchanged
  owned entries and keeps modified instruction files together with their
  `instructions` reference.
- Skill updates are directory units. A modified bundle is kept whole rather
  than mixing old templates with new prose. Retired owned assets are removed
  only when unchanged; failed removals stay recorded for retry.
- Source copies omit VCS metadata and generated dependency/bytecode caches.
  Ownership checks do **not** ignore later installed extras or junctions: these
  retain the bundle. Review/remove unwanted generated caches yourself before
  retrying an update; the installer never silently discards them.
- Identical pre-existing assets are reused without claiming ownership. A
  differing unowned asset is a collision and blocks the run.
- A legacy fixed-root agent template is recognised but adopted only with
  `--adopt-legacy`; an install request alone does not take ownership.

After applying, reload (`/reload`) and verify with `check` plus the host's own
inventory. Disk checks do not prove the host loaded a plugin, registered a
command or activated the guard.

### Manual fallback

The plugin can still be added by hand. Project config example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./academic-research-skills/opencode"]
}
```

An absolute path also works. `repoRoot` is derived from the adapter's own
location; set it only when the package is moved away from the ARS checkout.
The four native agents still need their `agents.<id>` entries. Use
`ars_opencode_status` (read-only) to request one complete agent fragment at a
time; a single bundle would exceed the host's tool-output limit. Generated agent
instructions are project-portable and embed only the checkout root. A collision
with an existing command, skill or agent is refused rather than overwritten.

The adapter also registers two other tools: `ars_run_script` (shell-free CLI
execution, host-permission checked) and `ars_screening` (sr-screener dispatch).
Both are refused for the four native ARS subagents, whose tool boundary stays
the source `tools:` list.

OpenCode commands are user-invoked by the host; the adapter preserves the
source `disable-model-invocation` flag as metadata and does not expose a
model-callable command tool.

## Models

OpenCode has no Claude `sonnet`/`opus` aliases. The adapter enforces explicit
mappings. The installer's `--models` value is written into the plugin options, so
the same mappings work after a reload:

```powershell
node "C:/work/academic-research-skills/opencode/install.ts" install --channel plugin --scope project --project "C:/research/my-project" --models "C:/research/ars-models.json" --apply
```

The models file contains only mappings, for example
`{"aliases":{"sonnet":{"providerID":"your-provider","model":"your-model"}}}`.
It may also carry `{"screening":{"roles":{"FTA":{"providerID":"your-provider","model":"your-model"}}}}`.
Screening role names are `A`, `B`, `ADJ`, `QC`, `FTA`, `FTB` and `FTADJ`; the
installer validates each reference and writes it into `options.screening.roles`.
Omitting `--models` on a later update/check preserves and uses persisted mappings;
it does not reset them. Store credentials through OpenCode, never in this file.

Model consumers differ by channel:

- **Plugin channel:** command aliases (`models.aliases.<alias>`), native agent
  overrides (`models.agents.<id>`) and screening role mappings
  (`screening.roles.<role>`). The adapter itself never invents a model.
- **Skills channel:** no plugin options exist. The reviewer keeps its source
  `inherit` model; `--models` is rejected instead of being silently dropped.
- A mapping is a provider/model reference only. It never carries credentials.

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

### Degraded modes (visible pass-through)

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

## Update, uninstall and relocation

- **Update (plugin):** pull the ARS checkout, then run
  `node "C:/work/academic-research-skills/opencode/install.ts" update --channel plugin --scope project --project "C:/research/my-project" --apply` to refresh owned agent
  entries and the plugin options. The plugin reads skills and commands at load
  time; a running host needs `/reload`. Re-run `npm ci`, `npm run typecheck` and
  `npm test` in `opencode/` when the adapter itself changed.
- **Update (skills):** pull the checkout, then run
   `node "C:/work/academic-research-skills/opencode/install.ts" update --channel skills --scope project --project "C:/research/my-project" --apply`. Each of the five skill
  directories is replaced as a unit. If you edited any file inside a bundle, the
  whole bundle is kept and listed as retained; unchanged retired resources are
  removed. A failed skill removal stays recorded and is retried by the next
  update or uninstall; a failed instruction removal is retried by the next
  uninstall.
- **Uninstall:** `node "C:/work/academic-research-skills/opencode/install.ts" uninstall --channel <plugin|skills> --scope project --project "C:/research/my-project" --apply`.
  Only unchanged owned entries are removed. Modified agents, skills and
  instruction files survive with their ownership records; a modified instruction
  file is kept together with its `instructions` reference. Uninstall never
  restores an old whole-config backup over later edits.
- **Switch channels:** preview the target channel first. Existing identical
  assets are reused without ownership. Differing unowned skill copies or agent
  entries are collisions; remove or move the old route deliberately. The
  installer does not silently delete the other channel's files.
- **Move the checkout:** uninstall unchanged owned entries **before moving**,
  then install from the new complete checkout. Plugin entries, instructions and
  ownership are bound to the old path; `update` does not migrate that identity.
  If already moved, restore the old path to uninstall, or review/back up and
  remove the old manual configuration explicitly. Never delete ownership records
  merely to force takeover. A global profile is one fixed checkout/profile, not an automatic
  per-project clone selector. The path is machine-local, not a distribution
  contract.
- **Another machine:** clone the checkout, run `npm ci` in `opencode/`, and
  install there. Do not copy a config or manifest from a different machine as
  proof that it is installed.

Manual installs keep the old rule: remove the hand-merged plugin and agent
entries yourself. The installer reports what it owns and never claims unrelated
entries.

## Development

```bash
cd opencode
npm ci
npm run typecheck
npm test

# Opt-in real-host installation test (pinned Windows/OpenCode 2.2.7/Node 24+).
# This explicit command enables the gate; missing prerequisites fail, not skip.
npm run test:host:install
```

`npm test` runs the installer matrix: both channels at both scopes, JSONC
comment/Unicode/secret preservation, preview/apply idempotence, model options,
complete skill trees, managed instructions, modified-bundle retention, retirement
of unchanged owned assets, partial uninstall and retry records, legacy adoption
only with `--adopt-legacy`, malformed-config abort, lock contention, rollback
after a failed write, and read-only checks. Environment isolation uses a
temporary HOME/USERPROFILE/XDG config/data/cache/state plus `ProgramData`.
The host gate additionally isolates APPDATA/LOCALAPPDATA, temp directories and
credentials; checks actual host data/config/cache paths; invokes native skill
and read tools; inspects assembled instructions before deliberately aborting
inference; and checks allowed/ARS-denied native writes for two locations in one
global-config server. It launches a real executable, not a launcher proxy, and
only stops its own child process. An explicit `ARS_OPENCODE_BINARY` can select
that executable. The Node 24 gate passed all four cases without skips; the
enclosing test accounts for the fifth reported pass. No external inference is
performed: request assembly is inspected and then deliberately interrupted.

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

Still unverified: real-provider alias routing (the loopback fixture is not an
external provider), full multi-agent orchestration (one native subagent probe
succeeded, but the pipeline itself did not dispatch subagents), the screening
approval UI, and interruption/recovery beyond the recorded resume. The complete
academic pipeline was run once (`/ars-full`, Stage 1–6); PDF export, Windows
durable ledger, and Claude/Pi runtime regression remain recorded limits. The
in-memory host in `tests/runtime.test.ts` proves callback behavior only; the
direct host probes do not by themselves prove a model-driven workflow.
