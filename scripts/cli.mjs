#!/usr/bin/env node
// The `artisanal-code` command, for `npx artisanal-code <command>`. Each command runs one of the
// plugin's scripts with the remaining arguments. `install` with no --agent asks which agent to
// install for when run in a terminal.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

export const COMMANDS = {
  install: ["scripts/install.mjs", "Install the skills for Codex, Cursor, Claude Code or a skills folder"],
  check: ["scripts/check.mjs", "Run the checks and list findings with file, line and evidence"],
  report: ["scripts/report.mjs", "Write a Markdown and HTML report with a cleanliness score"],
  profile: ["scripts/profile.mjs", "Learn the project's style (naming, comments, tests, commits)"],
  fix: ["scripts/fix.mjs", "Plan or apply cleanups: fix plan|apply|start <dir> --scope <scope>"],
  "commit-plan": ["scripts/commit-plan.mjs", "Group changes into focused commits and check messages"],
  doctor: ["skills/artisanal-doctor/scripts/doctor.mjs", "Check Node.js, Git and the project's git state"],
  hook: ["hooks/check-edit.mjs", "Turn the Claude Code edit hook on or off: hook enable|disable|status <dir>"],
};

export function helpText() {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  return [
    `artisanal-code ${version}: clean, simple, codebase-native code from AI coding agents.`,
    "",
    "Usage: npx artisanal-code <command> [options]",
    "",
    ...Object.entries(COMMANDS).map(([name, [, about]]) => `  ${name.padEnd(width)}  ${about}`),
    "",
    "Each command prints its own usage when run without its required options, for example: npx artisanal-code fix",
    "In Claude Code, the plugin is the easiest way in: /plugin marketplace add VinodKumarM7/artisanal-code",
  ].join("\n");
}

/** Agents that look installed on this machine (or set up in `cwd`), in the order offered. */
export function detectAgents(cwd = process.cwd(), home = homedir()) {
  const found = [];
  if (existsSync(path.join(home, ".codex"))) found.push("codex");
  if (existsSync(path.join(cwd, ".cursor"))) found.push("cursor");
  if (existsSync(path.join(home, ".claude"))) found.push("claude");
  return found;
}

const CHOICES = [
  ["codex", "Codex (~/.codex/skills)"],
  ["cursor", "Cursor, as rules in this folder (.cursor/rules)"],
  ["claude", "Claude Code without the plugin (~/.claude/skills and commands)"],
  ["dir", "A folder of SKILL.md skills you choose"],
];

/** Asks which agent to install for; returns the extra install arguments. */
async function askForAgent() {
  const detected = detectAgents();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Install Artisanal for which agent?");
    CHOICES.forEach(([id, label], i) => console.log(`  ${i + 1}) ${label}${detected.includes(id) ? "  (found)" : ""}`));
    const answer = (await rl.question(`Choose 1-${CHOICES.length}: `)).trim();
    const choice = CHOICES[Number(answer) - 1]?.[0] ?? CHOICES.find(([id]) => id === answer)?.[0];
    if (!choice) return null;
    if (choice === "cursor") return ["--agent", "cursor", "--dest", process.cwd()];
    if (choice === "dir") {
      const dest = (await rl.question("Skills folder: ")).trim();
      return dest ? ["--agent", "dir", "--dest", dest] : null;
    }
    return ["--agent", choice];
  } finally {
    rl.close();
  }
}

export async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(helpText());
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "-v") {
    console.log(version);
    return 0;
  }
  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`artisanal-code: unknown command ${command}\n\n${helpText()}`);
    return 2;
  }
  let forwarded = args;
  if (command === "install" && !args.includes("--agent")) {
    if (!process.stdin.isTTY) {
      console.error(`artisanal-code install: choose an agent with --agent ${CHOICES.map(([id]) => id).join("|")} (for cursor and dir, add --dest <folder>).`);
      return 2;
    }
    const picked = await askForAgent();
    if (!picked) {
      console.error("No agent chosen; nothing installed.");
      return 2;
    }
    forwarded = [...picked, ...args];
  }
  const res = spawnSync(process.execPath, [path.join(root, entry[0]), ...forwarded], { stdio: "inherit" });
  return res.status ?? 1;
}

// npm starts bin commands through a link, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href) {
  process.exitCode = await main(process.argv.slice(2));
}
