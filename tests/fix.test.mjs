import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "../scripts/check.mjs";
import { applyPlan, buildPlan, formatPlan } from "../scripts/fix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "fix.mjs");
const hasGit = spawnSync("git", ["--version"]).status === 0;

function gitIn(dir) {
  return (...args) => {
    const res = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
}

function exampleRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "artisanal-fix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(path.join(repoRoot, "examples", "ai-heavy-project"), dir, { recursive: true });
  const git = gitIn(dir);
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "feat: add inventory app");
  git("commit", "-q", "--allow-empty", "-m", "feat: add price formatting\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
  return { dir, git };
}

const read = (dir, file) => readFileSync(path.join(dir, file), "utf8");
const summary = (plan) => plan.actions.map((a) => `${a.id} ${a.kind} ${a.file}${a.lines ? `:${a.lines.join("-")}` : ""}`);

test("clean-traces plans untracking and line removals, and leaves history to a person", { skip: !hasGit }, (t) => {
  const { dir } = exampleRepo(t);
  const plan = buildPlan(dir, "traces");
  assert.deepEqual(summary(plan), [
    "T1 untrack .cursorrules",
    "T2 untrack AGENTS.md",
    "T3 delete-lines inventory_sync/sync.py:15-15",
    "T4 delete-lines README.md:8-8",
    "T5 delete-lines web/src/main.ts:1-1",
  ]);
  assert.deepEqual(plan.manual.map((m) => m.rule), ["ai-commit-trailer"]);
  assert.match(formatPlan(plan), /Nothing has changed yet/);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout, "", "planning changes nothing");
});

