# Model mapping and routing

How OpenCode model mappings work, what the plugin and skills channels consume, and how command aliases are routed. For the shortest setup, see [Quick install](../README.md#quick-install-from-zero).

OpenCode has no Claude `sonnet`/`opus` aliases. The adapter enforces explicit
mappings. The installer's `--models` value is written into the plugin options, so
the same mappings work after a reload:

```powershell
node "C:/work/academic-research-skills/opencode/install.ts" install --channel plugin --scope project --project "C:/research/my-project" --models "C:/research/ars-models.json" --apply
```

The models file contains only mappings, for example
`{"aliases":{"sonnet":{"providerID":"your-provider","model":"your-model"}}}`.
It may also carry `{"screening":{"roles":{"FTA":{"providerID":"your-provider","model":"your-model"}}}}`.
Screening role names are `A`, `B`, `ADJ`, `QC`, `FTA`, `FTB` and `FTADJ`; the
installer validates each reference and writes it into `options.screening.roles`.
Omitting `--models` on a later update/check preserves and uses persisted mappings;
it does not reset them. Store credentials through OpenCode, never in this file.

Model consumers differ by channel:

- **Plugin channel:** command aliases (`models.aliases.<alias>`), native agent
  overrides (`models.agents.<id>`) and screening role mappings
  (`screening.roles.<role>`). The adapter itself never invents a model.
- **Skills channel:** no plugin options exist. The reviewer keeps its source
  `inherit` model; `--models` is rejected instead of being silently dropped.
- A mapping is a provider/model reference only. It never carries credentials.

- every command that declares a Claude alias must have `models.aliases.<alias>`;
  a missing or unavailable mapping **blocks that invocation** before any prompt
  is admitted — there is no inheritance fallback;
- command aliases are routed per request through the host's
  `experimental.model.resolve` hook, which OpenCode documents as same-provider
  only. The alias is bound to the admitted command prompt by a route tag and
  follows that turn's primary requests, including tool continuations. An
  unrelated prompt cannot consume it; if the route cannot be correlated, the
  request is blocked visibly instead of inheriting. Routes are released on
  normal idle and on the documented failure/interruption execution events, so
  the next aliased command in the same session can run. If the mapped model is
  on another provider than the current session, the command blocks with an
  actionable message instead of silently using the session model;
- native agents stay on source inheritance unless `models.agents.<id>` is set,
  and the installation check verifies the effective agent model;
- the status tool records the last routes actually applied.

```jsonc
{
  "plugins": [
    {
      "package": "./academic-research-skills/opencode",
      "options": {
        "repoRoot": "C:/work/academic-research-skills",
        "models": {
          "aliases": {
            "sonnet": { "providerID": "your-provider", "model": "your-model" },
            "opus": { "providerID": "your-provider", "model": "your-other-model" }
          },
          "agents": {
            "synthesis-agent": { "providerID": "your-provider", "model": "your-other-model" }
          }
        },
        "screening": {
          "roles": {
            "A": { "providerID": "your-provider", "model": "your-model" },
            "B": { "providerID": "your-provider", "model": "your-model" },
            "ADJ": { "providerID": "your-provider", "model": "your-model" },
            "QC": { "providerID": "your-provider", "model": "your-model" },
            "FTA": { "providerID": "your-provider", "model": "your-model" },
            "FTB": { "providerID": "your-provider", "model": "your-model" },
            "FTADJ": { "providerID": "your-provider", "model": "your-model" }
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
