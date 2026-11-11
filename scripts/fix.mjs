#!/usr/bin/env node
// Plans and applies the mechanical cleanups behind the clean-traces and remove-leftovers skills.
//
// `plan` runs the checks for one scope and lists numbered actions with a preview of what each
// removes; nothing changes. `apply` performs only the actions named by id, on a new branch
// (artisanal/<scope>-<date>) in a clean working tree, and skips any file that changed since
// the plan. It never commits and never rewrites history; findings it cannot fix safely are
// listed under "needs a person" instead.
//
// Usage: node fix.mjs plan  [projectDir] --scope traces|leftovers [--json]
//        node fix.mjs apply [projectDir] --scope traces|leftovers (--ids T1,T2 | --all) [--branch name] [--json]

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runChecks } from "./check.mjs";
import { aiToolEntry } from "./checks/project.mjs";
import { ANALYZED, languageOf, leadingWidth, matchPair, parseSource, run } from "./lib/source.mjs";
import { writeArtisanalFile } from "./profile.mjs";

const SCHEMA = 1;
export const SCOPES = {
  traces: { prefix: "T", skill: "clean-traces", rules: ["ai-tool-file-tracked", "ai-mention", "ai-self-talk", "ai-commit-trailer", "ai-commit-mention"] },
  leftovers: { prefix: "L", skill: "remove-leftovers", rules: ["unreferenced-file", "scratch-file", "commented-out-code", "debug-logging", "placeholder-todo", "not-implemented-stub"] },
};

const sha1 = (text) => createHash("sha1").update(text).digest("hex");
const git = (dir, ...args) => run("git", args, dir);

/** Splits text into lines, remembering the line ending and whether the file ends with one. */
function splitText(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const trailing = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  return { lines, eol, trailing };
}
const joinText = ({ lines, eol, trailing }) => lines.join(eol) + (trailing && lines.length ? eol : "");

// ---- Deciding whether a line can be removed on its own.

