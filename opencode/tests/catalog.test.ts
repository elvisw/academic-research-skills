import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  defaultPackageRoot,
  SCRIPT_ARG_ALLOWLIST,
  SCRIPT_COMMANDS,
  SKILL_NAMES,
  hasPassportArgument,
  insertOptionBeforeSeparator,
  loadCatalog,
  normalizeScriptArgv,
  parseFrontmatter,
  readLogPathForPassport,
  remapMentions,
  renderCommandText,
  requirePassportPath,
  tokenizeArgs,
  validateScriptArgv,
  validateScriptInvocation,
} from "../src/catalog.ts";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("package root resolves to the ARS checkout", () => {
  assert.equal(defaultPackageRoot(), repoRoot);
  assert.ok(existsSync(resolve(repoRoot, ".claude-plugin", "plugin.json")));
});

test("catalog exposes exactly five skills and sixteen commands", () => {
  const catalog = loadCatalog(repoRoot);
  assert.equal(catalog.skills.length, 5);
  assert.deepEqual(
    catalog.skills.map((skill) => skill.name).sort(),
    [...SKILL_NAMES].sort(),
  );
  assert.equal(catalog.commands.length, 16);
  for (const skill of catalog.skills) {
    assert.ok(existsSync(skill.path), `skill path ${skill.path}`);
    assert.ok(skill.content.length > 0);
  }
  assert.equal(
    catalog.commands.filter((command) => command.script).length,
    3,
  );
  assert.deepEqual(
    catalog.commands
      .filter((command) => command.script)
      .map((command) => command.name)
      .sort(),
    Object.keys(SCRIPT_COMMANDS).sort(),
  );
});

test("user-only command metadata is preserved", () => {
  const catalog = loadCatalog(repoRoot);
  const full = catalog.commands.find((command) => command.name === "ars-full");
  const mark = catalog.commands.find(
    (command) => command.name === "ars-mark-read",
  );
  assert.equal(full?.userOnly, true);
  assert.equal(mark?.userOnly, false);
  assert.equal(mark?.model, "sonnet");
});

test("frontmatter parser handles quoted values and strips the block", () => {
  const parsed = parseFrontmatter(
    '---\nname: "ars-x"\ndescription: hi\ndisable-model-invocation: true\n---\n\nBody here\n',
  );
  assert.equal(parsed.frontmatter.name, "ars-x");
  assert.equal(parsed.frontmatter["disable-model-invocation"], "true");
  assert.equal(parsed.body, "Body here");
});

test("command rendering substitutes $ARGUMENTS and states both roots", () => {
  const catalog = loadCatalog(repoRoot);
  const command = catalog.commands.find(
    (candidate) => candidate.name === "ars-mark-read",
  );
  assert.ok(command);
  const rendered = renderCommandText({
    command,
    args: 'smith2024 --scope full_text --note "read it"',
    packageRoot: repoRoot,
    projectRoot: "C:/work/paper",
  });
  assert.ok(rendered.text.includes("smith2024 --scope full_text"));
  assert.ok(!rendered.text.includes("$ARGUMENTS"));
  assert.ok(rendered.text.includes("Academic Research Skills compatibility"));
  assert.ok(rendered.text.includes("C:/work/paper"));
  assert.ok(rendered.argsOffset >= 0);
});

test("command rendering appends arguments when no placeholder exists", () => {
  const catalog = loadCatalog(repoRoot);
  const command = catalog.commands.find(
    (candidate) => candidate.name === "ars-full",
  );
  assert.ok(command);
  const rendered = renderCommandText({
    command,
    args: "write a review on X",
    packageRoot: repoRoot,
    projectRoot: repoRoot,
  });
  assert.ok(rendered.text.includes("User request / arguments:\nwrite a review on X"));
  assert.ok(!rendered.text.includes("${CLAUDE_PLUGIN_ROOT}"));
});

test("attachment mentions shift with the arguments and drop when stale", () => {
  const original = "see @paper.pdf now";
  const rendered = `PREFIX\n${original}`;
  const offset = "PREFIX\n".length;
  const [kept, stale] = remapMentions(
    [
      { mention: { start: 4, end: 14, text: "@paper.pdf" } },
      { mention: { start: 4, end: 14, text: "@other.pdf" } },
    ],
    original,
    rendered,
    offset,
  ) ?? [];
  assert.deepEqual(kept?.mention, {
    start: offset + 4,
    end: offset + 14,
    text: "@paper.pdf",
  });
  assert.equal(stale?.mention, undefined);
});

