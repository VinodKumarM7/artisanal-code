import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, detectAgents, helpText } from "../scripts/cli.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const cli = path.join(repoRoot, pkg.bin["artisanal-code"]);
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("the package exposes the artisanal-code command and ships what it needs", () => {
  assert.equal(pkg.private, undefined, "publishable");
  assert.match(readFileSync(cli, "utf8"), /^#!\/usr\/bin\/env node/);
  const shipped = (rel) => pkg.files.some((f) => rel === f.replace(/\/$/, "") || rel.startsWith(f));
  for (const [name, [script]] of Object.entries(COMMANDS)) {
    assert.ok(existsSync(path.join(repoRoot, script)), `${name}: ${script}`);
    assert.ok(shipped(script), `${script} is in package.json files`);
  }
  for (const needed of ["references/rules.json", "hooks/hooks.json", "commands/tidy.md", "skills/learn-style/SKILL.md", ".claude-plugin/plugin.json"]) {
    assert.ok(shipped(needed), `${needed} is in package.json files`);
  }
  assert.ok(!shipped("tests/cli.test.mjs") && !shipped("examples/clean-project/package.json"), "tests and examples stay out");
});

test("--version, help and unknown commands", () => {
  assert.equal(run("--version").stdout.trim(), pkg.version);
  const help = run("help");
  assert.equal(help.status, 0);
  for (const name of Object.keys(COMMANDS)) assert.match(help.stdout, new RegExp(`\\b${name}\\b`));
  assert.equal(run().status, 2, "no command prints help and exits 2");
  assert.equal(run("frobnicate").status, 2);
  assert.match(helpText(), /npx artisanal-code <command>/);
});

test("commands run the matching script with the remaining arguments", () => {
  const check = run("check", path.join(repoRoot, "examples", "clean-project"), "--no-write", "--no-commits");
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /No findings/);
  assert.equal(run("fix").status, 2, "the script's own usage errors come through");
});

test("install without --agent asks in a terminal and explains itself otherwise", () => {
  const res = run("install");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--agent codex\|cursor\|claude\|dir/);
});

test("installed agents are detected from their folders", () => {
  const home = mkdtempSync(path.join(tmpdir(), "artisanal-cli-home-"));
  const project = mkdtempSync(path.join(tmpdir(), "artisanal-cli-project-"));
  try {
    assert.deepEqual(detectAgents(project, home), []);
    mkdirSync(path.join(home, ".codex"));
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(project, ".cursor"));
    assert.deepEqual(detectAgents(project, home), ["codex", "cursor", "claude"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
