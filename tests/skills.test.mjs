// Lints every SKILL.md: frontmatter, naming, and that scripts it names exist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = path.join(repo, "skills");
const skills = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2];
  }
  return fields;
}

test("there is at least one skill", () => assert.ok(skills.length >= 1));

for (const name of skills) {
  test(`skill ${name}: frontmatter, sections and scripts`, () => {
    const text = readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
    const fm = frontmatter(text);
    assert.ok(fm, "has YAML frontmatter");
    assert.equal(fm.name, name, "name matches the folder");
    assert.match(fm.name, /^[a-z0-9-]{1,64}$/);
    assert.ok(fm.description.length >= 80 && fm.description.length <= 1024, "description length");
    assert.match(fm.description, /Use when/i);
    assert.match(text, /^## Workflow$/m);
    assert.match(text, /^## Safety rules$/m);
    for (const [, rel] of text.matchAll(/node ((?:\.\.\/)*scripts\/[\w./-]+\.mjs)/g)) {
      assert.ok(existsSync(path.join(skillsDir, name, rel)), `${rel} exists`);
    }
  });
}
