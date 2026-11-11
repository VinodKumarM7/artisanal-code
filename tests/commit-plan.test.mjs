import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommitPlan, commitGroup, commitStyle, formatCommitPlan, groupChanges, lintMessage } from "../scripts/commit-plan.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/commit-plan.mjs");
const hasGit = spawnSync("git", ["--version"]).status === 0;

function repo(t, subjects) {
  const dir = mkdtempSync(path.join(tmpdir(), "artisanal-commits-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const res = spawnSync("git", ["-c", "user.name=Sam Dev", "-c", "user.email=sam@example.com", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Sam Dev");
  git("config", "user.email", "sam@example.com");
  for (const s of subjects) git("commit", "-q", "--allow-empty", "-m", s);
  return { dir, git };
}
const write = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
};

const CONVENTIONAL = [
  "feat(api): add paging", "fix(api): keep zero quantities", "chore: bump deps", "docs: explain the sync", "refactor(ui): split the table",
  "test(api): cover paging", "feat(ui): show low stock", "fix: handle an empty feed", "build: pin node 20", "feat(api): add search",
];
const PLAIN = ["Add the order store.", "Fix rounding in totals.", "Update the readme.", "Add CSV export.", "Remove the old importer.", "Rename the settings page."];

test("the commit style is learned from history, with defaults for a new repo", { skip: !hasGit }, (t) => {
  const conv = commitStyle(repo(t, CONVENTIONAL).dir);
  assert.equal(conv.format, "conventional");
  assert.deepEqual(conv.types.slice(0, 2), ["feat", "fix"]);
  assert.equal(conv.scopes[0], "api");
  assert.equal(conv.capitalizedShare, 0);
  assert.equal(conv.mood, "imperative");

  const plain = commitStyle(repo(t, PLAIN).dir);
  assert.equal(plain.format, "plain");
  assert.equal(plain.periodShare, 1);

  const fresh = commitStyle(repo(t, ["first"]).dir);
  assert.equal(fresh.known, false);
  assert.match(fresh.note, /common git conventions/);
});

test("lint blocks AI attribution and flags messages that do not fit the history", { skip: !hasGit }, (t) => {
  const conv = commitStyle(repo(t, CONVENTIONAL).dir);
  assert.deepEqual(lintMessage("feat(api): add export", conv), { ok: true, errors: [], warnings: [] });

  const ai = lintMessage("feat(api): add export\n\nCo-Authored-By: Claude <noreply@anthropic.com>", conv);
  assert.equal(ai.ok, false);
  assert.match(ai.errors[0], /co-author/);
  assert.equal(lintMessage("feat: add export\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)", conv).ok, false);

  const off = lintMessage("Added a robust export.", conv);
  assert.equal(off.ok, true);
  const text = off.warnings.join("\n");
  for (const hint of [/plain; this project writes conventional/, /lowercase letter/, /Drop the period/, /imperative/, /robust/]) assert.match(text, hint);
  assert.match(lintMessage("feat(api): add export\n\n## Summary\n- **API**: export\n- **UI**: button", conv).warnings.join(), /generated report/);

  const plain = commitStyle(repo(t, PLAIN).dir);
  assert.deepEqual(lintMessage("Add the order export.", plain).warnings, []);
  assert.match(lintMessage("add the order export", plain).warnings.join("\n"), /capital letter[\s\S]*period/);
});

test("changes are grouped into AI files, removals, areas with their tests, config and docs", () => {
  const style = { format: "conventional", types: ["feat", "test", "build", "docs", "chore"], scopedShare: 0.6 };
  const groups = groupChanges([
    { status: "M", path: "src/billing/invoice.js" },
    { status: "M", path: "src/billing/invoice.test.js" },
    { status: "A", path: "src/auth/login.js" },
    { status: "D", path: "scripts/debug_auth.py" },
    { status: "D", path: "CLAUDE.md" },
    { status: "M", path: ".gitignore" },
    { status: "M", path: "package.json" },
    { status: "M", path: "README.md" },
    { status: "A", path: "tests/test_reports.py" },
  ], style);
  assert.deepEqual(groups.map((g) => [g.id, g.title, g.suggestedType, g.suggestedScope, g.files.map((f) => f.path)]), [
    [1, "Stop tracking AI tool files", "chore", null, ["CLAUDE.md", ".gitignore"]],
    [2, "Remove unused files", "chore", null, ["scripts/debug_auth.py"]],
    [3, "Changes in src/auth", null, "auth", ["src/auth/login.js"]],
    [4, "Changes in src/billing", null, "billing", ["src/billing/invoice.js", "src/billing/invoice.test.js"]],
    [5, "Tests", "test", null, ["tests/test_reports.py"]],
    [6, "Build and configuration", "build", null, ["package.json"]],
    [7, "Documentation", "docs", null, ["README.md"]],
  ]);
});

test("a group is committed on its own, as the user, without AI trailers", { skip: !hasGit }, (t) => {
  const { dir, git } = repo(t, CONVENTIONAL);
  write(dir, { "src/api/paging.js": "export const pageSize = 50;\n", "README.md": "# Shop\n" });
  git("add", "-A");
  const plan = buildCommitPlan(dir);
  assert.deepEqual(plan.groups.map((g) => g.title), ["Changes in src/api", "Documentation"]);
  assert.match(formatCommitPlan(plan), /Nothing is committed yet/);

  assert.throws(() => commitGroup(dir, plan, 1, "feat(api): set the page size\n\nCo-Authored-By: Claude <noreply@anthropic.com>"), /cannot be used/);
  const done = commitGroup(dir, plan, 1, "feat(api): set the page size");
  assert.deepEqual(done.warnings, []);
  assert.equal(git("log", "-1", "--format=%an <%ae>|%s|%b"), "Sam Dev <sam@example.com>|feat(api): set the page size|");
  assert.equal(git("show", "--name-only", "--format=", "HEAD"), "src/api/paging.js");
  assert.equal(git("status", "--porcelain"), "A  README.md", "the other group is still staged and uncommitted");
  assert.throws(() => commitGroup(dir, plan, 1, "feat(api): again"), /no uncommitted changes/);
});

test("the CLI plans, lints and commits", { skip: !hasGit }, (t) => {
  const { dir, git } = repo(t, PLAIN);
  write(dir, { "orders.py": "TOTAL = 0\n" });
  const empty = spawnSync(process.execPath, [script, "plan", dir], { encoding: "utf8" });
  assert.match(empty.stdout, /Nothing is staged/);
  const plan = spawnSync(process.execPath, [script, "plan", dir, "--all"], { encoding: "utf8" });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /plain subjects \(100% of 6 commits\)/);

  const bad = spawnSync(process.execPath, [script, "lint", dir, "--message", "wip\n\nGenerated with Claude Code"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^error/m);

  const msg = path.join(mkdtempSync(path.join(tmpdir(), "artisanal-msg-")), "m.txt");
  writeFileSync(msg, "Add the orders total.\n");
  const ok = spawnSync(process.execPath, [script, "commit", dir, "--group", "1", "--file", msg], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Committed group 1 as \w+: Add the orders total\./);
  assert.equal(git("log", "-1", "--format=%s"), "Add the orders total.");
  rmSync(path.dirname(msg), { recursive: true, force: true });

  assert.equal(spawnSync(process.execPath, [script, "commit", dir, "--file", msg]).status, 2, "needs --group");
  assert.equal(spawnSync(process.execPath, [script, "push", dir]).status, 2);
});