test("mentions after a stripped command echo keep the right offset", () => {
  const echo = "/ars-full ";
  const args = "see @paper.pdf now";
  const original = `${echo}${args}`;
  const rendered = `PREFIX\n${args}`;
  const offset = "PREFIX\n".length;
  const [kept] = remapMentions(
    [{ mention: { start: echo.length + 4, end: echo.length + 14, text: "@paper.pdf" } }],
    original,
    rendered,
    offset,
    echo.length,
  ) ?? [];
  assert.deepEqual(kept?.mention, {
    start: offset + 4,
    end: offset + 14,
    text: "@paper.pdf",
  });
});

test("argv tokenizer is deterministic and never expands", () => {
  assert.deepEqual(tokenizeArgs("a b"), ["a", "b"]);
  assert.deepEqual(tokenizeArgs('a "b c" d'), ["a", "b c", "d"]);
  assert.deepEqual(tokenizeArgs("a 'b \"c\"'"), ["a", 'b "c"']);
  assert.deepEqual(tokenizeArgs("a\\ b"), ["a b"]);
  assert.deepEqual(tokenizeArgs("C:\\Users\\me\\passport.yaml"), [
    "C:\\Users\\me\\passport.yaml",
  ]);
  assert.deepEqual(tokenizeArgs('"C:\\Users\\me\\a b.yaml"'), [
    "C:\\Users\\me\\a b.yaml",
  ]);
  assert.deepEqual(tokenizeArgs("$HOME `x` *.md"), ["$HOME", "`x`", "*.md"]);
  assert.throws(() => tokenizeArgs('a "b'), /unterminated quote/);
  assert.throws(() => tokenizeArgs("a\\"), /trailing backslash/);
});

test("script argv allowlist accepts only documented flags", () => {
  assert.deepEqual(
    validateScriptArgv("ars_mark_read", [
      "smith2024",
      "--scope",
      "full_text",
      "--passport-path=C:/p/p.yaml",
    ]),
    ["smith2024", "--scope", "full_text", "--passport-path=C:/p/p.yaml"],
  );
  assert.deepEqual(
    validateScriptArgv("ars_cache_invalidate", ["10.1000/x"]),
    ["10.1000/x"],
  );
  assert.deepEqual(
    Object.keys(SCRIPT_ARG_ALLOWLIST).sort(),
    ["ars_cache_invalidate", "ars_mark_read", "ars_unmark_read"],
  );
  assert.throws(() => validateScriptArgv("ars_mark_read", ["k", "--evil"]));
  assert.deepEqual(validateScriptArgv("ars_mark_read", ["--"]), ["--"]);
  assert.deepEqual(validateScriptArgv("ars_cache_invalidate", ["-1"]), ["-1"]);
  assert.deepEqual(
    validateScriptArgv("ars_cache_invalidate", ["--", "-1"]),
    ["--", "-1"],
  );
  assert.throws(() =>
    validateScriptArgv("ars_cache_invalidate", ["x".repeat(5000)]),
  );
  assert.throws(() => validateScriptArgv("nope", []));
});

test("passport argument detection accepts both forms", () => {
  assert.equal(hasPassportArgument(["--passport-path", "x"]), true);
  assert.equal(hasPassportArgument(["--passport-path=x"]), true);
  assert.equal(hasPassportArgument(["x"]), false);
});

test("the unmark mode flag cannot be mislabelled", () => {
  assert.deepEqual(normalizeScriptArgv("ars_unmark_read", ["smith2024"]), [
    "smith2024",
    "--unmark",
  ]);
  assert.deepEqual(
    normalizeScriptArgv("ars_unmark_read", ["smith2024", "--unmark"]),
    ["smith2024", "--unmark"],
  );
  assert.deepEqual(normalizeScriptArgv("ars_mark_read", ["smith2024"]), [
    "smith2024",
  ]);
  assert.throws(
    () => normalizeScriptArgv("ars_mark_read", ["smith2024", "--unmark"]),
    /not accepted/,
  );
});

