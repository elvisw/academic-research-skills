# Installation reference

Detailed prerequisites, channels, installer options, paths, conservative behavior and the manual fallback. For the shortest working path, see [Quick install](../README.md#quick-install-from-zero).

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

## Installation channels

The installer completes the routes the original project documents. Both
channels support project and user-global scope; each keeps its own capability
boundary. For the canonical command sequence, see
[Quick install](../README.md#quick-install-from-zero); change `--channel` and
`--scope` according to the table below.

| Channel | What it installs | What it does not install |
|---|---|---|
| `plugin` | The adapter registration plus its four portable native agents. The plugin supplies the five skills, sixteen `/ars-*` commands, adapter tools and write-scope guard at runtime. | No skill copy. A second skills installation is never required. |
| `skills` | The five complete skill directories in native OpenCode discovery, the `screening-reviewer-agent` native subagent, and one managed instruction file. Project scope embeds the routing core; global scope writes a compatibility note only. | No plugin entry, commands, adapter tools, hooks or write-scope guard. `sr-screener` uses its own reviewer, not plugin dispatch. |

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
