#!/usr/bin/env node
// Splits uncommitted work into focused commits and keeps commit messages in the project's own
// style, learned from its history.
//
// `plan` groups the staged changes (or all changes with --all) into proposed commits and prints
// the project's commit style; nothing changes. `lint` checks a draft message against that style:
// AI trailers and "Generated with" lines are errors, style differences are warnings. `commit`
// commits one group's files with a message that passes the lint, and nothing else.
//
// Usage: node commit-plan.mjs plan   [projectDir] [--all] [--json]
//        node commit-plan.mjs lint   [projectDir] (--message "..." | --file msg.txt) [--json]
//        node commit-plan.mjs commit [projectDir] --group N --file msg.txt [--json]

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EMOJI, wordingIn } from "./checks/code.mjs";
import { templatedReason } from "./checks/commits.mjs";
import { aiToolEntry } from "./checks/project.mjs";
import { AI_GENERATED, AI_TRAILER, BULLET, classifySubject, proseLines, verbForm } from "./lib/commits.mjs";
import { run } from "./lib/source.mjs";
import { commitsSummary, writeArtisanalFile } from "./profile.mjs";

const SCHEMA = 1;
const git = (dir, ...args) => run("git", args, dir);
const pct = (x) => `${Math.round(x * 100)}%`;

// ---- Style.

/** The commit style to follow, from recent history; falls back to common git conventions. */
export function commitStyle(projectDir) {
  const c = commitsSummary(path.resolve(projectDir), 200);
  if (!c.analyzed || c.analyzed < 5) {
    return {
      known: false, analyzed: c.analyzed ?? 0, format: "plain", formatShare: 0, types: [], scopes: [], scopedShare: 0,
      capitalizedShare: 0.9, periodShare: 0, mood: "imperative", moodShare: 1, medianLength: 50, maxLength: 72,
      bodyShare: null, bulletShare: null, emoji: false, examples: c.recentSubjects ?? [],
      note: "Fewer than 5 commits to learn from, so this uses common git conventions: a capitalized, imperative subject without a period, up to 72 characters.",
    };
  }
  const rank = (obj = {}) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return {
    known: true,
    analyzed: c.analyzed,
    format: c.format.dominant,
    formatShare: c.format.share,
    types: rank(c.conventionalTypes),
    scopes: rank(c.scopes).slice(0, 8),
    scopedShare: c.scopedShare ?? 0,
    capitalizedShare: c.subject.capitalizedShare,
    periodShare: c.subject.endsWithPeriodShare,
    mood: c.subject.mood?.dominant ?? null,
    moodShare: c.subject.mood?.share ?? 0,
    medianLength: c.subject.medianLength,
    maxLength: Math.max(50, Math.min(100, c.subject.p90Length + 10)),
    bodyShare: c.body.share,
    bulletShare: c.body.bulletShare,
    emoji: c.subject.emojiShare >= 0.2,
    examples: c.recentSubjects,
  };
}

export function describeStyle(style) {
  if (!style.known) return style.note;
  const parts = [`${style.format} subjects (${pct(style.formatShare)} of ${style.analyzed} commits)`];
  if (style.types.length) parts.push(`types ${style.types.slice(0, 6).join(", ")}`);
  if (style.scopes.length) parts.push(`a scope in ${pct(style.scopedShare)} (${style.scopes.slice(0, 5).join(", ")})`);
  parts.push(style.capitalizedShare >= 0.5 ? "capitalized" : "lowercase start");
  parts.push(style.periodShare >= 0.5 ? "ending with a period" : "no period");
  if (style.mood) parts.push(`${style.mood} verbs`);
  parts.push(`about ${style.medianLength} characters (at most ${style.maxLength})`);
  parts.push(`a body in ${pct(style.bodyShare)} of commits${style.bodyShare ? `, bulleted in ${pct(style.bulletShare)} of those` : ""}`);
  return `${parts.join("; ")}.`;
}

