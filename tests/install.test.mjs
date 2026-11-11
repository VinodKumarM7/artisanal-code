import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install, retarget } from "../scripts/install.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "install.mjs");
const skills = readdirSync(path.join(repoRoot, "skills")).sort();

function temp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "artisanal-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Every `node "<path>"` in the text names a file that exists. */
function assertScriptsExist(text, label) {
  const paths = [...text.matchAll(/node "([^"]+\.mjs)"/g)].map((m) => m[1]);
  for (const p of paths) assert.ok(existsSync(p), `${label}: ${p}`);
  assert.doesNotMatch(text, /\.\.\/\.\.\/scripts|\$\{CLAUDE_PLUGIN_ROOT\}/, `${label} has no plugin-relative paths left`);
  return paths.length;
}

test("retarget points script and reference paths at the install home", () => {
  const text = "Run:\n\n   node ../../scripts/fix.mjs plan <dir>\n\nSee `../../references/patterns-by-language.md`. The script lives in the plugin's `scripts` folder, two levels up from this skill; use its absolute path.";
  const out = retarget(text, "/opt/artisanal");
  assert.match(out, /node "\/opt\/artisanal\/scripts\/fix\.mjs" plan/);
  assert.match(out, /`\/opt\/artisanal\/references\/patterns-by-language\.md`/);
  assert.match(out, /The script is installed in `\/opt\/artisanal\/scripts`\./);
  assert.match(retarget('node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" <dir>', "/h"), /^node "\/h\/scripts\/report\.mjs" <dir>$/);
});

test("installing for Claude writes every skill and command with working script paths", (t) => {
  const root = temp(t);
  const home = path.join(root, "home");
  const dest = path.join(root, ".claude", "skills");
  install({ agent: "claude", dest, home });
  assert.deepEqual(readdirSync(dest).sort(), skills);
  let scripts = 0;
  for (const name of skills) scripts += assertScriptsExist(readFileSync(path.join(dest, name, "SKILL.md"), "utf8"), name);
  assert.ok(scripts >= 8, "skills call the installed scripts");
  assert.ok(existsSync(path.join(dest, "artisanal-doctor", "scripts", "doctor.mjs")), "a skill's own scripts are copied with it");
  assert.ok(existsSync(path.join(home, "references", "rules.json")));
  const tidyCheck = readFileSync(path.join(root, ".claude", "commands", "tidy-check.md"), "utf8");
  assertScriptsExist(tidyCheck, "tidy-check");

  const run = spawnSync(process.execPath, [path.join(home, "scripts", "check.mjs"), path.join(repoRoot, "examples", "clean-project"), "--no-write", "--no-commits"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /No findings/, "the installed scripts run on their own");
});

test("installing for Cursor writes agent-requested rules into the project", (t) => {
  const root = temp(t);
  install({ agent: "cursor", dest: root, home: path.join(root, "home") });
  const rules = readdirSync(path.join(root, ".cursor", "rules")).sort();
  assert.deepEqual(rules, skills.map((s) => `artisanal-${s}.mdc`).sort());
  const rule = readFileSync(path.join(root, ".cursor", "rules", "artisanal-clean-traces.mdc"), "utf8");
  assert.match(rule, /^---\ndescription: Finds and removes AI traces/);
  assert.match(rule, /\nalwaysApply: false\n---\n/);
  assertScriptsExist(rule, "cursor rule");
});

test("existing files are kept unless --force, and --dry-run writes nothing", (t) => {
  const root = temp(t);
  const dest = path.join(root, "skills");
  mkdirSync(path.join(dest, "learn-style"), { recursive: true });
  writeFileSync(path.join(dest, "learn-style", "SKILL.md"), "mine\n");
  assert.throws(() => install({ agent: "dir", dest, home: path.join(root, "home") }), /already exist/);
  assert.equal(readFileSync(path.join(dest, "learn-style", "SKILL.md"), "utf8"), "mine\n");

  const dry = install({ agent: "dir", dest: path.join(root, "other"), home: path.join(root, "home2"), dryRun: true });
  assert.ok(dry.writes.length > skills.length);
  assert.ok(!existsSync(path.join(root, "other")) && !existsSync(path.join(root, "home2")));

  install({ agent: "dir", dest, home: path.join(root, "home"), force: true });
  assert.match(readFileSync(path.join(dest, "learn-style", "SKILL.md"), "utf8"), /^---\nname: learn-style/);
});

test("the CLI needs an agent and a destination where there is no default", (t) => {
  assert.equal(spawnSync(process.execPath, [script]).status, 2);
  assert.equal(spawnSync(process.execPath, [script, "--agent", "emacs"]).status, 1);
  const cursor = spawnSync(process.execPath, [script, "--agent", "cursor"], { encoding: "utf8" });
  assert.equal(cursor.status, 1);
  assert.match(cursor.stderr, /--dest is required/);
  const root = temp(t);
  const dry = spawnSync(process.execPath, [script, "--agent", "codex", "--dest", path.join(root, "s"), "--home", path.join(root, "h"), "--dry-run"], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would install Artisanal for codex/);
});
