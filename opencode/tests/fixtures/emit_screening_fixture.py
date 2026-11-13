#!/usr/bin/env python3
"""Emit real sr-screener prompt fixtures through the production Python code.

The Node adapter tests consume the emitted `index.json` and prompt files. This
script never calls a model; it only runs the unchanged builder functions that
`build_workflow.py --emit-prompts` uses.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--emit", required=True)
    parser.add_argument("--relative-emit", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    work = Path(args.work).resolve()
    emit = Path(args.emit).resolve()
    root = work.parent
    if args.relative_emit:
        os.chdir(root)
    ta_out = (
        os.path.relpath(emit / "ta", root)
        if args.relative_emit
        else str(emit / "ta")
    )
    ft_out = (
        os.path.relpath(emit / "ft", root)
        if args.relative_emit
        else str(emit / "ft")
    )
    sys.path.insert(0, str(repo / "sr-screener" / "scripts"))
    import build_workflow  # noqa: E402
    import srlib  # noqa: E402

    (work / "batches").mkdir(parents=True, exist_ok=True)
    (emit / "ta").mkdir(parents=True, exist_ok=True)
    (emit / "ft").mkdir(parents=True, exist_ok=True)

    records = [
        {
            "id": "R00001",
            "title": "Study one",
            "year": "2024",
            "pub_type": "Journal article",
            "language": "English",
        },
        {
            "id": "R00002",
            "title": "Study two",
            "year": "2023",
            "pub_type": "Journal article",
            "language": "English",
        },
    ]
    srlib.save_json(
        str(work / "records.json"),
        {"unique": records, "id_width": 5, "review_id": str(uuid.uuid4())},
    )
    srlib.save_json(
        str(work / "manifest.json"),
        [{"batch": "b001", "ids": ["R00001", "R00002"]}],
    )
    srlib.save_json(str(work / "qc_batches.json"), {"q001": ["R00002"]})

    (work / "batches" / "b001.txt").write_text(
        "### R00001 | 2024 | Journal article | Lang: English\nabstract one\n"
        "### R00002 | 2023 | Journal article | Lang: English\nabstract two\n"
        "=== END OF BATCH\n",
        encoding="utf-8",
    )
    (work / "batches" / "q001.txt").write_text(
        "### R00002 | 2023 | Journal article | Lang: English\nabstract two\n"
        "=== END OF BATCH\n",
        encoding="utf-8",
    )

    protocol_path = work / "protocol.md"
    protocol_path.write_text(
        "FIXTURE PROTOCOL. " + ("Eligibility is defined only by this fixture text. " * 8),
        encoding="utf-8",
    )

    config_path = work / "screening_config.json"
    config = {
        "review_title": "adapter fixture",
        "models": {
            "A": "fixture-model",
            "B": "fixture-model",
            "ADJ": "fixture-model",
            "QC": "fixture-model",
            "FTA": "fixture-model",
            "FTB": "fixture-model",
            "FTADJ": "fixture-model",
        },
    }
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    cfg = srlib.load_config(str(config_path))
    prompts = build_workflow.load_prompts()
    batches = str(work / "batches").replace("\\", "/")

    context_ta = srlib.activate_context(str(work), "ta", str(protocol_path), cfg)
    conf_ta = {
        "stage": "ta",
        "tool": f"{srlib.TOOL} {srlib.VERSION}",
        "protocol": srlib.read_text(str(protocol_path)).strip(),
        "core": " AND ".join(cfg["core_criteria"]),
        "codes": srlib.exclusion_codes(cfg, "ta"),
        "codesText": srlib.codes_text(cfg, "ta"),
        "personas": cfg["personas"],
        "models": cfg["models"],
        "agentType": srlib.reviewer_agent_type(cfg.get("agent_type")),
        "conflictPolicy": cfg["conflict_policy"],
        "dir": batches,
        "idWidth": 5,
        "readLimit": int(cfg.get("read_limit", 900)),
        "grepAfter": int(cfg.get("grep_after", 60)),
        "context": context_ta,
        "jobs": {
            "screen": [{"b": "b001", "from": 1, "to": 2}],
            "adj": [
                {
                    "b": "b001",
                    "items": [{"id": "R00001", "A": "include/INC", "B": "exclude/E1"}],
                }
            ],
            "recheck": [{"b": "q001", "ids": ["R00002"], "full": True}],
        },
        "batchIds": {},
        "authorizedIds": ["R00001", "R00002"],
        "returnDecisions": False,
    }
    build_workflow.emit_prompts(
        SimpleNamespace(stage="ta"), conf_ta, prompts, ta_out
    )

    pdf = work / "R00001 study.pdf"
    pdf.write_bytes(b"%PDF-1.4\nfixture\n")
    srlib.save_json(
        str(work / "ft_preparation.json"),
        {"ta_snapshot": srlib.ta_snapshot(str(work)), "retrieval_hash": "fixture"},
    )
    context_ft = srlib.activate_context(str(work), "ft", str(protocol_path), cfg)
    conf_ft = {
        "stage": "ft",
        "tool": f"{srlib.TOOL} {srlib.VERSION}",
        "protocol": srlib.read_text(str(protocol_path)).strip(),
        "core": " AND ".join(cfg["core_criteria"]),
        "codes": srlib.exclusion_codes(cfg, "ft"),
        "codesText": srlib.codes_text(cfg, "ft"),
        "personas": cfg["personas"],
        "models": cfg["models"],
        "agentType": srlib.reviewer_agent_type(cfg.get("agent_type")),
        "conflictPolicy": "adjudicate",
        "dir": batches,
        "idWidth": 5,
        "readLimit": int(cfg.get("read_limit", 900)),
        "grepAfter": int(cfg.get("grep_after", 60)),
        "context": context_ft,
        "jobs": {
            "items": [{"id": "R00001", "pdf": str(pdf), "title": "Study one"}],
            "adj": [
                {
                    "id": "R00001",
                    "pdf": str(pdf),
                    "title": "Study one",
                    "A": "include/INC",
                    "B": "exclude/E1",
                }
            ],
        },
        "batchIds": {},
        "authorizedIds": None,
        "returnDecisions": False,
    }
    build_workflow.emit_prompts(
        SimpleNamespace(stage="ft"), conf_ft, prompts, ft_out
    )

    print(
        json.dumps(
            {
                "ta_context": context_ta["context_id"],
                "ft_context": context_ft["context_id"],
                "config": str(config_path),
                "protocol": str(protocol_path),
                "pdf": str(pdf),
                "ta_emit": str(emit / "ta"),
                "ft_emit": str(emit / "ft"),
            }
        )
    )
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    sys.exit(main())
