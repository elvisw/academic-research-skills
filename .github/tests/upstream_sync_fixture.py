"""Offline fixtures for the two upstream workflow run blocks (no GitHub or LLM calls)."""

import contextlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import textwrap
import unittest
from unittest.mock import patch


WORKFLOWS = Path(__file__).resolve().parents[1] / "workflows"
FORK = "elvisw/academic-research-skills"
UPSTREAM = "Imbad0202/academic-research-skills"
SYNC = "sync-upstream.yml"
REVIEW = "review-upstream-sync.yml"


def workflow_code(name, index=0):
    workflow = WORKFLOWS / name
    if not workflow.is_file():
        raise AssertionError(f"Missing workflow: {name}")
    return textwrap.dedent(re.findall(
        r"^ +python3 - <<'PY'\n(.*?)^ +PY$", workflow.read_text(encoding="utf-8"),
        re.MULTILINE | re.DOTALL,
    )[index])


def ref(repo, sha):
    return {"repo": {"full_name": repo}, "ref": "main", "sha": sha}


def pull(base, head, **fields):
    return {
        "number": 17, "state": "open", "merged": None, "merge_commit_sha": None,
        "base": ref(FORK, base), "head": ref(UPSTREAM, head), **fields,
    }


def response(args, status, payload):
    body = json.dumps(payload)
    if "--include" in args:
        body = f"HTTP/2.0 {status} Status\r\nContent-Type: application/json\r\n\r\n{body}"
    return subprocess.CompletedProcess(args, int(status >= 400), body, "")


def model_events(reason="stop"):
    return "\n".join(json.dumps(event) for event in (
        {"type": "step_start"},
        {"type": "text", "part": {"text": "Finding: changed "}},
        {"type": "text", "part": {"text": "contract <tag>"}},
        {"type": "step_finish", "part": {"reason": reason}},
    ))


