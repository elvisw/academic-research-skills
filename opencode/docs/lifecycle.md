# Update, uninstall and relocation

How to update, uninstall, switch channels and move an installation without losing ownership records.

- **Update (plugin):** pull the ARS checkout, then run
  `node "C:/work/academic-research-skills/opencode/install.ts" update --channel plugin --scope project --project "C:/research/my-project" --apply` to refresh owned agent
  files and the plugin options. The plugin reads skills and commands at load
  time; a running host needs `/reload`. Re-run `npm ci`, `npm run typecheck` and
  `npm test` in `opencode/` when the adapter itself changed.
- **Update (skills):** pull the checkout, then run
   `node "C:/work/academic-research-skills/opencode/install.ts" update --channel skills --scope project --project "C:/research/my-project" --apply`. Each of the five skill
  directories is replaced as a unit. If you edited any file inside a bundle, the
  whole bundle is kept and listed as retained; unchanged retired resources are
  removed. A failed skill removal stays recorded and is retried by the next
  update or uninstall; a failed instruction removal is retried by the next
  uninstall.
- **Migrate a pre-Markdown inline install:** `update` writes one Markdown file
  per unchanged owned `agents.<id>`, then removes the inline values. It is
  all-or-nothing: a modified, retained or unowned differing entry blocks the
  whole run before any write. `check` reports the legacy state first.
- **Recover an interrupted migration:** a run that stops after the Markdown
  file write but before the configuration and manifest writes is reconciled by
  the next commands, without a journal. `check` warns when a pathless,
  non-retained ownership record has a file whose CRLF-folded bytes equal the
  current source and the inline entry is absent, unchanged or already the
  desired value. `update` then removes any inline entry, records the file path
  and canonical digest, and rewrites the file only to canonicalize line endings;
  a canonical file is not rewritten and a second update is a no-op. A retained
  record, a file that differs from the source, or an inline entry modified after
  the crash is never recovered: `check` reports an error and `update` blocks
  with the same manual action. A file or inline edit can be repaired by
  restoring the original bytes/value; a retained record cannot be cleared by
  restoring the inline value, so remove the inline entry and its ownership
  record manually. If the file differs because the ARS source changed after the
  crash, the default `update` stays blocked; `update --channel plugin --scope
  <project|global> --project <dir> --discard-crashed-agent <id> --apply`
  explicitly replaces that pathless, non-retained file from the current source
  and completes the migration. The flag is repeatable for distinct agent IDs,
  refuses a modified inline value, a pathful record, a retained record, a
  symlinked target or an unknown ID, and never runs with install, check or
  uninstall. Uninstall retains modified entries, so it is not a reset.
- **Uninstall:** `node "C:/work/academic-research-skills/opencode/install.ts" uninstall --channel <plugin|skills> --scope project --project "C:/research/my-project" --apply`.
  Only unchanged owned entries are removed. Modified agent files, skills and
  instruction files survive with their ownership records; a modified instruction
  file is kept together with its `instructions` reference. A pathful retained
  owner whose Markdown file is already missing keeps its ownership record and
  gets a retain warning; the next `update` restores the file from source and
  clears the retained flag, and can recreate the channel registration, so the
  record is not a permanent user asset. Uninstall never restores an old
  whole-config backup over later edits.
- **Switch channels:** a second channel in the same scope is refused while the
  other channel's manifest owns the shared `screening-reviewer-agent`, because
  both would write the same Markdown path. Uninstall the first channel, then
  install the target channel. Existing identical assets are reused without
  ownership; differing unowned skill copies or agent entries are collisions.
  The installer does not silently delete the other channel's files.
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
files yourself. The installer reports what it owns and never claims unrelated
entries.
