#!/usr/bin/env node
// Checks the tools Artisanal needs and whether a project is ready for cleanup.
// Read-only: runs version and status commands only, changes nothing.
//
// Usage: node doctor.mjs [projectDir] [--json]

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIN_NODE_MAJOR = 20;

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (res.error || res.status !== 0) return null;
  return res.stdout.trim();
}

/** Returns the check results for `projectDir`. */
export function diagnose(projectDir = ".", { nodeVersion = process.versions.node } = {}) {
  const checks = [];
  const add = (name, status, detail, hint) => checks.push({ name, status, detail, ...(hint ? { hint } : {}) });

  const major = Number(nodeVersion.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) add("node", "ok", `Node.js ${nodeVersion}`);
  else add("node", "missing", `Node.js ${nodeVersion} is too old`, `Install Node.js ${MIN_NODE_MAJOR} or later from https://nodejs.org`);

  const gitVersion = run("git", ["--version"]);
  if (gitVersion) add("git", "ok", gitVersion.replace(/^git version /, "Git "));
  else add("git", "missing", "Git not found", "Install Git from https://git-scm.com");

  const dir = path.resolve(projectDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    add("project", "missing", `Folder not found: ${projectDir}`);
    return { projectDir: dir, ready: false, checks };
  }
  add("project", "ok", dir);

  if (gitVersion) {
    const top = run("git", ["rev-parse", "--show-toplevel"], dir);
    if (!top) {
      add("git-repo", "warn", "Not a git repository", "Run `git init` and commit first, so every cleanup can be reviewed and undone.");
    } else {
      add("git-repo", "ok", top);
      const branch = run("git", ["branch", "--show-current"], dir);
      add("branch", "ok", branch || "(detached HEAD)");
      const hasCommits = run("git", ["rev-parse", "--verify", "HEAD"], dir) !== null;
      if (!hasCommits) add("commits", "warn", "No commits yet", "Commit your current work first.");
      const status = run("git", ["status", "--porcelain"], dir);
      if (status === null) add("working-tree", "warn", "Could not read git status");
      else if (status) {
        const n = status.split(/\r?\n/).length;
        add("working-tree", "warn", `${n} uncommitted change${n === 1 ? "" : "s"}`, "Commit or stash them first, so cleanup changes stay separate from your own work.");
      } else add("working-tree", "ok", "Clean");
    }
  }

  const ready = checks.every((c) => c.status === "ok");
  return { projectDir: dir, ready, checks };
}

export function formatText(result) {
  const out = ["Artisanal doctor", ""];
  for (const c of result.checks) {
    out.push(`  ${c.status.padEnd(8)} ${c.name.padEnd(13)} ${c.detail}`);
    if (c.hint) out.push(`  ${"".padEnd(8)} ${"".padEnd(13)} -> ${c.hint}`);
  }
  out.push("", result.ready ? "Ready." : "Not ready yet: see the notes above.");
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const bad = args.find((a) => a.startsWith("--") && a !== "--json");
  if (bad) {
    console.error(`doctor: unknown option ${bad}\nUsage: node doctor.mjs [projectDir] [--json]`);
    process.exitCode = 2;
  } else {
    const diagnosis = diagnose(args.find((a) => !a.startsWith("--")) ?? ".");
    console.log(args.includes("--json") ? JSON.stringify(diagnosis, null, 2) : formatText(diagnosis));
  }
}
