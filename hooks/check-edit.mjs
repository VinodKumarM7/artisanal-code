#!/usr/bin/env node
// Claude Code PostToolUse hook: checks the file the agent just edited and tells the agent about
// new findings, so it fixes its own habits as it works. It does nothing until enabled for a
// project, and it never edits files itself.
//
// As a hook it reads the tool call from stdin. A finding is reported once: the same rule on the
// same line text is not repeated on later edits. Exit code 2 sends the report to the agent.
//
// Usage: node check-edit.mjs enable|disable|status [projectDir] [--level low|medium|high]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkOneFile } from "../scripts/check.mjs";

const LEVELS = ["high", "medium", "low"];
const MAX_REPORTED = 10;
const MAX_REMEMBERED = 2000;

const settingsFile = (dir) => path.join(dir, ".artisanal", "settings.json");
const stateFile = (dir) => path.join(dir, ".artisanal", "hook-state.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** The hook settings for a project: `{ enabled, level }`. ARTISANAL_EDIT_HOOK=1 or 0 overrides. */
export function hookSettings(projectDir) {
  const saved = readJson(settingsFile(projectDir), {});
  const env = process.env.ARTISANAL_EDIT_HOOK;
  const enabled = env === "1" ? true : env === "0" ? false : saved.editHook === true;
  const level = LEVELS.includes(saved.editHookLevel) ? saved.editHookLevel : "medium";
  return { enabled, level };
}

export function setHook(projectDir, enabled, level) {
  const saved = readJson(settingsFile(projectDir), {});
  saved.editHook = enabled;
  if (level) saved.editHookLevel = level;
  writeJson(settingsFile(projectDir), saved);
  return hookSettings(projectDir);
}

/**
 * Handles one hook event and returns the report for the agent, or null when there is nothing
 * new to say (hook off, file outside the project, no new findings at or above the level).
 */
export function handleEvent(event, { projectDir = process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd() } = {}) {
  const dir = path.resolve(projectDir);
  const file = event?.tool_input?.file_path;
  if (!file) return null;
  const settings = hookSettings(dir);
  if (!settings.enabled) return null;

  const rank = (s) => LEVELS.indexOf(s);
  const findings = checkOneFile(dir, path.resolve(dir, file)).filter((f) => rank(f.severity) <= rank(settings.level));
  const state = readJson(stateFile(dir), { seen: [] });
  const seen = new Set(state.seen);
  const key = (f) => `${f.rule}|${f.file}|${f.evidence}`;
  const fresh = findings.filter((f) => !seen.has(key(f)));
  if (!fresh.length) return null;
  state.seen = [...state.seen, ...fresh.map(key)].slice(-MAX_REMEMBERED);
  writeJson(stateFile(dir), state);

  fresh.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.line ?? 0) - (b.line ?? 0));
  const out = [`Artisanal found ${fresh.length} issue${fresh.length === 1 ? "" : "s"} in ${fresh[0].file}. Fix the ones your edit introduced; leave older code alone unless the user asked for it.`];
  for (const f of fresh.slice(0, MAX_REPORTED)) {
    out.push(`- ${f.file}${f.line ? `:${f.line}` : ""} ${f.rule} (${f.severity}): ${f.message}`);
    if (f.evidence && f.evidence !== f.file) out.push(`    ${f.evidence}`);
    out.push(`    Instead: ${f.instead}`);
  }
  if (fresh.length > MAX_REPORTED) out.push(`...and ${fresh.length - MAX_REPORTED} more. Run the /tidy-check command for the full list.`);
  return out.join("\n");
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command) {
    const levelAt = args.indexOf("--level");
    const level = levelAt >= 0 ? args[levelAt + 1] : null;
    const dir = path.resolve(args.find((a, i) => !a.startsWith("--") && (levelAt < 0 || i !== levelAt + 1)) ?? ".");
    if (!["enable", "disable", "status"].includes(command) || (level && !LEVELS.includes(level)) || !existsSync(dir)) {
      console.error("Usage: node check-edit.mjs enable|disable|status [projectDir] [--level low|medium|high]");
      process.exitCode = 2;
    } else {
      const s = command === "status" ? hookSettings(dir) : setHook(dir, command === "enable", level);
      console.log(`Artisanal edit hook is ${s.enabled ? "on" : "off"} for ${dir}${s.enabled ? ` (reports ${s.level} and above)` : ""}.`);
    }
  } else {
    // Hook mode: never block the agent because of a problem in the hook itself.
    try {
      const report = handleEvent(JSON.parse(await readStdin()));
      if (report) {
        process.stderr.write(`${report}\n`);
        process.exitCode = 2;
      }
    } catch {
      process.exitCode = 0;
    }
  }
}