test("applying clean-traces works on a new branch, keeps local AI files and ignores them", { skip: !hasGit }, (t) => {
  const { dir, git } = exampleRepo(t);
  const result = applyPlan(dir, buildPlan(dir, "traces"));
  assert.match(result.branch, /^artisanal\/clean-traces-\d{8}$/);
  assert.equal(result.createdBranch, result.branch);
  assert.deepEqual(result.applied, ["T1", "T2", "T3", "T4", "T5"]);

  assert.ok(existsSync(path.join(dir, "AGENTS.md")) && existsSync(path.join(dir, ".cursorrules")), "local copies kept");
  assert.equal(git("ls-files", "AGENTS.md", ".cursorrules"), "", "no longer tracked");
  assert.match(read(dir, ".gitignore"), /^AGENTS\.md$/m);
  assert.match(read(dir, ".gitignore"), /^\.cursorrules$/m);
  assert.doesNotMatch(read(dir, "web/src/main.ts"), /Copilot/);
  assert.match(read(dir, "web/src/main.ts"), /^import \{ deleteItem/);
  assert.doesNotMatch(read(dir, "README.md"), /generated with/i);
  assert.doesNotMatch(read(dir, "README.md"), /\n\n\n/, "no doubled blank lines");
  assert.equal(git("log", "-1", "--format=%s"), "feat: add price formatting", "nothing committed");

  const after = runChecks(dir, { rules: ["ai-tool-file-tracked", "ai-mention", "ai-self-talk"] });
  assert.deepEqual(after.findings, []);
});

test("remove-leftovers lists deletions first and keeps unsafe edits for a person", { skip: !hasGit }, (t) => {
  const { dir } = exampleRepo(t);
  const plan = buildPlan(dir, "leftovers");
  assert.deepEqual(summary(plan), [
    "L1 delete-file scripts/fix_counts.py",
    "L2 delete-file src/debug-inventory.js",
    "L3 delete-file src/legacy-pricing.js",
    "L4 delete-lines inventory_sync/sync.py:22-22",
    "L5 delete-lines src/index.js:13-13",
    "L6 delete-lines src/legacy-pricing.js:6-8",
  ]);
  assert.deepEqual(plan.manual.map((m) => `${m.file}:${m.line} ${m.rule}`), [
    "force-app/main/default/classes/InventoryService.cls:12 debug-logging",
    "src/legacy-pricing.js:2 placeholder-todo",
    "web/src/api-client.ts:17 not-implemented-stub",
  ]);
  assert.match(plan.manual[0].reason, /only statement in its block/);
});

test("only approved actions are applied; deleted files and stale plans are skipped", { skip: !hasGit }, (t) => {
  const { dir, git } = exampleRepo(t);
  const plan = buildPlan(dir, "leftovers");
  writeFileSync(path.join(dir, "src", "index.js"), `${read(dir, "src/index.js")}// edited after the plan\n`);
  git("commit", "-q", "-am", "chore: edit index");

  const result = applyPlan(dir, plan, { ids: ["L2", "L3", "L5", "L6"] });
  assert.deepEqual(result.applied, ["L2", "L3"]);
  assert.deepEqual(result.skipped.map((s) => s.id).sort(), ["L5", "L6"]);
  assert.match(result.skipped.find((s) => s.id === "L5").reason, /changed since the plan/);
  assert.match(result.skipped.find((s) => s.id === "L6").reason, /deleted/);
  assert.ok(!existsSync(path.join(dir, "src/debug-inventory.js")));
  assert.ok(existsSync(path.join(dir, "scripts/fix_counts.py")), "L1 was not approved");
  assert.ok(git("status", "--porcelain").includes("D  src/debug-inventory.js"), "deletion is staged and can be restored");
});

test("apply refuses a dirty tree, unknown ids and folders without git", { skip: !hasGit }, (t) => {
  const { dir } = exampleRepo(t);
  const plan = buildPlan(dir, "leftovers");
  assert.throws(() => applyPlan(dir, plan, { ids: ["L99"] }), /Unknown action id/);
  writeFileSync(path.join(dir, "notes.txt"), "work in progress\n");
  assert.throws(() => applyPlan(dir, plan, { ids: ["L1"] }), /uncommitted changes/);

  const plain = mkdtempSync(path.join(tmpdir(), "artisanal-fix-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  writeFileSync(path.join(plain, "debug.js"), "export const x = 1;\n");
  const noGitPlan = buildPlan(plain, "leftovers");
  assert.deepEqual(noGitPlan.actions, [], "untracked files are never deleted");
  assert.match(noGitPlan.manual[0].reason, /could not be undone/);
  assert.throws(() => applyPlan(plain, noGitPlan), /Not a git repository/);
});

test("a second apply continues on the same artisanal branch", { skip: !hasGit }, (t) => {
  const { dir } = exampleRepo(t);
  const first = applyPlan(dir, buildPlan(dir, "traces"), { ids: ["T5"] });
  const second = applyPlan(dir, buildPlan(dir, "leftovers"), { ids: ["L5"] });
  assert.equal(second.branch, first.branch);
  assert.equal(second.createdBranch, null);
});

test("the CLI plans, writes the plan file and applies by id", { skip: !hasGit }, (t) => {
  const { dir, git } = exampleRepo(t);
  const plan = spawnSync(process.execPath, [script, "plan", dir, "--scope", "traces"], { encoding: "utf8" });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /T1 +untrack \.cursorrules/);
  assert.ok(existsSync(path.join(dir, ".artisanal", "plan-traces.json")));

  const apply = spawnSync(process.execPath, [script, "apply", dir, "--scope", "traces", "--ids", "T5"], { encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Applied 1 action on branch artisanal\/clean-traces-/);
  assert.match(git("status", "--porcelain"), /web\/src\/main\.ts/);

  assert.equal(spawnSync(process.execPath, [script, "apply", dir, "--scope", "traces"]).status, 2, "needs --ids or --all");
  assert.equal(spawnSync(process.execPath, [script, "plan", dir, "--scope", "nope"]).status, 2);
  assert.equal(spawnSync(process.execPath, [script, "frobnicate", dir]).status, 2);
});

const runApp = (dir) => {
  const res = spawnSync(process.execPath, ["src/index.js"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
};

test("simplify-review applies its mechanical edits without changing what the program prints", { skip: !hasGit }, (t) => {
  const { dir } = exampleRepo(t);
  const before = runApp(dir);
  const plan = buildPlan(dir, "simplify");
  assert.deepEqual(summary(plan), ["S1 delete-lines src/inventory-service.js:5-7", "S2 edit-lines src/inventory-service.js:18-22"]);
  assert.deepEqual(plan.actions[1].ranges[0].new, ["      items.delete(sku);"]);
  const rewrites = plan.manual.filter((m) => m.handling === "rewrite");
  assert.equal(rewrites.length, 14);
  assert.ok(rewrites.every((m) => m.reason), "each rewrite says what to do");
  assert.ok(rewrites.find((m) => m.rule === "generic-name").context.lines.some((l) => l.includes("const result")), "rewrites carry their code");

  const result = applyPlan(dir, plan);
  assert.match(result.branch, /^artisanal\/simplify-review-\d{8}$/);
  assert.deepEqual(result.applied, ["S1", "S2"]);
  assert.equal(runApp(dir), before);
  assert.deepEqual(runChecks(dir, { rules: ["catch-rethrow-only", "null-check-on-fresh-value"] }).findings, []);
});

test("humanize-docs deletes noise comments and strips emoji, and leaves rewrites to the skill", { skip: !hasGit }, (t) => {
  const { dir } = exampleRepo(t);
  const plan = buildPlan(dir, "docs");
  assert.deepEqual(summary(plan), [
    "D1 edit-lines README.md:3-3",
    "D2 delete-lines src/inventory-service.js:1-1",
    "D3 delete-lines src/inventory-service.js:11-11",
  ]);
  assert.deepEqual(plan.manual.map((m) => `${m.handling} ${m.rule}`).sort(), ["rewrite ai-wording", "rewrite doc-longer-than-code", "rewrite this-function-comment"]);
  applyPlan(dir, plan);
  assert.match(read(dir, "README.md"), /^## Features$/m);
  assert.doesNotMatch(read(dir, "src/inventory-service.js"), /=====|Set the item/);
  assert.match(read(dir, "src/inventory-service.js"), /^export function createInventory/, "no blank first line left behind");
});

test("unsafe simplifications become rewrites instead of edits", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "artisanal-fix-unsafe-"));
  try {
    writeFileSync(path.join(dir, "a.js"), [
      "export function load(read) {",
      "  try {",
      "    return read();",
      "  } catch (err) {",
      "    throw err;",
      "  } finally {",
      "    read.done = true;",
      "  }",
      "}",
      "export function make() {",
      "  const list = [];",
      "  if (list === null || make.strict) {",
      "    throw new Error(\"no list\");",
      "  }",
      "  return list;",
      "}",
      "",
    ].join("\n"));
    const plan = buildPlan(dir, "simplify");
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.manual.map((m) => `${m.rule} ${m.reason}`), [
      "catch-rethrow-only Edit by hand: the try has a finally block.",
      "null-check-on-fresh-value Edit by hand: the condition does more than test for null.",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start prepares the branch for hand edits", { skip: !hasGit }, (t) => {
  const { dir, git } = exampleRepo(t);
  const res = spawnSync(process.execPath, [script, "start", dir, "--scope", "docs"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(git("branch", "--show-current"), /^artisanal\/humanize-docs-\d{8}$/);
});
