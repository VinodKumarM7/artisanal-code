import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (p) => JSON.parse(readFileSync(path.join(repo, p), "utf8"));

test("plugin, marketplace and package versions match", () => {
  const plugin = json(".claude-plugin/plugin.json");
  const marketplace = json(".claude-plugin/marketplace.json");
  const pkg = json("package.json");
  assert.equal(plugin.name, "artisanal-code");
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(marketplace.plugins[0].source, "./");
  assert.equal(marketplace.plugins[0].version, plugin.version);
  assert.equal(marketplace.metadata.version, plugin.version);
  assert.equal(pkg.version, plugin.version);
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
});

test("AI tool files and planning notes are ignored by git", () => {
  const ignore = readFileSync(path.join(repo, ".gitignore"), "utf8").split(/\r?\n/);
  for (const entry of ["CLAUDE.md", "AGENTS.md", ".claude/", ".cursor/", ".cursorrules", "plan.md", ".artisanal/"]) {
    assert.ok(ignore.includes(entry), entry);
  }
});