const SELF_CONTAINED_COMMENT = (raw) => {
  const t = raw.trim();
  return /^(?:\/\/|#)/.test(t) || (/^\*(?!\/)/.test(t) && !t.includes("*/")) || /^\/\*.*\*\/$/.test(t);
};

/** The 0-based line range to delete for a comment or doc line, or a reason it needs a person. */
function commentRange(parsed, line) {
  const l = parsed.lines[line];
  const raw = parsed.raw[line] ?? "";
  if (!l || l.code.trim()) return { reason: "the comment shares its line with code" };
  if (parsed.language === "python" && l.doc) {
    if (/"""|'''/.test(raw)) return { reason: "the text is on the same line as the docstring quotes" };
    return { start: line, end: line };
  }
  if (!SELF_CONTAINED_COMMENT(raw)) return { reason: "the line opens or closes a comment block" };
  let start = line;
  let end = line;
  // A doc block left with nothing in it goes too.
  const opener = (parsed.raw[line - 1] ?? "").trim();
  const closer = (parsed.raw[line + 1] ?? "").trim();
  if (/^\/\*\*?$/.test(opener) && closer === "*/") {
    start = line - 1;
    end = line + 1;
  }
  return { start, end };
}

const LOG_START = /^(?:console\.\w+\s*\(|print\s*\(|System\.debug\s*\(|System\.(?:out|err)\.print\w*\s*\(|\w+\.printStackTrace\s*\(|debugger\b|breakpoint\s*\(|pdb\.set_trace\s*\(|import\s+pdb\b)/i;

/** The line to delete for a debug statement, or a reason it needs a person. */
function debugRange(parsed, line) {
  const code = parsed.lines[line]?.code ?? "";
  const t = code.trim();
  if (!LOG_START.test(t)) return { reason: "the call is part of a larger statement" };
  const open = t.indexOf("(");
  if (open >= 0) {
    const close = matchPair(t, open);
    if (close < 0) return { reason: "the call continues on the next line" };
    if (t.slice(close + 1).replace(/^\s*;?/, "").trim()) return { reason: "another statement shares the line" };
  }
  const codeLines = parsed.lines.map((l, i) => ({ i, code: l.code })).filter((l) => l.code.trim());
  const at = codeLines.findIndex((l) => l.i === line);
  const prev = codeLines[at - 1]?.code.trimEnd() ?? "";
  const next = codeLines[at + 1]?.code ?? "";
  const onlyStatement = parsed.language === "python"
    ? prev.endsWith(":") && (!next || leadingWidth(next) < leadingWidth(code))
    : prev.endsWith("{") && /^\s*}/.test(next);
  if (onlyStatement) return { reason: "it is the only statement in its block; removing it leaves an empty block" };
  return { start: line, end: line };
}

/** The `.gitignore` pattern for an AI tool file or folder. */
function ignorePattern(entry) {
  if (entry.endsWith("/")) return `${entry.slice(0, -1).split("/").pop()}/`;
  if (entry.includes(".github/")) return `/${entry}`;
  return entry.split("/").pop();
}

// ---- Plan.

/** Builds the list of proposed actions for `scope` without changing anything. */
export function buildPlan(projectDir, scope) {
  const spec = SCOPES[scope];
  if (!spec) throw new Error(`Unknown scope ${scope}; use ${Object.keys(SCOPES).join(" or ")}`);
  const dir = path.resolve(projectDir);
  const report = runChecks(dir, { rules: spec.rules });
  const isRepo = git(dir, "rev-parse", "--show-toplevel") !== null;
  const parsedCache = new Map();
  const parsedFor = (file) => {
    if (!parsedCache.has(file)) {
      const language = languageOf(file);
      const text = readFileSync(path.join(dir, file), "utf8");
      parsedCache.set(file, ANALYZED[language] ? parseSource(text, language) : { language: "markdown", raw: splitText(text).lines, lines: null });
    }
    return parsedCache.get(file);
  };

  const actions = [];
  const manual = [];
  const hashes = {};
  const touch = (file) => {
    hashes[file] ??= sha1(readFileSync(path.join(dir, file), "utf8"));
  };
  const addLines = (f, range) => {
    const parsed = parsedFor(f.file);
    touch(f.file);
    actions.push({ rule: f.rule, kind: "delete-lines", file: f.file, lines: [range.start + 1, range.end + 1], preview: parsed.raw.slice(range.start, range.end + 1), message: f.message });
  };
  const needsPerson = (f, reason) => manual.push({ rule: f.rule, file: f.file ?? null, line: f.line ?? null, commit: f.commit ?? null, subject: f.subject ?? null, evidence: f.evidence, reason });

  for (const f of report.findings) {
    switch (f.rule) {
      case "ai-tool-file-tracked": {
        const entry = f.evidence;
        const pattern = ignorePattern(entry);
        const tracked = isRepo ? (git(dir, "ls-files", "-z", "--", entry) ?? "").split("\0").filter(Boolean) : [];
        const ignoredAlready = isRepo && git(dir, "check-ignore", "-q", "--no-index", entry.replace(/\/$/, "")) !== null;
        actions.push({ rule: f.rule, kind: "untrack", file: f.file, entry, tracked, pattern: ignoredAlready ? null : pattern, message: f.message });
        break;
      }
      case "ai-mention":
      case "ai-self-talk": {
        const parsed = parsedFor(f.file);
        if (parsed.language === "markdown") {
          addLines(f, { start: f.line - 1, end: f.line - 1 });
          break;
        }
        const range = commentRange(parsed, f.line - 1);
        if (range.reason) needsPerson(f, `Edit by hand: ${range.reason}.`);
        else addLines(f, range);
        break;
      }
      case "ai-commit-trailer":
      case "ai-commit-mention":
        needsPerson(f, "In git history. Changing it means rewriting commits (and force-pushing if they are pushed); leave it unless you ask for that specifically.");
        break;
      case "unreferenced-file":
      case "scratch-file":
        if (isRepo && git(dir, "ls-files", "--error-unmatch", "--", f.file) !== null) {
          touch(f.file);
          actions.push({ rule: f.rule, kind: "delete-file", file: f.file, message: f.message });
        } else needsPerson(f, "Not tracked by git, so deleting it could not be undone; delete it yourself if you are sure.");
        break;
      case "commented-out-code": {
        const parsed = parsedFor(f.file);
        const start = f.line - 1;
        const end = (f.endLine ?? f.line) - 1;
        const allLineComments = parsed.raw.slice(start, end + 1).every((r) => /^\s*(?:\/\/|#)/.test(r));
        if (allLineComments) addLines(f, { start, end });
        else needsPerson(f, "Edit by hand: the code is inside a block comment.");
        break;
      }
      case "debug-logging": {
        const range = debugRange(parsedFor(f.file), f.line - 1);
        if (range.reason) needsPerson(f, `Edit by hand: ${range.reason}.`);
        else addLines(f, range);
        break;
      }
      case "placeholder-todo":
        needsPerson(f, "Do the work or write a specific TODO with an owner or ticket; deleting the marker would hide unfinished code.");
        break;
      case "not-implemented-stub":
        needsPerson(f, "Implement it, or remove it together with its callers.");
        break;
      default:
        break;
    }
  }

  // Deletions and untracking first, then line edits, each in file order.
  const firstKinds = ["untrack", "delete-file"];
  actions.sort((a, b) => (firstKinds.includes(b.kind) - firstKinds.includes(a.kind)) || a.file.localeCompare(b.file) || (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0));
  actions.forEach((a, i) => { a.id = `${spec.prefix}${i + 1}`; });

  return {
    tool: "artisanal-code",
    schema: SCHEMA,
    scope,
    createdAt: new Date().toISOString(),
    project: path.basename(dir),
    base: isRepo ? { branch: git(dir, "branch", "--show-current")?.trim() || null, head: git(dir, "rev-parse", "--short", "HEAD")?.trim() || null } : null,
    actions,
    manual,
    hashes,
  };
}

// ---- Apply.

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

/** Uncommitted changes, ignoring Artisanal's own output folder. */
function dirtyPaths(dir) {
  const out = git(dir, "status", "--porcelain", "--untracked-files=all") ?? "";
  return out.split("\n").filter((l) => l.trim()).map((l) => l.slice(3)).filter((p) => !p.replace(/^"|"$/g, "").startsWith(".artisanal/"));
}

/** Applies the plan's actions named in `ids` (or all of them) and reports what happened. */
export function applyPlan(projectDir, plan, { ids = null, branch = null } = {}) {
  const dir = path.resolve(projectDir);
  if (git(dir, "rev-parse", "--show-toplevel") === null) throw new Error("Not a git repository. Artisanal applies changes only where git can show and undo them.");
  if (git(dir, "rev-parse", "--verify", "HEAD") === null) throw new Error("The repository has no commits yet. Commit your work first so the cleanup can be reviewed and undone.");
  const known = new Set(plan.actions.map((a) => a.id));
  const unknown = (ids ?? []).filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown action id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  const selected = plan.actions.filter((a) => !ids || ids.includes(a.id));

  let current = git(dir, "branch", "--show-current")?.trim() ?? "";
  const dirty = dirtyPaths(dir);
  if (dirty.length && !current.startsWith("artisanal/")) {
    throw new Error(`The working tree has uncommitted changes (${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", ..." : ""}). Commit or stash them first.`);
  }
  let createdBranch = null;
  if (!current.startsWith("artisanal/") || branch) {
    const base = branch ?? `artisanal/${SCOPES[plan.scope].skill}-${today()}`;
    let name = base;
    for (let n = 2; git(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`) !== null; n++) name = `${base}-${n}`;
    if (git(dir, "switch", "-q", "-c", name) === null) throw new Error(`Could not create branch ${name}`);
    createdBranch = name;
    current = name;
  }

  const applied = [];
  const skipped = [];
  const changed = (file) => {
    const full = path.join(dir, file);
    if (!existsSync(full)) return "the file no longer exists";
    if (plan.hashes[file] && sha1(readFileSync(full, "utf8")) !== plan.hashes[file]) return "the file changed since the plan; run the plan again";
    return null;
  };

  const deleted = new Set();
  for (const a of selected.filter((x) => x.kind === "delete-file")) {
    const why = changed(a.file);
    if (why) {
      skipped.push({ id: a.id, reason: why });
      continue;
    }
    if (git(dir, "rm", "-q", "--", a.file) === null) {
      skipped.push({ id: a.id, reason: "git rm failed" });
      continue;
    }
    deleted.add(a.file);
    applied.push(a.id);
  }

  const gitignorePath = path.join(dir, ".gitignore");
  const newPatterns = [];
  for (const a of selected.filter((x) => x.kind === "untrack")) {
    if (a.tracked.length) git(dir, "rm", "-q", "-r", "--cached", "--", ...a.tracked);
    if (a.pattern) newPatterns.push(a.pattern);
    applied.push(a.id);
  }
  if (newPatterns.length) {
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const add = [...new Set(newPatterns)].filter((p) => !have.has(p));
    if (add.length) {
      const sep = existing && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(gitignorePath, `${existing}${sep}${existing ? "\n" : ""}# AI tool files (kept locally, not committed)\n${add.join("\n")}\n`);
    }
  }

  const byFile = new Map();
  for (const a of selected.filter((x) => x.kind === "delete-lines")) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);
  for (const [file, list] of byFile) {
    if (deleted.has(file)) {
      for (const a of list) skipped.push({ id: a.id, reason: "the file was deleted" });
      continue;
    }
    const why = changed(file);
    if (why) {
      for (const a of list) skipped.push({ id: a.id, reason: why });
      continue;
    }
    const full = path.join(dir, file);
    const text = splitText(readFileSync(full, "utf8"));
    for (const a of [...list].sort((x, y) => y.lines[0] - x.lines[0])) {
      const [start, end] = a.lines;
      text.lines.splice(start - 1, end - start + 1);
      // Do not leave two blank lines (or a blank first line) where the removed lines were.
      const before = text.lines[start - 2];
      const after = text.lines[start - 1];
      if (after !== undefined && !after.trim() && (before === undefined || !before.trim())) text.lines.splice(start - 1, 1);
      else if (after === undefined && before !== undefined && !before.trim()) text.lines.splice(start - 2, 1);
      applied.push(a.id);
    }
    writeFileSync(full, joinText(text));
  }

  const order = new Map(plan.actions.map((a, i) => [a.id, i]));
  applied.sort((a, b) => order.get(a) - order.get(b));
  return {
    scope: plan.scope,
    branch: current,
    createdBranch,
    applied,
    skipped,
    diffStat: (git(dir, "diff", "HEAD", "--stat") ?? "").trim(),
  };
}

// ---- Output.

export function formatPlan(plan) {
  const out = [`Artisanal ${SCOPES[plan.scope].skill} plan: ${plan.project}`, ""];
  const describe = (a) => {
    if (a.kind === "untrack") {
      const parts = [];
      if (a.tracked.length) parts.push(`untrack ${a.entry} (${a.tracked.length} file${a.tracked.length === 1 ? "" : "s"}; the local copy stays)`);
      if (a.pattern) parts.push(`add "${a.pattern}" to .gitignore`);
      return parts.join(" and ") || `${a.entry} is already ignored and untracked`;
    }
    if (a.kind === "delete-file") return `delete ${a.file}: ${a.message}`;
    return `${a.file}:${a.lines[0]}${a.lines[1] > a.lines[0] ? `-${a.lines[1]}` : ""}  delete ${a.lines[1] - a.lines[0] + 1} line${a.lines[1] > a.lines[0] ? "s" : ""} (${a.rule})`;
  };
  const section = (title, list) => {
    if (!list.length) return;
    out.push(title);
    for (const a of list) {
      out.push(`  ${a.id.padEnd(4)} ${describe(a)}`);
      for (const p of a.preview ?? []) out.push(`         - ${p}`);
    }
    out.push("");
  };
  section("Files to delete or untrack", plan.actions.filter((a) => a.kind !== "delete-lines"));
  section("Lines to remove", plan.actions.filter((a) => a.kind === "delete-lines"));
  if (plan.manual.length) {
    out.push("Needs a person (Artisanal does not change these)");
    for (const m of plan.manual) {
      const where = m.commit ? `commit ${m.commit} "${m.subject}"` : `${m.file}${m.line ? `:${m.line}` : ""}`;
      out.push(`  -    ${where}  ${m.rule}`);
      out.push(`         ${m.reason}`);
    }
    out.push("");
  }
  if (!plan.actions.length && !plan.manual.length) out.push("  Nothing to clean up.", "");
  out.push(plan.actions.length
    ? `Nothing has changed yet. Apply with: fix.mjs apply --scope ${plan.scope} --ids ${plan.actions.slice(0, 3).map((a) => a.id).join(",")}${plan.actions.length > 3 ? ",..." : ""} (or --all)`
    : "No actions to apply.");
  return out.join("\n");
}

export function formatApply(result) {
  const out = [`Applied ${result.applied.length} action${result.applied.length === 1 ? "" : "s"} on branch ${result.branch}${result.createdBranch ? " (new)" : ""}.`];
  if (result.applied.length) out.push(`  Applied: ${result.applied.join(", ")}`);
  for (const s of result.skipped) out.push(`  Skipped ${s.id}: ${s.reason}`);
  if (result.diffStat) out.push("", result.diffStat);
  out.push("", "Nothing is committed. Review with `git diff HEAD`; undo with `git restore --staged --worktree .` or by switching back to the previous branch.");
  return out.join("\n");
}

const planFile = (dir, scope) => path.join(path.resolve(dir), ".artisanal", `plan-${scope}.json`);

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const usage = "Usage: node fix.mjs plan [projectDir] --scope traces|leftovers [--json]\n       node fix.mjs apply [projectDir] --scope traces|leftovers (--ids T1,T2 | --all) [--branch name] [--json]";
  const [command, ...args] = process.argv.slice(2);
  const opts = { dir: ".", json: false };
  let error = ["plan", "apply"].includes(command) ? null : `unknown command ${command ?? "(none)"}`;
  for (let i = 0; i < args.length && !error; i++) {
    const a = args[i];
    if (a === "--json") opts.json = true;
    else if (a === "--scope") opts.scope = args[++i];
    else if (a === "--ids") opts.ids = (args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--all") opts.all = true;
    else if (a === "--branch") opts.branch = args[++i];
    else if (a.startsWith("--")) error = `unknown option ${a}`;
    else opts.dir = a;
  }
  if (!error && !SCOPES[opts.scope]) error = "--scope must be traces or leftovers";
  if (!error && command === "apply" && !opts.all && !opts.ids?.length) error = "apply needs --ids or --all";
  if (!error && !existsSync(opts.dir)) error = `folder not found: ${opts.dir}`;
  if (!error && !statSync(opts.dir).isDirectory()) error = `not a folder: ${opts.dir}`;
  if (error) {
    console.error(`fix: ${error}\n${usage}`);
    process.exitCode = 2;
  } else {
    try {
      if (command === "plan") {
        const plan = buildPlan(opts.dir, opts.scope);
        writeArtisanalFile(opts.dir, `plan-${opts.scope}.json`, plan);
        console.log(opts.json ? JSON.stringify(plan, null, 2) : formatPlan(plan));
      } else {
        const file = planFile(opts.dir, opts.scope);
        if (!existsSync(file)) throw new Error(`No plan found. Run: fix.mjs plan --scope ${opts.scope}`);
        const plan = JSON.parse(readFileSync(file, "utf8"));
        const result = applyPlan(opts.dir, plan, { ids: opts.all ? null : opts.ids, branch: opts.branch });
        console.log(opts.json ? JSON.stringify(result, null, 2) : formatApply(result));
      }
    } catch (err) {
      console.error(`fix: ${err.message}`);
      process.exitCode = 1;
    }
  }
}
