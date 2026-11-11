import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { diagnose, formatText } from "../skills/artisanal-doctor/scripts/doctor.mjs";

const hasGit = spawnSync("git", ["--version"]).status === 0;

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "artisanal-doctor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const status = (r, name) => r.checks.find((c) => c.name === name)?.status;
const git = (dir, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });

test("old Node versions are reported as missing", () => {
  const r = diagnose(".", { nodeVersion: "18.19.0" });
  assert.equal(status(r, "node"), "missing");
  assert.equal(r.ready, false);
});

test("a missing folder is reported, not thrown", () => {
  const r = diagnose(path.join(tmpdir(), "artisanal-does-not-exist-xyz"));
  assert.equal(status(r, "project"), "missing");
  assert.equal(r.ready, false);
});

test("a folder that is not a git repo gets a warning with a hint", { skip: !hasGit }, (t) => {
  const r = diagnose(tempDir(t));
  assert.equal(status(r, "git-repo"), "warn");
  assert.match(formatText(r), /git init/);
  assert.equal(r.ready, false);
});

test("uncommitted changes block readiness; a clean repo is ready", { skip: !hasGit }, (t) => {
  const dir = tempDir(t);
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  assert.equal(status(diagnose(dir), "working-tree"), "warn");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  const r = diagnose(dir);
  assert.equal(status(r, "working-tree"), "ok");
  assert.equal(r.ready, true, formatText(r));
});
