# Write scope and permissions

The native permission matrix, the phase fence, and the visible degraded behavior when the guard cannot run.

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

## Degraded modes (visible pass-through)

The guard is optional hardening. If no real Python is found, the guard script is
missing, a run times out, exits non-zero, prints unparseable output, or relays a
guard advisory (for example an unreadable manifest), the adapter passes the host
decision through and reports `degraded` in `ars_opencode_status` and in one
console warning. It never emits `allow` or `ask` on its own.

Only the two native Bucket A subagents are fenced (`synthesis-agent`,
`research-architect-agent`). Roles that run inline in a main session are not
fenced by the guard, matching the source scope. Reviewer independence for
screening comes from separate read-only sessions, not from the write guard.
