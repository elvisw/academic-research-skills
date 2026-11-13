# Model selection and mapping

> [简体中文](models.zh-CN.md)

ARS was written for Claude Code, whose command files name Claude model families
such as `sonnet` and `opus`. **You do not need to use Claude, and you do not
need to know those product names.** In this adapter they are capability hints:
map each hint to a model your OpenCode provider actually offers.

The adapter never picks a model for a command on its own: it uses exactly the
mapping you provide, and a missing mapping blocks the affected command before
dispatch. Screening is the one deliberate exception. The unchanged emitter names
`sonnet` for every role, so planning resolves that single source default to a
per-role tier (see [Screening roles](#screening-roles)). Any other source model
keeps its own name.

## What the tiers mean

| Source hint | Think of it as | Typical use | Current ARS commands |
|---|---|---|---|
| `sonnet` | **Balanced / mid-tier** | Main research, planning, writing and review commands; the default quality/cost balance | 12 of the 16 `/ars-*` commands declare it |
| `opus` | **High-end / strongest** | Hard synthesis, complex review, high-stakes planning; usually slower and more expensive | No current source command declares it; optional for custom commands or agents whose frontmatter requests `opus`, and the default `ADJ`/`FTADJ` screening tier |
| `haiku` | **Low-end / fast and cheap** | Classification, extraction, bulk checks, low-risk mechanical work | No current source command declares it; optional for custom commands or agents whose frontmatter requests `haiku`, and the default `QC` screening tier |

The four remaining commands do not declare a model and inherit the session
model. The config key stays `sonnet` because that is the source hint; it does
**not** mean “use Claude Sonnet.” Map it to a mid-tier model from your provider.

This is guidance, not enforcement. If you map a high-end model to `sonnet`, the
12 commands that declare it will use that model (the three CLI wrappers do not
route models); if you map a cheap model there, they will use that one. Choose by
your own quality, latency and cost requirements.

## Mapping file

The installer's `--models` value is written into the plugin options, so the same
mappings work after a reload:

```powershell
node "C:/work/academic-research-skills/opencode/install.ts" install --channel plugin --scope project --project "C:/research/my-project" --models "C:/research/ars-models.json" --apply
```

A minimal models file maps only the balanced tier:

```json
{
  "aliases": {
    "sonnet": { "providerID": "your-provider", "model": "your-balanced-model" }
  }
}
```

Add the other tiers to get the per-role screening layout; without them,
screening falls back to `sonnet` and warns:

```json
{
  "aliases": {
    "sonnet": { "providerID": "your-provider", "model": "your-balanced-model" },
    "opus": { "providerID": "your-provider", "model": "your-strongest-model" },
    "haiku": { "providerID": "your-provider", "model": "your-fast-model" }
  }
}
```

### Screening roles

The unchanged emitter writes `model: sonnet` for all seven roles
(`srlib.py:374-375`). Planning resolves that single source default to the tier
layout below, so a default install with only `models.aliases.sonnet` can run
screening:

| Role | Tier | Why |
|---|---|---|
| `A`, `B` | `sonnet` | Primary title-and-abstract reviewers |
| `FTA`, `FTB` | `sonnet` | Primary full-text reviewers |
| `ADJ`, `FTADJ` | `opus` | Adjudication between reviewers benefits from stronger reasoning |
| `QC` | `haiku` | Mechanical quality checks |

Resolution happens once, in planning, in this order:

1. `screening.roles.<role>` wins when you set it: a direct model reference.
2. Otherwise the role's tier alias (`models.aliases.opus` for `ADJ`, and so on).
3. If that tier alias is absent, `models.aliases.sonnet` is used and the
   approval text warns which tier is missing.
4. If neither exists, dispatch is blocked and names the role.

Only the source `sonnet` default is rewritten this way. A profile that names
another model (for example a `quality` profile with `opus`) keeps it: the role
resolves through `models.aliases.opus` and is never re-mapped to the tier
layout. An alias that exists but names a model the host does not offer blocks
the dispatch; there is no second fallback. A role whose emitted entry names no
model inherits the session model, and a `screening.roles` value for it is
ignored.

The Model Tiering table and `model_labels` in the `sr-screener` skill describe
the **source** configuration. This adapter deliberately differs — `ADJ`/`FTADJ`
use `opus` and `QC` uses `haiku` — so read the approval text returned by
`ars_screening` as the authoritative record of the model each role will use.

The seven role names are `A`, `B`, `ADJ`, `QC`, `FTA`, `FTB` and `FTADJ`.
Omitting `screening.roles` does not block installation.

### How to configure `screening.roles`

Add a top-level `screening.roles` to the same JSON file passed to `--models`. It
sits beside `aliases`, not inside it:

```json
{
  "aliases": {
    "sonnet": { "providerID": "your-provider", "model": "your-balanced-model" }
  },
  "screening": {
    "roles": {
      "A":     { "providerID": "your-provider", "model": "your-balanced-model" },
      "B":     { "providerID": "your-provider", "model": "your-balanced-model" },
      "ADJ":   { "providerID": "your-provider", "model": "your-strongest-model" },
      "QC":    { "providerID": "your-provider", "model": "your-fast-model" },
      "FTA":   { "providerID": "your-provider", "model": "your-balanced-model" },
      "FTB":   { "providerID": "your-provider", "model": "your-balanced-model" },
      "FTADJ": { "providerID": "your-provider", "model": "your-strongest-model" }
    }
  }
}
```

- Each role value is `{ "providerID": "...", "model": "..." }`, the same shape as
  an alias; it is a real model reference, not an alias key such as `sonnet`.
- Configure only the roles you want to override; any role you leave out follows
  the tier layout above. For title/abstract screening only, `A`, `B`, `ADJ` and
  `QC` matter; for full-text screening only, `FTA`, `FTB` and `FTADJ`.
- All roles may use the same model.
- The installer validates each reference and writes it to the plugin options as
  `screening.roles`; whether the model exists is verified by the host at load
  time, not by the offline installation check.

Re-run `install` or `update` with the file after changing it, for example:

```powershell
node "C:/work/academic-research-skills/opencode/install.ts" install `
  --channel plugin --scope project `
  --project "C:/research/my-project" `
  --models "C:/research/ars-models.json" --apply
```

`models.agents.<id>` and explicit `screening.roles.<role>` are **direct model
references**. Roles you leave unset are resolved through `models.aliases` as
described above, so the `haiku` and `opus` aliases do apply to the default
screening roles.

Omitting `--models` on a later update or check preserves the persisted mappings;
it does not reset them. Store credentials through OpenCode, never in this file.

## What consumes a mapping

- **Plugin channel:** command aliases (`models.aliases.<alias>`), native agent
  overrides (`models.agents.<id>`) and screening roles. A screening role uses
  `screening.roles.<role>` when you set it, otherwise `models.aliases.<tier>`.
  The adapter itself never invents a model.
- **Skills channel:** no plugin options exist. The reviewer keeps its source
  `inherit` model; `--models` is rejected instead of being silently dropped.
- A mapping is a provider/model reference only. It never carries credentials.

## Routing rules

- Every command that declares a capability hint must have
  `models.aliases.<hint>`; a missing or unavailable mapping **blocks that
  invocation** before any prompt is admitted. There is no inheritance fallback.
- Command aliases are routed per request through the host's
  `experimental.model.resolve` hook, which OpenCode documents as same-provider
  only. The alias is bound to the admitted command prompt by a route tag and
  follows that turn's primary requests, including tool continuations. An
  unrelated prompt cannot consume it; if the route cannot be correlated, the
  request is blocked visibly instead of inheriting.
- Routes are released on normal idle and on the documented failure/interruption
  execution events, so the next aliased command in the same session can run.
- If the mapped model is on another provider than the current session, the
  command blocks with an actionable message instead of silently using the
  session model.
- Native agents stay on source inheritance unless `models.agents.<id>` is set,
  and the installation check verifies the effective agent model.
- The status tool records the last routes actually applied.

## Full plugin options example

This example maps a balanced model for the 12 commands that declare `sonnet`, a
high-end model for an optional custom command that declares `opus` and for
`synthesis-agent` through `models.agents`, and role-specific screening tiers. It
is a template, not a required assignment:

```jsonc
{
  "plugins": [
    {
      "package": "./academic-research-skills/opencode",
      "options": {
        "repoRoot": "C:/work/academic-research-skills",
        "models": {
          "aliases": {
            // Balanced / mid-tier: the 12 commands that declare `sonnet`.
            "sonnet": { "providerID": "your-provider", "model": "your-balanced-model" },
            // High-end / strongest: custom `opus` commands, agents, and the `ADJ`/`FTADJ` screening tier.
            "opus": { "providerID": "your-provider", "model": "your-strongest-model" }
          },
          "agents": {
            // Optional override; without it the agent inherits the session model.
            "synthesis-agent": { "providerID": "your-provider", "model": "your-strongest-model" }
          }
        },
        "screening": {
          "roles": {
            "A": { "providerID": "your-provider", "model": "your-balanced-model" },
            "B": { "providerID": "your-provider", "model": "your-balanced-model" },
            "ADJ": { "providerID": "your-provider", "model": "your-strongest-model" },
            "QC": { "providerID": "your-provider", "model": "your-fast-model" },
            "FTA": { "providerID": "your-provider", "model": "your-balanced-model" },
            "FTB": { "providerID": "your-provider", "model": "your-balanced-model" },
            "FTADJ": { "providerID": "your-provider", "model": "your-strongest-model" }
          }
        }
      }
    }
  ]
}
```

When the emitted `screening_config.json` names `sonnet` for a role, the
dispatcher needs `models.aliases.sonnet`, plus the `opus` and `haiku` aliases if
you want the tier layout above. It switches each child session to the model the
plan stored for that role, reads the effective model back, and prompts only if
it matches. A role whose model cannot be resolved, or names a model the host
does not offer, blocks the dispatch before any reviewer call.
