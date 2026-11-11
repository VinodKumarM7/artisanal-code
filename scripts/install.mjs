#!/usr/bin/env node
// Installs Artisanal's skills for agents that do not use Claude Code plugins.
//
// The scripts and references are copied once to a home folder (default ~/.artisanal-code), and
// each skill is written for the chosen agent with its script paths pointing there:
//   claude  ~/.claude/skills/<skill>/SKILL.md, plus /tidy and /tidy-check in ~/.claude/commands
//   codex   ~/.codex/skills/<skill>/SKILL.md
//   cursor  <project>/.cursor/rules/artisanal-<skill>.mdc (agent-requested rules)
//   dir     <dest>/<skill>/SKILL.md, for any agent that reads SKILL.md folders
// Existing files are left alone unless --force is given; --dry-run only lists what would change.
//
// Usage: node install.mjs --agent claude|codex|cursor|dir [--dest path] [--home path] [--force] [--dry-run]

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AGENTS = ["claude", "codex", "cursor", "dir"];
const SHARED = ["scripts", "references", "hooks", "package.json", "LICENSE"];

const slash = (p) => p.split(path.sep).join("/");

/** Rewrites a skill or command so its script and reference paths point at `home`. */
export function retarget(text, home) {
  const h = slash(home);
  return text
    .replace(/The script lives in the plugin's `scripts` folder, two levels up from this skill[^.]*\./g, `The script is installed in \`${h}/scripts\`.`)
    .replace(/node (?:\.\.\/\.\.\/|"\$\{CLAUDE_PLUGIN_ROOT\}\/)scripts\/([\w.-]+\.mjs)"?/g, `node "${h}/scripts/$1"`)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//g, `${h}/scripts/`)
    .replace(/`\$\{CLAUDE_PLUGIN_ROOT\}` is the folder this plugin is installed in\./g, `The scripts are installed in \`${h}\`.`)
    .replace(/\.\.\/\.\.\/references\//g, `${h}/references/`);
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { fields: {}, body: text };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2];
  }
  return { fields, body: m[2] };
}

const defaultDest = (agent) => ({ claude: path.join(homedir(), ".claude", "skills"), codex: path.join(homedir(), ".codex", "skills") })[agent] ?? null;

/** Works out every file to write; nothing is written. */
export function planInstall({ agent, dest = null, home = path.join(homedir(), ".artisanal-code") }) {
  if (!AGENTS.includes(agent)) throw new Error(`--agent must be one of ${AGENTS.join(", ")}`);
  const target = dest ? path.resolve(dest) : defaultDest(agent);
  if (!target) throw new Error(`--dest is required for --agent ${agent}${agent === "cursor" ? " (the project folder)" : ""}`);
  const homeDir = path.resolve(home);
  const writes = [];
  for (const entry of SHARED) writes.push({ kind: "copy", from: path.join(pluginRoot, entry), to: path.join(homeDir, entry) });

  const skillsDir = path.join(pluginRoot, "skills");
  for (const name of readdirSync(skillsDir).filter((n) => statSync(path.join(skillsDir, n)).isDirectory()).sort()) {
    const text = retarget(readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8"), homeDir);
    if (agent === "cursor") {
      const { fields, body } = frontmatter(text);
      const mdc = `---\ndescription: ${fields.description ?? name}\nglobs:\nalwaysApply: false\n---\n${body}`;
      writes.push({ kind: "write", to: path.join(target, ".cursor", "rules", `artisanal-${name}.mdc`), text: mdc });
      continue;
    }
    writes.push({ kind: "write", to: path.join(target, name, "SKILL.md"), text });
    for (const extra of readdirSync(path.join(skillsDir, name)).filter((n) => n !== "SKILL.md")) {
      writes.push({ kind: "copy", from: path.join(skillsDir, name, extra), to: path.join(target, name, extra) });
    }
  }
  if (agent === "claude") {
    const commandsDir = path.join(path.dirname(target), "commands");
    for (const name of readdirSync(path.join(pluginRoot, "commands")).filter((n) => n.endsWith(".md"))) {
      writes.push({ kind: "write", to: path.join(commandsDir, name), text: retarget(readFileSync(path.join(pluginRoot, "commands", name), "utf8"), homeDir) });
    }
  }
  return { agent, target, home: homeDir, writes };
}

/** Writes the plan. Refuses to overwrite existing skill, rule or command files unless `force`. */
export function install(options) {
  const plan = planInstall(options);
  const existing = plan.writes.filter((w) => w.kind === "write" && existsSync(w.to)).map((w) => w.to);
  if (existing.length && !options.force) {
    throw new Error(`These files already exist (use --force to replace them): ${existing.slice(0, 4).join(", ")}${existing.length > 4 ? ", ..." : ""}`);
  }
  if (options.dryRun) return { ...plan, written: [] };
  for (const w of plan.writes) {
    mkdirSync(path.dirname(w.to), { recursive: true });
    if (w.kind === "copy") cpSync(w.from, w.to, { recursive: true, force: true });
    else writeFileSync(w.to, w.text);
  }
  return { ...plan, written: plan.writes.map((w) => w.to) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const usage = "Usage: node install.mjs --agent claude|codex|cursor|dir [--dest path] [--home path] [--force] [--dry-run]";
  const args = process.argv.slice(2);
  const opts = {};
  let error = null;
  for (let i = 0; i < args.length && !error; i++) {
    const a = args[i];
    if (a === "--agent") opts.agent = args[++i];
    else if (a === "--dest") opts.dest = args[++i];
    else if (a === "--home") opts.home = args[++i];
    else if (a === "--force") opts.force = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else error = `unknown option ${a}`;
  }
  if (!error && !opts.agent) error = "--agent is required";
  if (error) {
    console.error(`install: ${error}\n${usage}`);
    process.exitCode = 2;
  } else {
    try {
      const installed = install(opts);
      const files = installed.writes.filter((w) => w.kind === "write");
      console.log(`${opts.dryRun ? "Would install" : "Installed"} Artisanal for ${installed.agent}:`);
      console.log(`  scripts and references in ${installed.home}`);
      for (const w of files) console.log(`  ${w.to}`);
      if (installed.agent === "cursor") console.log("\nThe rules live in .cursor/, which should stay out of git (the clean-traces skill checks this).");
      if (installed.agent === "claude") console.log("\nThe edit hook is part of the Claude Code plugin install only; see the README to add it by hand.");
    } catch (err) {
      console.error(`install: ${err.message}`);
      process.exitCode = 1;
    }
  }
}