/** Checks a commit message against `style`. Errors block a commit; warnings are style hints. */
export function lintMessage(message, style) {
  const errors = [];
  const warnings = [];
  const lines = message.replace(/\r/g, "").split("\n");
  const subject = lines[0].trim();
  const body = lines.slice(1).join("\n").trim();
  if (!subject) errors.push("The subject line is empty.");
  if (AI_TRAILER.test(message)) errors.push("AI co-author trailer: leave it out; the commit's author is the person committing.");
  if (AI_GENERATED.test(message)) errors.push('"Generated with" line: describe the change instead.');
  if (!subject) return { ok: false, errors, warnings };
  if (lines[1]?.trim()) warnings.push("Leave a blank line between the subject and the body.");

  const s = classifySubject(subject);
  if (style.formatShare >= 0.6 && s.format !== style.format) warnings.push(`The subject is ${s.format}; this project writes ${style.format} subjects (${pct(style.formatShare)}).`);
  if (s.format === "conventional" && style.format === "conventional") {
    if (style.analyzed >= 10 && style.types.length && !style.types.includes(s.type)) warnings.push(`Type "${s.type}" is not used in this project; used: ${style.types.join(", ")}.`);
    if (style.scopedShare >= 0.7 && !s.scoped) warnings.push(`Most commits here name a scope (${style.scopes.slice(0, 4).join(", ")}).`);
    if (style.scopedShare <= 0.1 && s.scoped && style.analyzed >= 10) warnings.push("Commits here rarely name a scope.");
  }
  const desc = s.description.trim();
  if (style.capitalizedShare >= 0.8 && /^[a-z]/.test(desc)) warnings.push("Start the description with a capital letter, as this project does.");
  if (style.capitalizedShare <= 0.2 && /^[A-Z][a-z]/.test(desc)) warnings.push("Start the description with a lowercase letter, as this project does.");
  if (style.periodShare >= 0.8 && !subject.endsWith(".")) warnings.push("End the subject with a period, as this project does.");
  if (style.periodShare <= 0.2 && subject.endsWith(".")) warnings.push("Drop the period at the end of the subject.");
  const form = verbForm(desc.split(/\s+/)[0] ?? "");
  if (style.mood && style.moodShare >= 0.6 && form && form !== style.mood) warnings.push(`Use the ${style.mood} form of the first verb, as this project does (it reads as ${form} here).`);
  if (subject.length > style.maxLength) warnings.push(`The subject is ${subject.length} characters; this project keeps them under ${style.maxLength}.`);
  if (EMOJI.test(subject) && !style.emoji) warnings.push("Drop the emoji from the subject.");
  const words = wordingIn(message);
  if (words.length) warnings.push(`Filler wording: ${words.join(", ")}.`);
  const templated = templatedReason(body);
  if (templated) warnings.push(`The body reads like a generated report (${templated}); a short paragraph on why is enough.`);
  const bullets = proseLines(body).filter((l) => BULLET.test(l)).length;
  if (!templated && bullets >= 3 && style.known && style.analyzed >= 10 && (style.bulletShare ?? 0) < 0.2) warnings.push("This project rarely uses bullet lists in commit bodies.");
  return { ok: !errors.length, errors, warnings };
}

// ---- Grouping.

