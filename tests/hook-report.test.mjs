import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleEvent, hookSettings, setHook } from "../hooks/check-edit.mjs";
import { score, writeReport } from "../scripts/report.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(repoRoot, "hooks", "check-edit.mjs");

function project(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), "artisanal-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) writeFileSync(path.join(dir, rel), text);
  return dir;
}
const event = (file) => ({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } });

test("the edit hook stays quiet until enabled", (t) => {
  const dir = project(t, { "job.js": 'export function run() {\n  console.debug("here");\n}\n' });
  assert.equal(hookSettings(dir).enabled, false);
  assert.equal(handleEvent(event(path.join(dir, "job.js")), { projectDir: dir }), null);
  assert.ok(!existsSync(path.join(dir, ".artisanal")), "nothing written while off");
});

test("once enabled, the hook reports new findings in the edited file once", (t) => {
  const dir = project(t, { "job.js": 'export function run() {\n  console.debug("here");\n  const tmp = 1;\n  return tmp;\n}\n' });
  setHook(dir, true);
  const report = handleEvent(event(path.join(dir, "job.js")), { projectDir: dir });
  assert.match(report, /job\.js:2 debug-logging \(medium\)/);
  assert.match(report, /Instead: /);
  assert.doesNotMatch(report, /generic-name/, "low findings are below the default level");
  assert.equal(handleEvent(event(path.join(dir, "job.js")), { projectDir: dir }), null, "not repeated");

  setHook(dir, true, "low");
  assert.match(handleEvent(event(path.join(dir, "job.js")), { projectDir: dir }), /generic-name/);
  assert.equal(handleEvent(event(path.join(tmpdir(), "elsewhere.js")), { projectDir: dir }), null, "files outside the project are ignored");
});

test("the hook command exits 2 with the report, and 0 when there is nothing to say", (t) => {
  const dir = project(t, { "a.py": 'def load():\n    print("debug")\n    return 1\n', "b.py": "def load():\n    return 1\n" });
  const run = (file, env = {}) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ ...event(path.join(dir, file)), cwd: dir }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
  });
  assert.equal(run("a.py").status, 0, "off by default");
  const on = run("a.py", { ARTISANAL_EDIT_HOOK: "1" });
  assert.equal(on.status, 2);
  assert.match(on.stderr, /a\.py:2 debug-logging/);
  assert.equal(run("b.py", { ARTISANAL_EDIT_HOOK: "1" }).status, 0);
  const bad = spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" });
  assert.equal(bad.status, 0, "a broken event never blocks the agent");

  const status = spawnSync(process.execPath, [hook, "enable", dir], { encoding: "utf8" });
  assert.match(status.stdout, /hook is on/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, ".artisanal", "settings.json"), "utf8")).editHook, true);
});

test("hooks.json wires the hook to edits through the plugin root", () => {
  const config = JSON.parse(readFileSync(path.join(repoRoot, "hooks", "hooks.json"), "utf8"));
  const entry = config.hooks.PostToolUse[0];
  assert.match(entry.matcher, /Edit/);
  assert.match(entry.matcher, /Write/);
  assert.equal(entry.hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/check-edit.mjs"');
});

test("the score follows its documented formula", () => {
  const f = (rule, severity, n = 1) => Array.from({ length: n }, () => ({ rule, severity }));
  assert.equal(score([], 500).value, 100);
  assert.deepEqual([score(f("a", "high"), 500).value, score(f("a", "medium"), 500).value, score(f("a", "low"), 500).value], [96, 98, 100]);
  assert.equal(score(f("noisy", "medium", 50), 500).value, 88, "one rule costs at most 12 points");
  assert.equal(score(f("a", "high", 3), 4000).value, 94, "a larger project gets a size allowance");
  assert.equal(score([...f("a", "high", 3), ...f("b", "high", 3), ...f("c", "high", 3), ...f("d", "high", 3), ...f("e", "high", 3), ...f("g", "high", 3), ...f("h", "high", 3), ...f("i", "high", 3), ...f("j", "high", 3)], 100).grade, "F");
});

test("the report writes Markdown and HTML with the score, findings and advice", (t) => {
  const out = mkdtempSync(path.join(tmpdir(), "artisanal-report-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const heavy = writeReport(path.join(repoRoot, "examples", "ai-heavy-project"), { out });
  assert.ok(heavy.score.value < 75, `score ${heavy.score.value}`);
  const md = readFileSync(heavy.files.markdown, "utf8");
  assert.match(md, /^# Artisanal report: ai-heavy-project/);
  assert.match(md, /Cleanliness score: \d+\/100 \([A-F]\)/);
  assert.match(md, /## Leftovers/);
  assert.match(md, /`src\/index\.js:13`/);
  assert.match(md, /What to do instead/);
  const html = readFileSync(heavy.files.html, "utf8");
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script/i, "the HTML report runs no scripts");
  assert.match(html, /&lt;|&quot;|&#39;/, "evidence is escaped");

  const cleanOut = path.join(out, "clean");
  const clean = writeReport(path.join(repoRoot, "examples", "clean-project"), { out: cleanOut });
  assert.equal(clean.score.value, 100);
  assert.deepEqual(readdirSync(cleanOut).sort(), ["findings.json", "report.html", "report.md"]);
});

test("commands have a description and point at real plugin scripts", () => {
  const dir = path.join(repoRoot, "commands");
  const names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(names, ["tidy-check.md", "tidy.md"]);
  for (const name of names) {
    const text = readFileSync(path.join(dir, name), "utf8");
    assert.match(text, /^---\r?\ndescription: .{20,}\r?\n/, name);
    for (const [, rel] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+\.mjs)/g)) assert.ok(existsSync(path.join(repoRoot, rel)), `${name}: ${rel}`);
    for (const [, skill] of text.matchAll(/`([a-z-]+)` skill/g)) assert.ok(existsSync(path.join(repoRoot, "skills", skill, "SKILL.md")), `${name}: ${skill}`);
  }
});
