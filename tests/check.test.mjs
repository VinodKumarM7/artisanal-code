import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RULES, formatText, runChecks } from "../scripts/check.mjs";
import { isForwarding, isPlaceholder, restatesCode } from "../scripts/checks/code.mjs";
import { templatedReason } from "../scripts/checks/commits.mjs";
import { aiToolEntry } from "../scripts/checks/project.mjs";
import { parseSource } from "../scripts/lib/source.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "check.mjs");
const hasGit = spawnSync("git", ["--version"]).status === 0;

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "artisanal-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitIn(dir) {
  return (...args) => {
    const res = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
  };
}

/** Copies an example into a new git repo, committing it first, then one commit per message. */
function exampleRepo(t, name, messages, extra = {}) {
  const dir = tempDir(t);
  cpSync(path.join(repoRoot, "examples", name), dir, { recursive: true });
  const git = gitIn(dir);
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "feat: add inventory app");
  for (const message of messages) {
    for (const [file, text] of Object.entries(extra[message] ?? {})) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }
    git("add", ".");
    git("commit", "-q", "--allow-empty", "-m", message);
  }
  return dir;
}

const key = (f) => (f.commit ? `commit "${f.subject}" ${f.rule}` : `${f.file}${f.line ? `:${f.line}` : ""} ${f.rule}`);

const ROUTINE = ["chore: bump dependencies", "docs: explain the sync command", "refactor: split stock helpers", "test: cover the sync", "fix: handle an empty feed", "feat: add the low stock report", "chore: tidy imports"];
const sampleData = Object.fromEntries(["data", "docs", "assets"].flatMap((d) => Array.from({ length: 12 }, (_, i) => [`${d}/sample-${i}.txt`, `sample ${i}\n`])));

// Every problem planted in examples/ai-heavy-project, plus the commits this test adds.
const PLANTED = [
  ".cursorrules ai-tool-file-tracked",
  "AGENTS.md ai-tool-file-tracked",
  "README.md:3 emoji",
  "README.md:5 ai-wording",
  "README.md:8 ai-mention",
  "force-app/main/default/classes/IInventoryRepository.cls:1 single-implementation-interface",
  "force-app/main/default/classes/InventoryService.cls:11 catch-log-only",
  "force-app/main/default/classes/InventoryService.cls:12 debug-logging",
  "force-app/main/default/classes/InventoryServiceFactory.cls:1 single-product-factory",
  "inventory_sync/sync.py:15 ai-self-talk",
  "inventory_sync/sync.py:18 catch-all",
  "inventory_sync/sync.py:22 debug-logging",
  "java/src/main/java/com/example/PriceImport.java:10 empty-catch",
  "scripts/fix_counts.py scratch-file",
  "src/debug-inventory.js scratch-file",
  "src/format-price.js:1 doc-longer-than-code",
  "src/index.js:6 single-use-config",
  "src/index.js:13 debug-logging",
  "src/inventory-service.js:1 section-banner",
  "src/inventory-service.js:5 null-check-on-fresh-value",
  "src/inventory-service.js:11 comment-restates-code",
  "src/inventory-service.js:20 catch-rethrow-only",
  "src/legacy-pricing.js unreferenced-file",
  "src/legacy-pricing.js:2 placeholder-todo",
  "src/legacy-pricing.js:6 commented-out-code",
  "src/stockLevels.js:1 file-name-style-mismatch",
  "src/stockLevels.js:2 indentation-mismatch",
  "src/stockLevels.js:5 naming-style-mismatch",
  "src/stockLevels.js:13 vague-function-name",
  "src/utils.js:1 dumping-ground-file",
  "src/utils.js:4 generic-name",
  "src/utils.js:19 this-function-comment",
  "web/src/api-client.ts:13 forwarding-wrapper",
  "web/src/api-client.ts:17 not-implemented-stub",
  "web/src/main.ts:1 ai-mention",
  "web/src/main.ts:6 forwarding-wrapper",
  'commit "feat: add price formatting" ai-commit-trailer',
  'commit "fix: round prices" ai-commit-mention',
  'commit "fix: round prices" templated-commit-message',
  'commit "Updated stuff" commit-format-mismatch',
  'commit "chore: add sample data" large-mixed-commit',
];

test("every planted problem in ai-heavy-project is found, and nothing else", { skip: !hasGit }, (t) => {
  const dir = exampleRepo(t, "ai-heavy-project", [
    "feat: add price formatting\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
    "fix: round prices\n\n## Summary\n- **Rounding**: round half up\n- **Tests**: cover rounding\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    ...ROUTINE,
    "Updated stuff",
    "chore: add sample data",
  ], { "chore: add sample data": sampleData });
  const report = runChecks(dir);
  const found = report.findings.map(key).sort();
  assert.deepEqual(found, [...PLANTED].sort());

  const covered = new Set(report.findings.map((f) => f.rule));
  const notPlanted = [...RULES.keys()].filter((id) => !covered.has(id));
  assert.deepEqual(notPlanted, [], "every rule has a planted example");
  for (const f of report.findings) {
    assert.ok(f.evidence, `${key(f)} has evidence`);
    assert.ok(f.instead, `${key(f)} says what to write instead`);
  }
});