const CONFIG = /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[\w.-]*\.txt|pyproject\.toml|setup\.cfg|setup\.py|Pipfile(?:\.lock)?|poetry\.lock|tsconfig[\w.-]*\.json|\.eslintrc[\w.]*|eslint\.config\.[cm]?js|\.prettierrc[\w.]*|[\w.-]+\.config\.[cm]?[jt]s|Dockerfile|docker-compose[\w.-]*\.ya?ml|Makefile|\.editorconfig|\.nvmrc|\.gitattributes|sfdx-project\.json|pom\.xml|build\.gradle(?:\.kts)?)$|^\.github\/|(^|\/)\.gitlab-ci\.yml$/;
const DOC = /\.(?:md|mdx|rst|adoc)$|^docs?\//i;
const TEST = /(^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(?:Test|Tests)\.(?:java|cls)$/;
const testStem = (file) => path.posix.basename(file).replace(/\.(?:test|spec)(?=\.)/, "").replace(/^test_/, "").replace(/_test(?=\.py$)/, "").replace(/Tests?(?=\.(?:java|cls)$)/, "").replace(/\.[^.]+$/, "");
const stem = (file) => path.posix.basename(file).replace(/\.[^.]+$/, "");

function area(file) {
  const parts = file.split("/");
  if (parts.length === 1) return "(root)";
  if (["packages", "apps", "services", "libs", "modules", "src", "lib", "app", "source"].includes(parts[0]) && parts.length > 2) return parts.slice(0, 2).join("/");
  return parts[0];
}

function parseNameStatus(out) {
  const fields = out.split("\0").filter((f) => f !== "");
  const changes = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (/^[RC]/.test(status)) {
      changes.push({ status: status[0], old: fields[i + 1], path: fields[i + 2] });
      i += 2;
    } else {
      changes.push({ status: status[0], path: fields[i + 1] });
      i += 1;
    }
  }
  return changes;
}

/** Uncommitted changes: the staged ones, or with `all` everything including untracked files. */
export function listChanges(projectDir, { all = false } = {}) {
  const dir = path.resolve(projectDir);
  const hasHead = git(dir, "rev-parse", "--verify", "HEAD") !== null;
  const base = hasHead ? ["HEAD"] : ["--cached"];
  const staged = parseNameStatus(git(dir, "diff", "--cached", "--name-status", "-M", "-z") ?? "");
  let changes = staged;
  if (all) {
    const tracked = hasHead ? parseNameStatus(git(dir, "diff", ...base, "--name-status", "-M", "-z") ?? "") : staged;
    const untracked = (git(dir, "ls-files", "--others", "--exclude-standard", "-z") ?? "").split("\0").filter(Boolean).map((p) => ({ status: "A", path: p }));
    changes = [...tracked, ...untracked];
  }
  const unstaged = new Set((git(dir, "diff", "--name-only", "-z") ?? "").split("\0").filter(Boolean));
  return changes
    .filter((c) => !c.path.startsWith(".artisanal/"))
    .map((c) => ({ ...c, partlyStaged: !all && unstaged.has(c.path) }));
}

/** Groups changes into focused commits: AI tool files, removals, each area with its tests, config, docs. */
export function groupChanges(changes, style) {
  const groups = new Map();
  const put = (key, meta, change) => {
    if (!groups.has(key)) groups.set(key, { ...meta, files: [] });
    groups.get(key).files.push(change);
  };
  const conventional = style.format === "conventional";
  const typeFor = (kind) => {
    if (!conventional) return null;
    const pick = (...types) => types.find((t) => style.types.includes(t)) ?? types[types.length - 1];
    return { ignore: "chore", removal: "chore", tests: pick("test", "tests", "chore"), config: pick("build", "chore"), docs: pick("docs", "doc", "chore") }[kind] ?? null;
  };

  const sources = changes.filter((c) => !TEST.test(c.path) && !CONFIG.test(c.path) && !DOC.test(c.path));
  const sourceByStem = new Map(sources.filter((c) => c.status !== "D").map((c) => [stem(c.path), c]));
  const aiChanges = changes.filter((c) => aiToolEntry(c.path));

  for (const c of changes) {
    if (aiToolEntry(c.path) || (path.posix.basename(c.path) === ".gitignore" && aiChanges.length)) {
      put("ignore", { kind: "ignore", title: "Stop tracking AI tool files" }, c);
    } else if (CONFIG.test(c.path)) put("config", { kind: "config", title: "Build and configuration" }, c);
    else if (DOC.test(c.path) && !TEST.test(c.path)) put("docs", { kind: "docs", title: "Documentation" }, c);
    else if (TEST.test(c.path)) {
      const partner = sourceByStem.get(testStem(c.path));
      if (partner) put(`area:${area(partner.path)}`, { kind: "source", title: `Changes in ${area(partner.path)}`, area: area(partner.path) }, c);
      else put("tests", { kind: "tests", title: "Tests" }, c);
    } else if (c.status === "D") put("removal", { kind: "removal", title: "Remove unused files" }, c);
    else put(`area:${area(c.path)}`, { kind: "source", title: `Changes in ${area(c.path)}`, area: area(c.path) }, c);
  }

  const order = ["ignore", "removal", "source", "tests", "config", "docs"];
  return [...groups.values()]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.area ?? "").localeCompare(b.area ?? ""))
    .map((g, i) => ({
      id: i + 1,
      ...g,
      suggestedType: typeFor(g.kind),
      suggestedScope: g.kind === "source" && conventional && style.scopedShare >= 0.3 ? g.area.split("/").pop() : null,
    }));
}

