# Commands and CLI wrappers

How the `/ars-*` commands, the three CLI wrappers, and their argument validation work.

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
