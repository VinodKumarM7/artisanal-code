import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSource, buildProfile, caseStyle, classifySubject, formatText, lexC, writeProfile } from "../skills/learn-style/scripts/profile.mjs";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills/learn-style/scripts/profile.mjs");

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "artisanal-profile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
}

/** Creates a git repo with one commit per entry of `commits` ([message, files]). */
function repo(t, commits) {
  const dir = tempDir(t);
  const git = (...args) => {
    const res = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
  };
  git("init", "-q");
  for (const [message, files] of commits) {
    write(dir, files);
    git("add", ".");
    git("commit", "-q", "--allow-empty", "-m", message);
  }
  return dir;
}

// A JavaScript team: camelCase, kebab-case files, 2 spaces, few comments, short functions,
// tests next to the code, conventional commits.
const jsRepo = (t) =>
  repo(t, [
    ["feat(users): add lookup by email", {
      "package.json": JSON.stringify({ name: "shop", scripts: { test: "vitest" }, devDependencies: { vitest: "^2.0.0" } }),
      "src/user-service.js": [
        'import { fetchJson } from "./http-client.js";',
        "",
        "export async function findUserByEmail(email) {",
        "  const normalizedEmail = email.trim().toLowerCase();",
        "  return fetchJson(`/users?email=${normalizedEmail}`);",
        "}",
        "",
        "export const isActiveUser = (user) => user.status === \"active\";",
        "",
      ].join("\n"),
      "src/user-service.test.js": 'import { test } from "vitest";\ntest("finds users", () => {});\n',
    }],
    ["fix: handle empty email", {
      "src/http-client.js": [
        "const DEFAULT_TIMEOUT = 5000;",
        "",
        "export async function fetchJson(url) {",
        "  try {",
        "    const response = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT) });",
        "    return await response.json();",
        "  } catch (err) {",
        "    return { error: err.message };",
        "  }",
        "}",
        "",
        "export function buildQuery(params) {",
        "  return new URLSearchParams(params).toString();",
        "}",
        "",
      ].join("\n"),
      "src/http-client.test.js": 'import { test } from "vitest";\ntest("builds queries", () => {});\n',
    }],
    ["refactor(http): split client", { "src/format-date.js": "export const formatDate = (date) => date.toISOString().slice(0, 10);\n" }],
    ["chore: bump vitest", {}],
  ]);

// A Python team: snake_case, 4 spaces, docstrings and comments, longer functions, logging in
// except blocks, a separate tests folder with pytest, capitalized commits with a period.
const pyRepo = (t) =>
  repo(t, [
    ["Add the order store.", {
      "app/order_store.py": [
        "import logging",
        "",
        "logger = logging.getLogger(__name__)",
        "MAX_ITEMS = 100",
        "",
        "",
        "class OrderStore:",
        '    """Keeps orders in memory.',
        "",
        "    Orders are keyed by their id.",
        '    """',
        "",
        "    def __init__(self):",
        "        # Orders by id.",
        "        self.orders = {}",
        "",
        "    def add_order(self, order_id, items):",
        '        """Adds an order and returns its total."""',
        "        # Reject oversized orders early.",
        "        if len(items) > MAX_ITEMS:",
        '            raise ValueError("too many items")',
        "        order_total = 0",
        "        for item in items:",
        "            # Prices are stored in cents.",
        "            order_total += item.price_cents * item.quantity",
        "        self.orders[order_id] = items",
        "        return order_total",
        "",
        "    def load_orders(self, path):",
        '        """Loads orders from a file."""',
        "        try:",
        "            with open(path) as handle:",
        "                raw_text = handle.read()",
        "        except OSError as err:",
        '            logger.error("could not read %s: %s", path, err)',
        "            return []",
        "        # One order per line.",
        "        return raw_text.splitlines()",
        "",
      ].join("\n"),
      "tests/conftest.py": "import pytest\n",
      "tests/test_order_store.py": "import pytest\n\n\ndef test_add_order():\n    assert True\n",
    }],
    ["Fix rounding in totals.", {
      "app/price_rules.py": [
        "import logging",
        "",
        "logger = logging.getLogger(__name__)",
        "",
        "",
        "def apply_discount(order_total, discount_code):",
        '    """Applies a discount code to a total in cents."""',
        "    # Unknown codes leave the total unchanged.",
        "    try:",
        "        percent_off = int(discount_code.split('-')[1])",
        "    except (IndexError, ValueError):",
        '        logger.warning("bad discount code %s", discount_code)',
        "        return order_total",
        "    # Round down so the customer never pays a fraction of a cent more.",
        "    discounted_total = order_total * (100 - percent_off) // 100",
        "    return discounted_total",
        "",
      ].join("\n"),
    }],
    ["Update the readme.", { "README.md": "# Orders\n" }],
  ]);

