# Screening dispatch

The sr-screener dispatch path, its approval gate, model checks, retry rules and output artifacts.

```bash
python sr-screener/scripts/build_workflow.py ta \
  --work W --protocol protocol.md --config screening_config.json \
  --jobs pilot --emit-prompts W/prompts
```

Then call `ars_screening` with `{ "stage": "ta", "work": "W", "emit": "W/prompts" }`
(optionally `out`). Without `"approve": true` the tool returns the call-count
preview and dispatches nothing; set it only after the user has approved that
preview. The adapter:

1. validates `label@context_id`, batch files or PDFs, and the seven role models;
   it also re-verifies the installed `screening-reviewer-agent` system, mode,
   permissions and model at the dispatch boundary, and blocks before any child
   session or cost prompt if that contract differs;
2. warns when the emitted prompts are bound to a stale context (a profile change
   archives earlier decisions);
3. asks the host to evaluate `edit` on the results file and its `.audit.json`
   sidecar before writing either;
4. calls the host permission check
   `permission.assert({ action: "ars_screening_dispatch", resources: [plan] })`
   for the initial calls **and** the bounded one-retry-per-call maximum. A
   confirmation prompt appears only when your permission rules make that action
   `ask` or stricter; if a global rule allows it automatically, the adapter does
   not add a second confirmation. Configure it explicitly, for example:

   ```jsonc
   {
     "permissions": [
       { "action": "ars_screening_dispatch", "resource": "*", "effect": "ask" }
     ]
   }
   ```
5. dispatches each prompt into its own fresh `screening-reviewer-agent` session
   (no peer outputs are visible), applies the configured role model, and reads
   the effective model back before prompting;
6. applies the source decision checks (`d`/`code` agreement, expected IDs,
   duplicates), retries once for missing IDs, and leaves anything still missing
   pending — never filled in by default. A retry failure keeps decisions already
   accepted from the first reply;
7. writes `opencode_screening_<stage>.json` as a plain array of
   `{ "label": "A:b001@<context>", "decisions": [...] }`, plus a
   `.audit.json` sidecar with pending/rejected items, actual call count, and the
   effective model route for each entry.

Merge with the unchanged script:

```bash
python sr-screener/scripts/merge_decisions.py --work W --from W/opencode_screening_ta.json --config screening_config.json --protocol protocol.md --stage ta
```

The pilot gate, protocol identity, and revision archiving remain owned by the
Python tooling.
