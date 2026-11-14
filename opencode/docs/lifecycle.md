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
  whole run before any write. `check` reports the legacy state first. When a
  migration is blocked, restore the original inline value or remove the inline
  entry and its ownership record manually; uninstall retains modified entries,
  so it does not reset the record.
- **Uninstall:** `node "C:/work/academic-research-skills/opencode/install.ts" uninstall --channel <plugin|skills> --scope project --project "C:/research/my-project" --apply`.
  Only unchanged owned entries are removed. Modified agent files, skills and
  instruction files survive with their ownership records; a modified instruction
  file is kept together with its `instructions` reference. Uninstall never
  restores an old whole-config backup over later edits.
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
