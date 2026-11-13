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