export function buildCommitPlan(projectDir, { all = false } = {}) {
  const dir = path.resolve(projectDir);
  if (git(dir, "rev-parse", "--show-toplevel") === null) throw new Error("Not a git repository.");
  const style = commitStyle(dir);
  const changes = listChanges(dir, { all });
  const groups = groupChanges(changes, style);
  return {
    tool: "artisanal-code",
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    project: path.basename(dir),
    mode: all ? "all" : "staged",
    branch: git(dir, "branch", "--show-current")?.trim() || null,
    style,
    groups,
    partlyStaged: changes.filter((c) => c.partlyStaged).map((c) => c.path),
  };
}

// ---- Commit.

/** Commits one group's files (and only those) with `message`, after checking the message. */
export function commitGroup(projectDir, plan, groupId, message) {
  const dir = path.resolve(projectDir);
  const group = plan.groups.find((g) => g.id === Number(groupId));
  if (!group) throw new Error(`No group ${groupId} in the plan.`);
  const lint = lintMessage(message, plan.style);
  if (!lint.ok) throw new Error(`The message cannot be used: ${lint.errors.join(" ")}`);

  const current = new Set(listChanges(dir, { all: true }).flatMap((c) => [c.path, c.old].filter(Boolean)));
  const paths = group.files.flatMap((f) => [f.path, f.old].filter(Boolean));
  const gone = paths.filter((p) => !current.has(p));
  if (gone.length) throw new Error(`These files have no uncommitted changes any more: ${gone.join(", ")}. Run the plan again.`);

  if (git(dir, "add", "-A", "--", ...paths) === null) throw new Error("git add failed.");
  const messageDir = mkdtempSync(path.join(tmpdir(), "artisanal-commit-"));
  const msgFile = path.join(messageDir, "message.txt");
  writeFileSync(msgFile, message.endsWith("\n") ? message : `${message}\n`);
  const res = spawnSync("git", ["commit", "-q", "-F", msgFile, "--", ...paths], { cwd: dir, encoding: "utf8", windowsHide: true });
  rmSync(messageDir, { recursive: true, force: true });
  if (res.status !== 0) throw new Error(`git commit failed: ${(res.stderr || res.stdout).trim()}`);
  return {
    group: group.id,
    hash: git(dir, "rev-parse", "--short", "HEAD")?.trim(),
    subject: message.split(/\r?\n/)[0].trim(),
    files: paths.length,
    warnings: lint.warnings,
  };
}

// ---- Output.

const STATUS = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" };

