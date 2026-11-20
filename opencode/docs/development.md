# Development and verification

Adapter development commands, test coverage, audit status and the limits that remain unverified.

## Verification status

An isolated OpenCode 2.2.7 project verified 5 skills, 16 commands, 4 configured
agents, permission decisions, and real write/edit/patch/move/delete executors in
the pre-installer baseline. The installation gate also passed both channels at
both scopes on Node `24.21.0`, with no skipped cases: native skill/resource
loading, assembled instructions, and legitimate/ARS-refused writes in two
locations of one global-config server. Configuration presence alone is not
acceptance.

A real `/ars-full` run completed Stage 1–6 on Windows 11 with
`commandcode/deepseek/deepseek-v4.1-flash` (USD 0.2328), and all 16 public
commands were invoked (15 stopped at their first checkpoint; `/ars-full` was the
complete workflow). One native subagent dispatch probe succeeded. Full
multi-agent orchestration (the pipeline dispatching native subagents) remains
unverified, as do PDF export, Windows durable ledger, and Claude/Pi runtime
regression; those are recorded limits in the acceptance matrix.

A local protocol fixture verified model IDs across command turns and tool
continuation without calling an external model. Tests also use the installed
SDK, in-memory callbacks, and real Python guard/screening fixtures, none of which
substitutes for full multi-agent orchestration acceptance.

## Commands

```bash
cd opencode
npm ci
npm run typecheck
npm test

# Opt-in real-host installation test (pinned Windows/OpenCode 2.2.7/Node 24+).
# This explicit command enables the gate; missing prerequisites fail, not skip.
npm run test:host:install

# Opt-in real-host Markdown agent probe (OpenCode 2.3.x/Node 24+).
# Records project-Markdown > project-config > global-Markdown > global-config.
npm run test:host:agents
```

The 2.3.0 agent gate in this repository ran under Node `26.13.1`; the
binary path was supplied through `ARS_OPENCODE_BINARY`. This is separate from
the 2.2.7 installation gate, which records Node `24.21.0` above. The 2.3.0 gate
passes 3/3 (project and global Markdown agents). OpenCode 2.3.x runs plugins on
Bun on Windows; Bun resolves `py`/`python` through the `WindowsApps` App
Execution Aliases, which can start the Store installer or never close. The
adapter strips that directory from child processes and `spawnBounded` resolves
on timeout, so the guard probe cannot block plugin setup. Do not remove that
child-environment handling without re-running `test:host:agents`.

The suite runs files serially (`--test-concurrency=1`): the guard's Python
discovery has a short timeout, and the heavy installer fixtures otherwise
starve it on this Windows host.

`npm test` runs the installer matrix: both channels at both scopes, JSONC
comment/Unicode/secret preservation, preview/apply idempotence, model options,
complete skill trees, managed instructions, modified-bundle retention, retirement
of unchanged owned assets, partial uninstall and retry records, legacy adoption
only with `--adopt-legacy`, malformed-config abort, lock contention, rollback
after a failed write, and read-only checks. Markdown agents are covered by
`tests/agent-storage.test.ts` (frontmatter golden, YAML quoting, ordered
permissions, `provider/model#variant`, exact body) plus installer cases for new
installs writing no `agents.<id>`, CRLF-normalized ownership
(update/retention/removal), retained-record healing and restore, body and
whitespace edits kept as user edits, unowned CRLF reuse and unowned-file
collisions, interrupted-migration recovery after the agent or config write
(including retained/manual refusal, CRLF canonicalization and one verdict
shared by `check` and `update`), the uninstall warning for a leftover crash
file, and the dual-form refusal with rollback of written agent files.
Environment isolation uses a
temporary HOME/USERPROFILE/XDG config/data/cache/state plus `ProgramData`.
`test:host:install` is pinned to OpenCode 2.2.7 and covers installation,
skills, commands and the write guard. It does not assert Markdown agent loading:
that capability is covered by `test:host:agents` on 2.3.x, and 2.2.7 Markdown
loading remains unverified. The host gate additionally isolates
APPDATA/LOCALAPPDATA, temp directories and credentials; checks actual host
data/config/cache paths; invokes native skill
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

## Upstream sync and review

These workflows run only on `main` in `elvisw/academic-research-skills`.

1. In **Actions → Sync upstream**, run the workflow from `main` or wait for the
   daily run (05:23 UTC). The step log links to the new or existing sync PR
   (titled `Sync upstream main`) when upstream has new commits. You can also
   find it under **Pull requests** by matching `Imbad0202:main` → `elvisw:main`.
   The job never updates `main`.
2. Review the PR and select **Create a merge commit**. Do not squash or
   rebase: those methods do not preserve the parent relationship used by
   post-merge review. If there is a conflict, resolve it manually on a
   fork-owned branch; do not push to upstream, use **Update branch** on the
   canonical PR, or force sync. A separate conflict-resolution PR is outside
   the AI workflow's scope; inspect its resolution manually.
   Existing PR checks still run on a sync PR. Because an automated sync has no
   tracking issue, the closes-issue gate may need its documented
   `[skip-closes-check]` bypass with a justification; do not merge with failing
   substantive checks. GitHub may hold checks from a `GITHUB_TOKEN`-created PR
   for approval; when the PR shows **Approve workflows to run**, approve it so
   the existing checks can run. This does not add a required gate.
3. Optionally, in **Actions → Review upstream sync**, select `main` and enter
   the canonical sync PR number (digits only). This is a paid DeepSeek call;
   run only when authorized. In the run's **Summary**, check the recorded
   SHAs, coverage limits, and advisory findings. For an open PR the comparison
   is its captured merge base versus captured head; for a merged PR it is the
   merge commit's first parent versus the merge commit, including manual merge
   edits. The second parent must be the recorded PR head. Non-sync, closed
   unmerged, squash/rebase, and mismatched merge commits are not reviewed.

**One-time fork setup (requires authorization):**

- Under **Settings → Actions → General → Workflow permissions**, enable
  **Allow GitHub Actions to create and approve pull requests** without changing
  the default token permissions. Actual reverse-PR creation must be confirmed
  with the built-in fork token; the ability to compare branches is not proof
  that GitHub will allow creation from the upstream source branch. If GitHub
  refuses, report the API error; do not add credentials or a mirror branch.
- Under **Settings → Environments**, create `upstream-review`. For
  **Deployment branches and tags**, select **Selected branches and tags** and
  add just the branch `main` (not a tag). Set up this restriction **before**
  adding the `DEEPSEEK_API_KEY` environment secret. Do not create a repository
  or organization secret of the same name or reuse another repository's
  credential. No provider fallback is configured.

Review is advisory, not an approval or required check. The pinned standalone
OpenCode gets only the bounded UTF-8 diff file, never a checkout of the reviewed
revision, its configuration, or the GitHub token. Binary and submodule contents
are not reviewed. If the diff cannot be attached in full (including when it is
larger than 1 MiB), the model is not run; inspect the exact revisions
manually. Treat model output as unverified and keep the merge decision human.
If OpenCode stops before finishing its reply (for example at its output limit),
the run reports **Not reviewed** instead of publishing partial findings.

Local offline workflow fixtures: `python3 -B .github/tests/upstream_sync_fixture.py`.