test("invocation validation pairs options and counts positionals", () => {
  const mark = validateScriptInvocation("ars_mark_read", [
    "smith2024",
    "jones2023",
    "--scope",
    "full_text",
    "--passport-path",
    "C:\\work\\passport.yaml",
  ]);
  assert.deepEqual(mark.positionals, ["smith2024", "jones2023"]);
  assert.equal(mark.passportPath, "C:\\work\\passport.yaml");
  assert.equal(mark.options["--scope"]?.[0], "full_text");

  const cache = validateScriptInvocation("ars_cache_invalidate", ["10.1/x"]);
  assert.deepEqual(cache.positionals, ["10.1/x"]);
  assert.throws(
    () => validateScriptInvocation("ars_cache_invalidate", []),
    /exactly one/,
  );
  assert.throws(
    () => validateScriptInvocation("ars_cache_invalidate", ["a", "b"]),
    /exactly one/,
  );
  assert.throws(
    () => validateScriptInvocation("ars_mark_read", []),
    /at least one/,
  );
  assert.throws(
    () => validateScriptInvocation("ars_mark_read", ["k"]),
    /--scope is required/,
  );
  assert.throws(
    () => validateScriptInvocation("ars_mark_read", ["k", "--scope"]),
    /needs a value/,
  );
  assert.throws(
    () => validateScriptInvocation("ars_mark_read", ["k", "--passport-path="]),
    /non-empty/,
  );
  assert.throws(
    () =>
      validateScriptInvocation("ars_mark_read", [
        "k",
        "--scope",
        "everything",
      ]),
    /--scope must be one of/,
  );
  assert.throws(
    () =>
      validateScriptInvocation("ars_mark_read", [
        "k",
        "--scope",
        "full_text",
        "--locator",
        "p1",
      ]),
    /--locator requires --scope sections/,
  );
  assert.throws(
    () =>
      validateScriptInvocation("ars_mark_read", [
        "k",
        "--scope",
        "sections",
        "--locator",
        "p".repeat(201),
      ]),
    /--locator values must be 1-200/,
  );
  assert.throws(
    () =>
      validateScriptInvocation("ars_mark_read", [
        "k",
        "--scope",
        "unknown",
        "--note",
        "n".repeat(1001),
      ]),
    /--note must be 1-1000/,
  );
  assert.throws(
    () =>
      validateScriptInvocation("ars_mark_read", [
        "k",
        "--note",
        "read it",
      ]),
    /--scope is required/,
  );
  assert.throws(
    () =>
      validateScriptInvocation("ars_unmark_read", [
        "k",
        "--unmark",
        "--scope",
        "unknown",
      ]),
    /cannot be combined/,
  );
  assert.throws(
    () =>
      validateScriptInvocation("ars_mark_read", [
        "k",
        "--scope",
        "unknown",
        "--scope",
        "full_text",
      ]),
    /only once/,
  );
  assert.deepEqual(
    validateScriptInvocation("ars_mark_read", [
      "k",
      "--scope=sections",
      "--locator",
      "p1",
      "--note=read",
    ]).options["--locator"],
    ["p1"],
  );
});

test("argparse end-of-options and negative keys are preserved", () => {
  for (const argv of [["-1"], ["--", "-1"]]) {
    const cache = validateScriptInvocation("ars_cache_invalidate", argv);
    assert.deepEqual(cache.positionals, ["-1"]);
    assert.deepEqual(cache.argv, argv);
  }

  const mark = validateScriptInvocation("ars_mark_read", [
    "--scope",
    "unknown",
    "--",
    "-1",
  ]);
  assert.deepEqual(mark.positionals, ["-1"]);
  assert.deepEqual(mark.options["--scope"], ["unknown"]);

  const negativeBeforeSeparator = validateScriptInvocation("ars_mark_read", [
    "-1",
    "--scope",
    "unknown",
  ]);
  assert.deepEqual(negativeBeforeSeparator.positionals, ["-1"]);

  const unmark = validateScriptInvocation("ars_unmark_read", ["--", "-1"]);
  assert.deepEqual(unmark.positionals, ["-1"]);
  assert.deepEqual(unmark.options["--unmark"], ["true"]);
  assert.deepEqual(unmark.argv, ["--unmark", "--", "-1"]);

  assert.deepEqual(
    insertOptionBeforeSeparator(
      ["--scope", "unknown", "--", "-1"],
      "--passport-path",
      "p.yaml",
    ),
    ["--scope", "unknown", "--passport-path=p.yaml", "--", "-1"],
  );
  assert.equal(
    hasPassportArgument(["--", "--passport-path=p.yaml"]),
    false,
  );
});

test("passport requirement and read-log target are deterministic", () => {
  const missing = validateScriptInvocation("ars_mark_read", [
    "k",
    "--scope",
    "unknown",
  ]);
  assert.throws(() => requirePassportPath(missing), /no active Material Passport/);
  assert.equal(
    readLogPathForPassport("C:\\work\\passport.yaml"),
    "C:/work/passport_human_read_log.yaml",
  );
  assert.equal(
    readLogPathForPassport("/home/u/passport.yaml"),
    "/home/u/passport_human_read_log.yaml",
  );
});