export function formatCommitPlan(plan) {
  const out = [`Artisanal commit plan: ${plan.project} (${plan.mode === "all" ? "all uncommitted changes" : "staged changes"}${plan.branch ? ` on ${plan.branch}` : ""})`, ""];
  out.push("Commit style", `  ${describeStyle(plan.style)}`);
  if (plan.style.examples.length) {
    out.push("  Recent subjects:");
    for (const s of plan.style.examples.slice(0, 5)) out.push(`    ${s}`);
  }
  out.push("");
  if (!plan.groups.length) {
    out.push(plan.mode === "all" ? "Nothing to commit." : "Nothing is staged. Stage files with `git add`, or plan everything with --all.");
    return out.join("\n");
  }
  out.push("Proposed commits");
  for (const g of plan.groups) {
    const hints = [g.suggestedType && `type ${g.suggestedType}`, g.suggestedScope && `scope ${g.suggestedScope}`].filter(Boolean).join(", ");
    out.push(`  ${String(g.id).padEnd(3)}${g.title}${hints ? `  [${hints}]` : ""}`);
    for (const f of g.files) out.push(`       ${(STATUS[f.status] ?? f.status).padEnd(9)} ${f.old ? `${f.old} -> ` : ""}${f.path}`);
  }
  out.push("");
  if (plan.partlyStaged.length) {
    out.push(`Note: ${plan.partlyStaged.join(", ")} also ${plan.partlyStaged.length === 1 ? "has" : "have"} unstaged changes; committing a group commits whole files.`, "");
  }
  out.push("Nothing is committed yet. For each group: write the message, check it with `commit-plan.mjs lint --file msg.txt`, then run `commit-plan.mjs commit --group N --file msg.txt`.");
  return out.join("\n");
}

const planFile = (dir) => path.join(path.resolve(dir), ".artisanal", "commit-plan.json");

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const usage = [
    "Usage: node commit-plan.mjs plan   [projectDir] [--all] [--json]",
    '       node commit-plan.mjs lint   [projectDir] (--message "..." | --file msg.txt) [--json]',
    "       node commit-plan.mjs commit [projectDir] --group N --file msg.txt [--json]",
  ].join("\n");
  const [command, ...args] = process.argv.slice(2);
  const opts = { dir: ".", json: false };
  let error = ["plan", "lint", "commit"].includes(command) ? null : `unknown command ${command ?? "(none)"}`;
  for (let i = 0; i < args.length && !error; i++) {
    const a = args[i];
    if (a === "--json") opts.json = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--message") opts.message = args[++i];
    else if (a === "--file") opts.file = args[++i];
    else if (a === "--group") opts.group = args[++i];
    else if (a.startsWith("--")) error = `unknown option ${a}`;
    else opts.dir = a;
  }
  if (!error && (command === "lint" || command === "commit") && opts.message === undefined && !opts.file) error = `${command} needs --message or --file`;
  if (!error && command === "commit" && !opts.group) error = "commit needs --group";
  if (!error && (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory())) error = `folder not found: ${opts.dir}`;
  if (error) {
    console.error(`commit-plan: ${error}\n${usage}`);
    process.exitCode = 2;
  } else {
    try {
      const message = opts.file ? readFileSync(opts.file, "utf8") : opts.message;
      if (command === "plan") {
        const plan = buildCommitPlan(opts.dir, { all: opts.all });
        writeArtisanalFile(opts.dir, "commit-plan.json", plan);
        console.log(opts.json ? JSON.stringify(plan, null, 2) : formatCommitPlan(plan));
      } else if (command === "lint") {
        const lint = lintMessage(message, commitStyle(opts.dir));
        if (opts.json) console.log(JSON.stringify(lint, null, 2));
        else {
          for (const e of lint.errors) console.log(`error    ${e}`);
          for (const w of lint.warnings) console.log(`warning  ${w}`);
          if (!lint.errors.length && !lint.warnings.length) console.log("The message fits this project's style.");
        }
        if (!lint.ok) process.exitCode = 1;
      } else {
        if (!existsSync(planFile(opts.dir))) throw new Error("No commit plan found. Run: commit-plan.mjs plan");
        const plan = JSON.parse(readFileSync(planFile(opts.dir), "utf8"));
        const committed = commitGroup(opts.dir, plan, opts.group, message);
        if (opts.json) console.log(JSON.stringify(committed, null, 2));
        else {
          console.log(`Committed group ${committed.group} as ${committed.hash}: ${committed.subject} (${committed.files} file${committed.files === 1 ? "" : "s"})`);
          for (const w of committed.warnings) console.log(`  warning  ${w}`);
        }
      }
    } catch (err) {
      console.error(`commit-plan: ${err.message}`);
      process.exitCode = 1;
    }
  }
}