test("caseStyle names the common styles", () => {
  assert.equal(caseStyle("findUserByEmail"), "camelCase");
  assert.equal(caseStyle("OrderStore"), "PascalCase");
  assert.equal(caseStyle("XMLParser"), "PascalCase");
  assert.equal(caseStyle("add_order"), "snake_case");
  assert.equal(caseStyle("__init__"), "lowercase");
  assert.equal(caseStyle("MAX_ITEMS"), "SCREAMING_SNAKE");
  assert.equal(caseStyle("user-service"), "kebab-case");
  assert.equal(caseStyle("user"), "lowercase");
});

test("classifySubject separates the format from the description", () => {
  assert.deepEqual(classifySubject("feat(api): add paging"), { format: "conventional", type: "feat", scoped: true, description: "add paging" });
  assert.equal(classifySubject("ABC-123: Fix login").format, "ticket");
  assert.equal(classifySubject("ABC-123: Fix login").description, "Fix login");
  assert.equal(classifySubject("[ui] Tidy header").format, "bracket-tag");
  assert.equal(classifySubject("Note: this is plain").format, "plain");
  assert.equal(classifySubject("Add the store.").format, "plain");
});

test("lexC drops comments and masks strings and regexes", () => {
  const lines = lexC('const a = "{ // not a comment }"; // real\n/** doc */\nconst re = /[{]"/g;', { backtick: true });
  assert.equal(lines[0].comment, true);
  assert.doesNotMatch(lines[0].code, /[{}]|real/);
  assert.equal(lines[1].doc, true);
  assert.doesNotMatch(lines[2].code, /[{"]/);
});

test("function lengths and catch bodies are measured in Java and Apex", () => {
  const java = analyzeSource([
    "public class Totals {",
    "    private int count;",
    "    public Totals() {",
    "        count = 0;",
    "    }",
    "    public int add(int value) throws IllegalStateException {",
    "        try {",
    "            count += value;",
    "        } catch (Exception e) {",
    "        }",
    "        return count;",
    "    }",
    "}",
  ].join("\n"), "java");
  assert.deepEqual(java.functionLengths, [3, 7]);
  assert.equal(java.errors.empty, 1);
  assert.equal(java.names.functions.lowercase, 1);

  const apex = analyzeSource([
    "public with sharing class AccountService {",
    "    public static List<Account> findActiveAccounts(Set<Id> accountIds) {",
    "        try {",
    "            return [SELECT Id FROM Account WHERE Id IN :accountIds];",
    "        } catch (QueryException e) {",
    "            System.debug(e.getMessage());",
    "            throw e;",
    "        }",
    "    }",
    "}",
  ].join("\n"), "apex");
  assert.deepEqual(apex.functionLengths, [8]);
  assert.equal(apex.names.functions.camelCase, 1);
  assert.equal(apex.errors.handled, 1);
  assert.equal(apex.logging.systemDebug, 1);
});

test("profiles of a JavaScript repo and a Python repo differ in the expected ways", { skip: !hasGit }, (t) => {
  const js = buildProfile(jsRepo(t));
  const py = buildProfile(pyRepo(t));
  const jsLang = js.byLanguage.javascript;
  const pyLang = py.byLanguage.python;

  assert.equal(js.primaryLanguage, "javascript");
  assert.equal(py.primaryLanguage, "python");

  assert.equal(jsLang.naming.functions.dominant, "camelCase");
  assert.equal(jsLang.naming.variables.dominant, "camelCase");
  assert.equal(jsLang.naming.constants.dominant, "SCREAMING_SNAKE");
  assert.equal(jsLang.naming.files.dominant, "kebab-case");
  assert.equal(pyLang.naming.functions.dominant, "snake_case");
  assert.equal(pyLang.naming.variables.dominant, "snake_case");
  assert.equal(pyLang.naming.classes.dominant, "PascalCase");
  assert.equal(pyLang.naming.files.dominant, "snake_case");

  assert.deepEqual(jsLang.indentation, { style: "spaces", size: 2, consistency: 1 });
  assert.equal(pyLang.indentation.size, 4);

  assert.ok(pyLang.comments.density > jsLang.comments.density + 0.2, `${pyLang.comments.density} vs ${jsLang.comments.density}`);
  assert.ok(pyLang.comments.docLines >= 5);
  assert.ok(pyLang.functions.medianLines > jsLang.functions.medianLines);
  assert.equal(jsLang.functions.count, 5);

  assert.equal(jsLang.errorHandling.catchBodies.handled, 1);
  assert.equal(pyLang.errorHandling.catchBodies.handled, 2);
  assert.equal(pyLang.errorHandling.bareExcept, 0);
  assert.ok(pyLang.logging.logger >= 2);

  assert.equal(js.tests.layout, "colocated");
  assert.deepEqual(js.tests.frameworks, ["vitest"]);
  assert.deepEqual(js.tests.patterns, { "*.test.*": 2 });
  assert.equal(py.tests.layout, "separate");
  assert.deepEqual(py.tests.directories, ["tests"]);
  assert.deepEqual(py.tests.frameworks, ["pytest"]);

  assert.equal(js.commits.format.dominant, "conventional");
  assert.equal(js.commits.format.share, 1);
  assert.equal(js.commits.subject.capitalizedShare, 0);
  assert.equal(js.commits.subject.endsWithPeriodShare, 0);
  assert.equal(js.commits.scopedShare, 0.5);
  assert.equal(py.commits.format.dominant, "plain");
  assert.equal(py.commits.subject.capitalizedShare, 1);
  assert.equal(py.commits.subject.endsWithPeriodShare, 1);
  for (const p of [js, py]) {
    assert.equal(p.commits.subject.mood.dominant, "imperative");
    assert.equal(p.commits.trailers.aiCoAuthoredBy, 0);
  }
});

test("AI co-author trailers and 'Generated with' lines are counted", { skip: !hasGit }, (t) => {
  const dir = repo(t, [
    ["Add search\n\nCo-Authored-By: Claude <noreply@anthropic.com>", { "a.js": "export const a = 1;\n" }],
    ["Fix search\n\nGenerated with Claude Code", { "b.js": "export const b = 2;\n" }],
    ["Tidy search\n\nCo-authored-by: Sam <sam@example.com>", { "c.js": "export const c = 3;\n" }],
  ]);
  const { commits } = buildProfile(dir);
  assert.equal(commits.trailers.coAuthoredBy, 2);
  assert.equal(commits.trailers.aiCoAuthoredBy, 1);
  assert.equal(commits.aiGeneratedMentions, 1);
  assert.equal(commits.body.share, 0.33, "trailers are not a body; the Generated with line is");
});

test("a folder without git still gets a code profile", (t) => {
  const dir = tempDir(t);
  write(dir, {
    "lib/main.py": "def run_job():\n    return 1\n",
    "node_modules/x/index.js": "function skipped() {}\n",
    "examples/bad/app.js": "function BadName() {}\n",
  });
  const p = buildProfile(dir);
  assert.equal(p.git.isRepo, false);
  assert.deepEqual(p.languages.map((l) => l.language), ["python"]);
  assert.equal(p.files.skipped.examples, 1);
  assert.equal(p.commits.analyzed, 0);
  assert.match(formatText(p), /not a git repository/);
});

test("the profile is written to .artisanal/profile.json and the CLI rejects bad options", (t) => {
  const dir = tempDir(t);
  write(dir, { "index.js": "export function main() {\n  return 1;\n}\n" });
  const file = writeProfile(dir, buildProfile(dir));
  assert.equal(file, path.join(dir, ".artisanal", "profile.json"));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).schema, 1);

  const bad = spawnSync(process.execPath, [script, dir, "--nope"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  const dry = spawnSync(process.execPath, [script, dir, "--no-write", "--json"], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).primaryLanguage, "javascript");
  rmSync(path.join(dir, ".artisanal"), { recursive: true });
  spawnSync(process.execPath, [script, dir, "--no-write"]);
  assert.equal(existsSync(path.join(dir, ".artisanal")), false);
});