class WorkflowFixtures(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.summary = self.root / "summary"
        self.output = self.root / "output"
        self.env = {
            "GITHUB_STEP_SUMMARY": str(self.summary), "GITHUB_OUTPUT": str(self.output),
            "RUNNER_TEMP": str(self.root), "PR_NUMBER": "17",
        }

    def execute(self, code, run):
        stdout = io.StringIO()
        with patch.dict(os.environ, self.env), patch("subprocess.run", side_effect=run):
            with contextlib.redirect_stdout(stdout):
                try:
                    exec(compile(code, "<workflow>", "exec"), {"__name__": "__main__"})
                except SystemExit as exc:
                    if exc.code not in (0, None):
                        raise
        return stdout.getvalue()

    def sync(self, compare, lists=(), create=None):
        code = workflow_code(SYNC)
        pulls = iter(lists)
        calls = []

        def gh(args, **kwargs):
            self.assertEqual(args[:2], ["gh", "api"])
            calls.append(args)
            if any("/compare/elvisw:main...Imbad0202:main" in arg for arg in args):
                return response(args, *compare)
            if "--method" in args and "POST" in args:
                self.assertIn("head=Imbad0202:main", args)
                self.assertIn("base=main", args)
                return response(args, *create)
            self.assertTrue(any(arg.startswith(f"repos/{FORK}/pulls") for arg in args))
            return response(args, 200, next(pulls))

        return lambda: self.execute(code, gh), calls

    def test_up_to_date_never_creates_pr(self):
        run, calls = self.sync((200, {"status": "behind", "ahead_by": 0}))
        self.assertIn("No upstream", run())
        self.assertEqual(len(calls), 1)

    def test_compare_failure_is_not_no_changes(self):
        run, calls = self.sync((403, {"message": "Forbidden"}))
        with self.assertRaises(SystemExit):
            run()
        self.assertEqual(len(calls), 1)

    def test_diverged_branch_can_create_and_next_run_reuses_same_pr(self):
        compare = (200, {"status": "diverged", "ahead_by": 9})
        matching = pull("a" * 40, "b" * 40)
        run, calls = self.sync(compare, [[]], (201, matching))
        self.assertIn("Created", run())
        self.assertEqual(len(calls), 3)
        run, calls = self.sync(compare, [[matching]])
        self.assertIn("already open", run())
        self.assertEqual(len(calls), 2)

    def test_duplicate_is_accepted_only_when_canonical_pr_is_found(self):
        duplicate = (422, {"errors": [{"message": "A pull request already exists."}]})
        compare = (200, {"status": "ahead", "ahead_by": 1})
        matching = pull("a" * 40, "b" * 40)
        run, calls = self.sync(compare, [[], [matching]], duplicate)
        self.assertIn("already open", run())
        self.assertEqual(len(calls), 4)
        other = {**matching, "head": ref("other/academic-research-skills", "b" * 40)}
        run, calls = self.sync(compare, [[], [other]], duplicate)
        with self.assertRaises(SystemExit):
            run()
        self.assertEqual(len(calls), 4)

    def test_unrelated_creation_error_is_not_a_duplicate(self):
        run, calls = self.sync(
            (200, {"status": "ahead", "ahead_by": 1}), [[]],
            (403, {"message": "Resource not accessible by integration"}),
        )
        with self.assertRaises(SystemExit):
            run()
        self.assertEqual(len(calls), 3)

    def git_history(self):
        repo = self.root / "source"
        repo.mkdir()

        def git(*args):
            return subprocess.check_output(
                ["git", "-C", str(repo), *args], text=True, stderr=subprocess.DEVNULL,
            ).strip()

        def commit(filename, content):
            (repo / filename).write_bytes(content)
            git("add", "--", filename)
            git("commit", "-m", filename)
            return git("rev-parse", "HEAD")

        git("init", "-b", "main")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        git("config", "commit.gpgsign", "false")
        common = commit("common", b"common\n")
        git("branch", "upstream")
        base = commit("fork-only", b"not part of the review\n")
        git("checkout", "upstream")
        head = commit("upstream-only", b"upstream change\n")
        git("checkout", "main")
        git("merge", "--no-commit", "--no-ff", "upstream")
        merge = commit("merge-only", b"human merge edit\n")
        return repo, common, base, head, merge

    def review(self, payload, repo=None, *, timeout_patch=False):
        code = workflow_code(REVIEW)
        real_run = subprocess.run
        requests = []

        def run(args, **kwargs):
            if args[0] == "gh":
                requests.append(args)
                self.assertIn(f"repos/{FORK}/pulls/17", args)
                return response(args, 200, payload)
            if timeout_patch and "diff" in args and "--patch" in args:
                raise subprocess.TimeoutExpired(args, kwargs.get("timeout", 0))
            if "fetch" in args:
                self.assertIsNotNone(repo, "Invalid PR attempted to fetch candidate revisions")
                args = [str(repo) if arg.startswith("https://github.com/") else arg for arg in args]
            return real_run(args, **kwargs)

        return lambda: self.execute(code, run), requests

    def diff(self):
        return next(self.root.rglob("upstream.diff.txt")).read_text(encoding="utf-8")

    def assert_not_reviewable(self):
        output = self.output.read_text() if self.output.exists() else ""
        self.assertNotIn("ready=true", output)
        self.assertIn("not reviewed", self.summary.read_text(encoding="utf-8").lower())

    def test_open_review_compares_merge_base_to_pinned_head(self):
        repo, common, base, head, merge = self.git_history()
        run, requests = self.review(pull(base, head, merge_commit_sha=merge), repo)
        self.assertNotIn("upstream change", run())
        self.assertEqual(len(requests), 1)
        self.assertIn("+upstream change", self.diff())
        self.assertNotIn("fork-only", self.diff())
        self.assertNotIn("merge-only", self.diff())
        summary = self.summary.read_text(encoding="utf-8")
        for sha in (common, base, head):
            self.assertIn(sha, summary)
        self.assertIn("ready=true", self.output.read_text())

    def test_merged_review_includes_merge_only_edit(self):
        repo, _, base, head, merge = self.git_history()
        run, _ = self.review(pull(base, head, state="closed", merged=True, merge_commit_sha=merge), repo)
        run()
        self.assertIn("+human merge edit", self.diff())
        self.assertNotIn("fork-only", self.diff())
        summary = self.summary.read_text(encoding="utf-8")
        for sha in (base, head, merge):
            self.assertIn(sha, summary)

    def test_invalid_number_never_queries_github(self):
        self.env["PR_NUMBER"] = "17/merge"
        run, requests = self.review({})
        run()
        self.assertFalse(requests)
        self.assert_not_reviewable()

    def test_noncanonical_or_closed_unmerged_never_fetches_git(self):
        for payload in (
            {**pull("a" * 40, "b" * 40), "head": ref(FORK, "b" * 40)},
            pull("a" * 40, "b" * 40, state="closed"),
        ):
            with self.subTest(payload=payload):
                run, _ = self.review(payload)
                run()
                self.assert_not_reviewable()

    def test_merged_review_rejects_squash_or_wrong_second_parent(self):
        repo, _, base, head, merge = self.git_history()
        for recorded_head, merge_sha in ((head, base), (base, merge)):
            with self.subTest(merge_sha=merge_sha):
                run, _ = self.review(
                    pull(base, recorded_head, state="closed", merged=True, merge_commit_sha=merge_sha),
                    repo,
                )
                run()
                self.assert_not_reviewable()

    def test_oversized_diff_never_becomes_reviewable(self):
        repo, _, base, _, _ = self.git_history()
        self.git(repo, "checkout", "upstream")
        (repo / "large").write_bytes(b"many lines to review\n" * 60_000)
        self.git(repo, "add", "--", "large")
        self.git(repo, "commit", "-m", "large change")
        head = self.git(repo, "rev-parse", "HEAD")
        run, _ = self.review(pull(base, head), repo)
        self.assertNotIn("many lines", run())
        self.assert_not_reviewable()

    def test_patch_command_timeout_is_not_reviewable(self):
        repo, _, base, head, _ = self.git_history()
        run, _ = self.review(pull(base, head), repo, timeout_patch=True)
        run()
        self.assert_not_reviewable()
        self.assertIn(
            "Git could not produce the complete diff",
            self.summary.read_text(encoding="utf-8"),
        )

    def test_unreadable_head_is_not_replaced_by_upstream_tip(self):
        repo, _, base, _, _ = self.git_history()
        run, _ = self.review(pull(base, "1" * 40), repo)
        run()
        self.assert_not_reviewable()
        self.assertIn("no moving branch tip", self.summary.read_text(encoding="utf-8"))

    def test_binary_and_gitlink_contents_are_excluded_and_disclosed(self):
        repo, _, base, head, _ = self.git_history()
        self.git(repo, "checkout", "upstream")
        (repo / "binary").write_bytes(b"\0not text")
        self.git(repo, "add", "--", "binary")
        self.git(repo, "update-index", "--add", "--cacheinfo", f"160000,{head},module")
        self.git(repo, "commit", "-m", "binary and gitlink")
        run, _ = self.review(pull(base, self.git(repo, "rev-parse", "HEAD")), repo)
        run()
        self.assertIn("Subproject commit", self.diff())
        self.assertNotIn("not text", self.diff())
        notes = self.summary.read_text(encoding="utf-8")
        self.assertIn("binary file contents are not included", notes)
        self.assertIn("submodule contents are not included", notes)

    def test_gitattributes_minus_diff_is_bound_to_pinned_after(self):
        repo, _, base, _, _ = self.git_history()
        self.git(repo, "checkout", "upstream")
        (repo / ".gitattributes").write_text("secret.txt -diff\n", encoding="utf-8")
        (repo / "secret.txt").write_text("PLAINTEXT-SHOULD-NOT-LEAK\n", encoding="utf-8")
        self.git(repo, "add", "--", ".gitattributes", "secret.txt")
        self.git(repo, "commit", "-m", "hide plain text from diff")
        head = self.git(repo, "rev-parse", "HEAD")
        run, _ = self.review(pull(base, head), repo)
        run()
        diff = self.diff()
        self.assertNotIn("PLAINTEXT-SHOULD-NOT-LEAK", diff)
        self.assertIn("Binary files", diff)
        self.assertIn(
            "binary file contents are not included",
            self.summary.read_text(encoding="utf-8"),
        )

    def model(self, events, *, key="fixture-key"):
        work = self.root / "model"
        work.mkdir()
        (work / "upstream.diff.txt").write_text("SYNTHETIC DIFF ONLY", encoding="utf-8")
        self.env.update(MODEL_DIR=str(work), DEEPSEEK_API_KEY=key, GH_TOKEN="not-for-model")
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            self.assertNotIn("GH_TOKEN", kwargs["env"])
            self.assertEqual(kwargs["cwd"], work)
            if args[0] == "curl":
                self.assertNotIn("DEEPSEEK_API_KEY", kwargs["env"])
                asset = work / args[args.index("--output") + 1]
                with tarfile.open(asset, "w:gz") as archive:
                    archive.add(work / "upstream.diff.txt", arcname="opencode")
            else:
                self.assertEqual(kwargs["env"]["DEEPSEEK_API_KEY"], key)
                self.assertIn("--standalone", args)
                self.assertEqual(args[args.index("--file") + 1], "upstream.diff.txt")
                self.assertEqual(args[args.index("--format") + 1], "json")
                self.assertEqual(args[args.index("--agent") + 1], "upstream-review")
                self.assertEqual(args[args.index("--title") + 1], "Upstream sync review")
                self.assertIn("deepseek/deepseek-flash", args)
                self.assertNotIn("SYNTHETIC DIFF ONLY", " ".join(args))
            return subprocess.CompletedProcess(args, 0, events, "")

        # Simulate verified distribution; the real archive digest is checked separately.
        digest = "563b5d663637226b6e3bb4bb6803281bc39b0d2cd88db06d674b6420aab009b0"
        with patch("hashlib.file_digest") as hash_file:
            hash_file.return_value.hexdigest.return_value = digest
            self.assertEqual(self.execute(workflow_code(REVIEW, 1), run), "")
        config_path = work / "opencode.json"
        if key.strip():
            config = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(config["default_agent"], "upstream-review")
            self.assertEqual(config["plugins"], ["-opencode.tool.skill"])
            self.assertEqual(
                config["agents"]["upstream-review"]["permissions"],
                [{"action": "*", "resource": "*", "effect": "deny"}],
            )
            self.assertIn({"action": "tool.use", "resource": "*", "effect": "deny"}, config["policies"])
            self.assertIn(
                {"action": "provider.use", "resource": "deepseek", "effect": "allow"},
                config["policies"],
            )
        else:
            self.assertFalse(config_path.exists())
        return calls

    def test_missing_key_does_not_install_or_run_model(self):
        self.assertFalse(self.model("", key=""))
        self.assert_not_reviewable()
        self.assertIn("DEEPSEEK_API_KEY", self.summary.read_text(encoding="utf-8"))

    def test_findings_summary_contains_only_escaped_completed_response_text(self):
        self.assertEqual(len(self.model(model_events())), 2)
        notes = self.summary.read_text(encoding="utf-8")
        self.assertIn("Finding: changed contract &lt;tag&gt;", notes)
        self.assertNotIn("step_start", notes)
        self.assertNotIn("SYNTHETIC DIFF ONLY", notes)

    def test_truncated_model_output_is_not_reported_as_findings(self):
        self.assertEqual(len(self.model(model_events("length"))), 2)
        self.assert_not_reviewable()
        self.assertNotIn("Finding:", self.summary.read_text(encoding="utf-8"))

    def test_tool_use_event_is_not_reviewed(self):
        events = "\n".join(json.dumps(event) for event in (
            {"type": "step_start"},
            {"type": "tool_use", "part": {"tool": "shell"}},
            {"type": "step_finish", "part": {"reason": "stop"}},
        ))
        self.assertEqual(len(self.model(events)), 2)
        self.assert_not_reviewable()
        self.assertNotIn("Finding:", self.summary.read_text(encoding="utf-8"))

    def test_not_reviewed_marker_is_not_published_as_findings(self):
        events = "\n".join(json.dumps(event) for event in (
            {"type": "step_start"},
            {"type": "text", "part": {"text": "NOT_REVIEWED: attachment incomplete"}},
            {"type": "step_finish", "part": {"reason": "stop"}},
        ))
        self.assertEqual(len(self.model(events)), 2)
        self.assert_not_reviewable()
        self.assertNotIn("Advisory findings", self.summary.read_text(encoding="utf-8"))

    def test_u2028_inside_text_is_preserved(self):
        text = "Finding: first\u2028second"
        events = "\n".join(json.dumps(event, ensure_ascii=False) for event in (
            {"type": "step_start"},
            {"type": "text", "part": {"text": text}},
            {"type": "step_finish", "part": {"reason": "stop"}},
        ))
        self.assertEqual(len(self.model(events)), 2)
        notes = self.summary.read_text(encoding="utf-8")
        self.assertIn(text, notes)
        self.assertNotIn("unreadable", notes.lower())

    @staticmethod
    def git(repo, *args):
        return subprocess.check_output(
            ["git", "-C", str(repo), *args], text=True, stderr=subprocess.DEVNULL,
        ).strip()


if __name__ == "__main__":
    unittest.main()
