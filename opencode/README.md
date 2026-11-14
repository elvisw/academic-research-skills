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

**Status.** Tested on Windows 11 + OpenCode 2.2.7 + Node 24. A real `/ars-full`
run completed Stage 1–6 and all 16 public commands were invoked (15 stopped at
their first checkpoint); one native subagent dispatch probe succeeded. Full
multi-agent orchestration, PDF export, Windows durable ledger, and Claude/Pi
runtime regression remain unverified. See
[Development and verification](docs/development.md) for the evidence and limits.

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
   `py -3 -m pip install pyyaml`.

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

   Each line is `provider/model`. Pick a model on the same provider as the
   session you will use. Create `C:/research/ars-models.json`:

   ```json
   {
     "aliases": {
       "sonnet": { "providerID": "your-provider", "model": "your-balanced-model" }
     }
   }
   ```

   `sonnet` is the source hint for the **balanced / mid-tier** model; it does
   not mean you must use Claude. 12 of the 16 `/ars-*` commands declare it, and
   the other four inherit the session model. This file is an installation input
   only: the installer writes it into the plugin options in `opencode.json`
   (`plugins[].options`); the adapter does not read it at runtime. Screening
   roles, the high/low tiers and routing rules are in
   [Model selection](docs/models.md); the final plugin-options example is in
   [Installation](docs/installation.md#plugin-options-and-models).

5. **Preview the installation.** This writes nothing.

   ```powershell
   node "C:/work/academic-research-skills/opencode/install.ts" install `
     --channel plugin --scope project `
     --project "C:/research/my-project"
   ```

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

## What is reused unchanged

- 5 skills (`academic-paper`, `academic-paper-reviewer`, `academic-pipeline`, `deep-research`, `sr-screener`)
- 16 `/ars-*` commands
- 4 plugin-exposed agents (`research-architect-agent`, `synthesis-agent`, `report-compiler-agent`, `screening-reviewer-agent`)
- `scripts/ars_write_scope_guard.py` and `scripts/ars_phase_scope_manifest.json`
- `sr-screener/scripts/*.py` and `sr-screener/templates/*`

Core source and user configuration are not automatically rewritten. There is no
background job, scheduled maintenance, publish, commit, or paid run.

## Installation routes

The install above is the default **plugin + project** route. The other routes
are alternatives, not additional installations:

| Route | Use it when | Details |
|---|---|---|
| `plugin` + project | Default: one project, full features | Steps above |
| `plugin` + global | All projects share one ARS checkout | [Installation reference](docs/installation.md#installation-channels) |
| `skills` + project/global | You only want the skills, not `/ars-*` commands or the write guard | [Installation reference](docs/installation.md#installation-channels) |

`skills` installs the five skill directories and the reviewer, but no commands,
plugin tools or write scope guard. For skills-only, use the Quick install
command with `--channel skills` and omit `--models`; for a global plugin,
replace `--scope project` with `--scope global`. Detailed options, paths,
conservative installer behavior and the manual fallback are in the
[installation reference](docs/installation.md).

## Models

ARS source files use Claude model names as **capability hints**, not as a
requirement to use Claude. Think of them as tiers:

- `sonnet` — balanced / mid-tier. 12 of the 16 `/ars-*` commands declare it;
  of those, three CLI wrappers do not apply model routing.
- `opus` — high-end / strongest. No current command declares it; optional for
  custom commands or agents whose frontmatter requests `opus`, and the default
  `ADJ`/`FTADJ` screening tier.
- `haiku` — low-end / fast and cheap. No current command declares it; optional
  for custom commands or agents whose frontmatter requests `haiku`, and the
  default `QC` screening tier.

Agent overrides (`models.agents.<id>`) and `screening.roles.<role>` are direct
model references. Screening roles you leave unset resolve through the same alias
keys: the emitter's `sonnet` default maps to `sonnet` for `A`/`B`/`FTA`/`FTB`,
`opus` for `ADJ`/`FTADJ` and `haiku` for `QC`, falling back to
`models.aliases.sonnet` with a warning when a tier is missing.

Map each hint to a model your provider actually offers. The config key stays
`sonnet` because that is the source hint; it does not mean “Claude Sonnet.” The
minimal file is the one in Quick install step 4; pass it with `--models`.

Command aliases are routed per request through `experimental.model.resolve`,
which is same-provider only. If the session and the mapped model are on
different providers, the command blocks with an actionable message. Native
agents inherit the source model unless `models.agents.<id>` is set.

Screening tier defaults and the exact routing rules are in [Model selection and
mapping](docs/models.md); the final plugin-options example is in
[Installation](docs/installation.md#plugin-options-and-models).

## Use

```powershell
cd "C:/research/my-project"
opencode
```

In the TUI, type a command such as `/ars-plan help me plan a paper on ...`.
For a one-shot run:

```powershell
opencode run --model "your-provider/your-model" "/ars-plan help me plan a paper on ..."
```

Common commands:

| Command | Purpose |
|---|---|
| `/ars-plan` | Plan the paper structure through Socratic dialogue |
| `/ars-lit-review` | Run a literature review |
| `/ars-full` | Run the complete research pipeline |
| `/ars-revision` | Revise an existing paper |
| `/ars-reviewer` | Review a paper and produce reviewer comments; a `full` review also produces an author letter |

If `/` does not show `ars-*` commands, rerun `check` and reload the host.

## Update and uninstall

```powershell
# Plugin
node "C:/work/academic-research-skills/opencode/install.ts" update --channel plugin --scope project --project "C:/research/my-project" --apply
node "C:/work/academic-research-skills/opencode/install.ts" uninstall --channel plugin --scope project --project "C:/research/my-project" --apply

# Skills
node "C:/work/academic-research-skills/opencode/install.ts" update --channel skills --scope project --project "C:/research/my-project" --apply
```

Only unchanged owned entries are removed; modified files are kept. Channel
switching, relocation and retry behavior are in
[Update, uninstall and relocation](docs/lifecycle.md).

## Troubleshooting

- **`no OpenCode mapping`** — add `models.aliases.sonnet` (the balanced-tier
  mapping) to the models file.
- **Cross-provider route** — select a session model on the same provider as the
  mapping, or change the mapping.
- **`ars-mark-read` / `ars-unmark-read` fails** — install PyYAML and pass
  `--passport-path` or set `ARS_PASSPORT_PATH`.
- **Install refused** — `--project` must point at your research project, not
  the ARS checkout.
- **`skills` install has no `/ars-*` commands** — expected; use the plugin
  route for the full feature set.

## Limits

- Only **Windows 11 + OpenCode 2.2.7 + Node 24** is validated; macOS/Linux are
  untested.
- Full multi-agent orchestration, PDF export, Windows durable ledger, and
  Claude/Pi runtime regression remain unverified and are recorded as limits.
- The `skills` channel has no `/ars-*` commands, plugin tools or write guard.

## Technical documentation

- [Installation reference](docs/installation.md) — dependencies, channels, options, paths, manual fallback
- [Model selection and mapping](docs/models.md) — capability tiers, aliases, screening roles, routing rules ([简体中文](docs/models.zh-CN.md))
- [Write scope and permissions](docs/permissions.md) — native matrix, phase fence, degraded modes
- [Commands and CLI wrappers](docs/commands.md) — command rendering and argv validation
- [Screening dispatch](docs/screening.md) — sr-screener dispatch, approval and retries
- [Update, uninstall and relocation](docs/lifecycle.md) — lifecycle and ownership rules
- [Development and verification](docs/development.md) — tests, audit status and unverified areas
