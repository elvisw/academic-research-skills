# Model selection and mapping

> [简体中文](models.zh-CN.md)

ARS was written for Claude Code, whose command files name Claude model families
such as `sonnet` and `opus`. **You do not need to use Claude, and you do not
need to know those product names.** In this adapter they are capability hints:
map each hint to a model your OpenCode provider actually offers.

The adapter never selects a tier on its own. It uses exactly the mapping you
provide, and a missing mapping blocks the affected command before dispatch.

## What the tiers mean

| Source hint | Think of it as | Typical use | Current ARS commands |
|---|---|---|---|
| `sonnet` | **Balanced / mid-tier** | Main research, planning, writing and review commands; the default quality/cost balance | 12 of the 16 `/ars-*` commands declare it |
| `opus` | **High-end / strongest** | Hard synthesis, complex review, high-stakes planning; usually slower and more expensive | No current source command declares it; optional for custom commands or agents whose frontmatter requests `opus` |
| `haiku` | **Low-end / fast and cheap** | Classification, extraction, bulk checks, low-risk mechanical work | No current source command declares it; optional for custom commands or agents whose frontmatter requests `haiku` |

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

Add the other tiers only when something uses them:

```json
{
  "aliases": {
    "sonnet": { "providerID": "your-provider", "model": "your-balanced-model" },
    "opus": { "providerID": "your-provider", "model": "your-strongest-model" },
    "haiku": { "providerID": "your-provider", "model": "your-fast-model" }
  }
}
```

Screening roles can use different tiers. A reasonable starting point is:

| Role | Suggested tier | Why |
|---|---|---|
| `A`, `B` | Balanced / mid-tier | Primary title-and-abstract reviewers |
| `FTA`, `FTB` | Balanced / mid-tier | Primary full-text reviewers |
| `ADJ`, `FTADJ` | High-end / strongest | Adjudication between reviewers benefits from stronger reasoning |
| `QC` | Low-end / cheap | Mechanical quality checks |

These are suggestions, not automatic assignments. Use the same model for every
role if that is simpler. The seven role names are `A`, `B`, `ADJ`, `QC`, `FTA`,
`FTB` and `FTADJ`; the installer validates each reference and writes it into
`options.screening.roles`.

Screening roles and `models.agents.<id>` are **direct model references**, not
`models.aliases` keys. `haiku` or `opus` aliases do not apply to them.

Omitting `--models` on a later update or check preserves the persisted mappings;
it does not reset them. Store credentials through OpenCode, never in this file.

## What consumes a mapping

- **Plugin channel:** command aliases (`models.aliases.<alias>`), native agent
  overrides (`models.agents.<id>`) and screening role mappings
  (`screening.roles.<role>`). The adapter itself never invents a model.
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
            // High-end / strongest: only needed for custom commands or agents that declare `opus`.
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

The seven screening roles must each be mapped when the emitted
`screening_config.json` names a model for them. The dispatcher switches each
child session's model, reads the effective model back, and refuses to prompt if
it does not match. Missing mappings block the dispatch.