test("clean-project has no findings", { skip: !hasGit }, (t) => {
  const dir = exampleRepo(t, "clean-project", [...ROUTINE, "feat: show low stock on the page", "fix: keep zero quantities", "docs: add usage"]);
  const report = runChecks(dir);
  assert.deepEqual(report.findings.map(key), [], formatText(report));
});

test("the examples are skipped when this repository checks itself", () => {
  const report = runChecks(repoRoot, { commits: false });
  assert.ok(!report.findings.some((f) => f.file?.startsWith("examples/")));
});

test("rules.json entries are complete", () => {
  for (const r of RULES.values()) {
    assert.match(r.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(["high", "medium", "low"].includes(r.severity), r.id);
    assert.equal(typeof r.autoFixable, "boolean", r.id);
    assert.ok(r.title && r.instead, r.id);
  }
});

test("comments that repeat the code are told apart from comments that explain it", () => {
  assert.equal(restatesCode("Increment the counter", "counter++;"), true);
  assert.equal(restatesCode("Loop through the users", "for (const user of users) {"), true);
  assert.equal(restatesCode("Prices are stored in cents.", "total += item.price_cents * item.quantity"), false);
  assert.equal(restatesCode("Retry twice: the API drops the first call", "retry(call, 2);"), false);
});

test("placeholders are told apart from specific TODOs", () => {
  assert.equal(isPlaceholder("TODO: implement this"), true);
  assert.equal(isPlaceholder("TODO"), true);
  assert.equal(isPlaceholder("... existing code ..."), true);
  assert.equal(isPlaceholder("TODO(ABC-12): implement paging"), false);
  assert.equal(isPlaceholder("TODO: drop the v1 endpoint once mobile 4.2 ships"), false);
});

test("forwarding wrappers are only flagged when the arguments pass through unchanged", () => {
  const fns = parseSource([
    "function a(id) { return fetchUser(id); }",
    "function b(id) { return fetchUser(id, { cache: false }); }",
    "function c(id, name) { return save(name, id); }",
    "const d = async (url) => await get(url);",
    "function e() { return this.load(); }",
  ].join("\n"), "javascript").functions;
  assert.deepEqual(fns.map((f) => isForwarding(f, "javascript")), [true, false, false, true, false]);
});

test("AI tool files and folders are recognized", () => {
  assert.equal(aiToolEntry("CLAUDE.md"), "CLAUDE.md");
  assert.equal(aiToolEntry("packages/app/AGENTS.md"), "packages/app/AGENTS.md");
  assert.equal(aiToolEntry(".claude/settings.json"), ".claude/");
  assert.equal(aiToolEntry(".github/copilot-instructions.md"), ".github/copilot-instructions.md");
  assert.equal(aiToolEntry(".claude-plugin/plugin.json"), null);
  assert.equal(aiToolEntry("docs/claude.md"), null);
});

test("templated commit bodies are recognized", () => {
  assert.match(templatedReason("## Summary\nAdds export"), /headings/);
  assert.match(templatedReason("- **API**: add route\n- **UI**: add button"), /bold/);
  assert.equal(templatedReason("Finance needs monthly exports.\n\n- adds a route\n- adds a button"), null);
});

test("artisanal-ignore comments, --files and --rules narrow the report", (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, "index.js"), [
    'import { run } from "./job.js";',
    "run();",
    "",
  ].join("\n"));
  writeFileSync(path.join(dir, "job.js"), [
    "export function run() {",
    '  console.debug("starting");',
    '  console.debug("again"); // artisanal-ignore debug-logging',
    "  // artisanal-ignore",
    '  console.debug("and again");',
    "}",
    "",
  ].join("\n"));
  writeFileSync(path.join(dir, "old.js"), "// artisanal-ignore-file\nexport const unused = 1;\n");
  const all = runChecks(dir);
  assert.deepEqual(all.findings.map(key), ["job.js:2 debug-logging"]);
  assert.deepEqual(runChecks(dir, { files: ["index.js"] }).findings, []);
  assert.deepEqual(runChecks(dir, { rules: ["empty-catch"] }).findings, []);
});

test("the CLI writes findings.json and rejects bad options", (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, "index.js"), "export function main() {\n  return 1;\n}\n");
  const ok = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /No findings/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, ".artisanal", "findings.json"), "utf8")).summary.findings, 0);
  assert.equal(spawnSync(process.execPath, [script, dir, "--rules", "no-such-rule"]).status, 2);
  assert.equal(spawnSync(process.execPath, [script, dir, "--nope"]).status, 2);
});
