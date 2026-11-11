#!/usr/bin/env node
// Plans and applies the mechanical cleanups behind the clean-traces, remove-leftovers,
// simplify-review and humanize-docs skills.
//
// `plan` runs the checks for one scope and lists numbered actions with a preview of each
// change; nothing changes. `apply` performs only the actions named by id, on a new branch
// (artisanal/<skill>-<date>) in a clean working tree, and skips any file that changed since
// the plan. `start` only prepares that branch, for edits the skill makes by hand. Nothing is
// committed and history is never rewritten. Findings that need judgment are listed as
// rewrites (with the code around them) or as items for a person.
//
// Usage: node fix.mjs plan  [projectDir] --scope <scope> [--json]
//        node fix.mjs apply [projectDir] --scope <scope> (--ids X1,X2 | --all) [--branch name] [--json]
//        node fix.mjs start [projectDir] --scope <scope> [--branch name]
// Scopes: traces, leftovers, simplify, docs.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runChecks } from "./check.mjs";
import { ANALYZED, languageOf, leadingWidth, matchPair, parseSource, run } from "./lib/source.mjs";
import { writeArtisanalFile } from "./profile.mjs";

const SCHEMA = 2;
export const SCOPES = {
  traces: {
    prefix: "T", skill: "clean-traces",
    rules: ["ai-tool-file-tracked", "ai-mention", "ai-self-talk", "ai-commit-trailer", "ai-commit-mention"],
  },
  leftovers: {
    prefix: "L", skill: "remove-leftovers",
    rules: ["unreferenced-file", "scratch-file", "commented-out-code", "debug-logging", "placeholder-todo", "not-implemented-stub"],
  },
  simplify: {
    prefix: "S", skill: "simplify-review",
    rules: [
      "catch-rethrow-only", "null-check-on-fresh-value", "catch-log-only", "empty-catch", "catch-all", "single-implementation-interface",
      "single-product-factory", "forwarding-wrapper", "single-use-config", "generic-name", "vague-function-name", "dumping-ground-file",
      "naming-style-mismatch", "file-name-style-mismatch", "indentation-mismatch",
    ],
  },
  docs: {
    prefix: "D", skill: "humanize-docs",
    rules: ["comment-restates-code", "section-banner", "emoji", "doc-longer-than-code", "this-function-comment", "ai-wording"],
  },
};

// Why each rewrite needs judgment, shown next to the code it concerns.
const REWRITE_HINTS = {
  "catch-log-only": "Decide whether to handle the error or let it propagate; check what callers expect before changing it.",
  "empty-catch": "Handle the error, let it propagate, or add a comment saying why it is safe to ignore.",
  "catch-all": "Catch the specific errors this code expects.",
  "single-implementation-interface": "Use the class directly unless a test double or a planned second implementation needs the interface.",
  "single-product-factory": "Call the constructor where the object is needed and remove the factory.",
  "forwarding-wrapper": "Call the inner function directly, or re-export it under the needed name; update the callers.",
  "single-use-config": "Inline the value where it is used.",
  "generic-name": "Rename to what the value holds, everywhere it is used.",
  "vague-function-name": "Rename to what the function does, and update its callers.",
  "dumping-ground-file": "Move each function next to its callers or into a module named for what it does; this touches imports.",
  "naming-style-mismatch": "Rename to the project's style and update every reference.",
  "file-name-style-mismatch": "Rename the file to the project's style (git mv) and update its imports.",
  "indentation-mismatch": "Re-indent with the project's formatter, or by hand outside multi-line strings.",
  "doc-longer-than-code": "Shorten the doc to what a reader needs; keep parameter docs only if the project documents them elsewhere.",
  "this-function-comment": "Delete it if the name already says it, or start with the verb.",
  "ai-wording": "Say the same thing in plain words; keep every fact.",
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

/** Removes `width` columns of leading whitespace (tabs count as four). */
function dedent(raw, width) {
  let removed = 0;
  let i = 0;
  while (i < raw.length && removed < width && (raw[i] === " " || raw[i] === "\t")) {
    removed += raw[i] === "\t" ? 4 : 1;
    i++;
  }
  return raw.slice(i);
}

// ---- Deciding whether a change is safe to make mechanically.

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
  const opener = (parsed.raw[line - 1] ?? "").trim();
  const closer = (parsed.raw[line + 1] ?? "").trim();
  // A doc block left with nothing in it goes too.
  if (/^\/\*\*?$/.test(opener) && closer === "*/") return { start: line - 1, end: line + 1 };
  return { start: line, end: line };
}

const LOG_START = /^(?:console\.\w+\s*\(|print\s*\(|System\.debug\s*\(|System\.(?:out|err)\.print\w*\s*\(|\w+\.printStackTrace\s*\(|debugger\b|breakpoint\s*\(|pdb\.set_trace\s*\(|import\s+pdb\b)/i;

const codeLinesOf = (parsed) => parsed.lines.map((l, i) => ({ i, code: l.code })).filter((l) => l.code.trim());

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
  const codeLines = codeLinesOf(parsed);
  const at = codeLines.findIndex((l) => l.i === line);
  const prev = codeLines[at - 1]?.code.trimEnd() ?? "";
  const next = codeLines[at + 1]?.code ?? "";
  const onlyStatement = parsed.language === "python"
    ? prev.endsWith(":") && (!next || leadingWidth(next) < leadingWidth(code))
    : prev.endsWith("{") && /^\s*}/.test(next);
  if (onlyStatement) return { reason: "it is the only statement in its block; removing it leaves an empty block" };
  return { start: line, end: line };
}

/** Replaces `try { body } catch (e) { throw e; }` with the body, or says why it cannot. */
function unwrapTry(parsed, line) {
  const { lines, raw, src, starts, lineOf } = parsed;
  const c = parsed.catches.find((x) => x.line === line);
  if (!c) return { reason: "the catch block was not found" };
  let tryLine;
  if (parsed.language === "python") {
    const indent = leadingWidth(lines[line].code);
    const before = codeLinesOf(parsed).filter((l) => l.i < line && leadingWidth(l.code) <= indent).pop();
    if (!before || leadingWidth(before.code) !== indent || before.code.trim() !== "try:") return { reason: "the try has other except clauses or is not on a line of its own" };
    tryLine = before.i;
    const after = codeLinesOf(parsed).find((l) => l.i > c.endLine && leadingWidth(l.code) <= indent);
    if (after && leadingWidth(after.code) === indent && /^(?:else|finally|except)\b/.test(after.code.trim())) return { reason: "the try has an else, finally or another except clause" };
  } else {
    const at = src.indexOf("catch", starts[line]);
    let close = at - 1;
    while (close >= 0 && /\s/.test(src[close])) close--;
    if (src[close] !== "}" || !/^\}\s*catch\b/.test(lines[line].code.trim())) return { reason: "the catch does not follow the try block's closing brace" };
    let depth = 0;
    let open = -1;
    for (let i = close; i >= 0; i--) {
      if (src[i] === "}") depth++;
      else if (src[i] === "{" && --depth === 0) {
        open = i;
        break;
      }
    }
    if (open < 0) return { reason: "the try block was not found" };
    tryLine = lineOf(open);
    if (lines[tryLine].code.trim() !== "try {") return { reason: "the try is not on a line of its own" };
    if (/^\}\s*finally\b/.test(lines[c.endLine].code.trim())) return { reason: "the try has a finally block" };
    if (lines[c.endLine].code.trim() !== "}") return { reason: "the catch block is followed by more code on its last line" };
    const next = codeLinesOf(parsed).find((l) => l.i > c.endLine);
    if (next && /^\s*finally\b/.test(next.code)) return { reason: "the try has a finally block" };
  }
  const body = [];
  for (let i = tryLine + 1; i < line; i++) body.push(i);
  if (body.some((i) => lines[i].continued)) return { reason: "the try body contains a multi-line string" };
  const bodyCode = body.filter((i) => lines[i].code.trim());
  if (!bodyCode.length) return { reason: "the try body is empty" };
  const shift = Math.min(...bodyCode.map((i) => leadingWidth(raw[i]))) - leadingWidth(raw[tryLine]);
  if (shift <= 0) return { reason: "the try body is not indented" };
  return { start: tryLine, end: c.endLine, replacement: body.map((i) => (raw[i].trim() ? dedent(raw[i], shift) : "")) };
}

const NULL_TEST = /^\s*(?:!\s*[\w$]+|[\w$.]+\s*===?\s*(?:null|undefined)|(?:null|undefined)\s*===?\s*[\w$.]+|typeof\s+[\w$]+\s*===?\s*["']undefined["'])\s*$/;

/** The lines of an `if (x == null)` block that can never run, or why it cannot be removed. */
function nullCheckRange(parsed, line) {
  const { lines, raw, src, starts, lineOf } = parsed;
  const code = lines[line].code;
  if (parsed.language === "python") {
    const m = code.match(/^(\s*)if\s+[\w.]+\s+is\s+None\s*:(.*)$/);
    if (!m) return { reason: "the check is part of a larger condition" };
    const indent = leadingWidth(m[1]);
    let end = line;
    if (!m[2].trim()) {
      for (let j = line + 1; j < lines.length; j++) {
        if (!lines[j].code.trim()) continue;
        if (leadingWidth(lines[j].code) <= indent) break;
        end = j;
      }
    }
    const next = codeLinesOf(parsed).find((l) => l.i > end);
    if (next && leadingWidth(next.code) === indent && /^(?:elif|else)\b/.test(next.code.trim())) return { reason: "the if has an elif or else branch" };
    return { start: line, end };
  }
  const ifAt = code.search(/\bif\s*\(/);
  if (ifAt < 0 || code.slice(0, ifAt).trim()) return { reason: "the check is not an if statement of its own" };
  const paren = starts[line] + code.indexOf("(", ifAt);
  const close = matchPair(src, paren);
  if (close < 0 || lineOf(close) !== line) return { reason: "the condition spans several lines" };
  const condition = (raw[line] ?? "").slice(paren - starts[line] + 1, close - starts[line]);
  if (!NULL_TEST.test(condition)) return { reason: "the condition does more than test for null" };
  const rest = src.slice(close + 1, starts[line + 1] ?? src.length).trim();
  let end = line;
  if (rest.startsWith("{")) {
    const blockClose = matchPair(src, close + 1 + src.slice(close + 1).indexOf("{"));
    if (blockClose < 0) return { reason: "the block was not found" };
    end = lineOf(blockClose);
    if (lines[end].code.trim() !== "}") return { reason: "more code follows the block on its last line" };
  } else if (!rest.endsWith(";")) return { reason: "the statement continues on the next line" };
  const next = codeLinesOf(parsed).find((l) => l.i > end);
  if (next && /^\s*else\b/.test(next.code)) return { reason: "the if has an else branch" };
  return { start: line, end };
}

const EMOJI_RUN = /(?![©®™↔-↙↩↪])\p{Extended_Pictographic}[️‍\u{1F3FB}-\u{1F3FF}\p{Extended_Pictographic}]*[ \t]?/gu;
const stripEmoji = (line) => line.replace(EMOJI_RUN, "").replace(/(\S)[ \t]+$/, "$1");

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
  if (!spec) throw new Error(`Unknown scope ${scope}; use ${Object.keys(SCOPES).join(", ")}`);
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
  /** Adds a line action; each range is {start, end, replacement?} with 0-based lines. */
  const addEdit = (f, ranges) => {
    const parsed = parsedFor(f.file);
    touch(f.file);
    const out = ranges.map((r) => ({ lines: [r.start + 1, r.end + 1], old: parsed.raw.slice(r.start, r.end + 1), new: r.replacement ?? [] }));
    const kind = out.every((r) => !r.new.length) ? "delete-lines" : "edit-lines";
    actions.push({ rule: f.rule, kind, file: f.file, lines: [out[0].lines[0], out[out.length - 1].lines[1]], ranges: out, message: f.message });
  };
  const contextFor = (f) => {
    if (!f.file || !f.line) return null;
    const parsed = parsedFor(f.file);
    const line = f.line - 1;
    const owner = parsed.functions?.filter((fn) => fn.line <= line && (fn.endLine ?? -1) >= line).sort((a, b) => b.line - a.line)[0];
    const start = owner && owner.endLine - owner.line < 40 ? owner.line : Math.max(0, line - 4);
    const end = owner && owner.endLine - owner.line < 40 ? owner.endLine : Math.min(parsed.raw.length - 1, line + 4);
    return { start: start + 1, lines: parsed.raw.slice(start, end + 1) };
  };
  const needsPerson = (f, reason) => manual.push({ handling: "person", rule: f.rule, file: f.file ?? null, line: f.line ?? null, commit: f.commit ?? null, subject: f.subject ?? null, evidence: f.evidence, reason });
  const needsRewrite = (f, reason = REWRITE_HINTS[f.rule]) => manual.push({ handling: "rewrite", rule: f.rule, file: f.file ?? null, line: f.line ?? null, evidence: f.evidence, message: f.message, reason, context: contextFor(f) });
  const tryRange = (f, range, fallback = needsPerson) => {
    if (range.reason) fallback(f, `Edit by hand: ${range.reason}.`);
    else addEdit(f, [range]);
  };

  for (const f of report.findings) {
    if (f.commit) {
      needsPerson(f, "In git history. Changing it means rewriting commits (and force-pushing if they are pushed); leave it unless you ask for that specifically.");
      continue;
    }
    switch (f.rule) {
      case "ai-tool-file-tracked": {
        const entry = f.evidence;
        const tracked = isRepo ? (git(dir, "ls-files", "-z", "--", entry) ?? "").split("\0").filter(Boolean) : [];
        const ignoredAlready = isRepo && git(dir, "check-ignore", "-q", "--no-index", entry.replace(/\/$/, "")) !== null;
        actions.push({ rule: f.rule, kind: "untrack", file: f.file, entry, tracked, pattern: ignoredAlready ? null : ignorePattern(entry), message: f.message });
        break;
      }
      case "ai-mention":
      case "ai-self-talk":
      case "comment-restates-code":
      case "section-banner": {
        const parsed = parsedFor(f.file);
        if (parsed.language === "markdown") addEdit(f, [{ start: f.line - 1, end: f.line - 1 }]);
        else tryRange(f, commentRange(parsed, f.line - 1));
        break;
      }
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
        if (parsed.raw.slice(start, end + 1).every((r) => /^\s*(?:\/\/|#)/.test(r))) addEdit(f, [{ start, end }]);
        else needsPerson(f, "Edit by hand: the code is inside a block comment.");
        break;
      }
      case "debug-logging":
        tryRange(f, debugRange(parsedFor(f.file), f.line - 1));
        break;
      case "placeholder-todo":
        needsPerson(f, "Do the work or write a specific TODO with an owner or ticket; deleting the marker would hide unfinished code.");
        break;
      case "not-implemented-stub":
        needsPerson(f, "Implement it, or remove it together with its callers.");
        break;
      case "catch-rethrow-only":
        tryRange(f, unwrapTry(parsedFor(f.file), f.line - 1), needsRewrite);
        break;
      case "null-check-on-fresh-value":
        tryRange(f, nullCheckRange(parsedFor(f.file), f.line - 1), needsRewrite);
        break;
      case "emoji": {
        const parsed = parsedFor(f.file);
        const ranges = [];
        let fence = false;
        parsed.raw.forEach((line, i) => {
          if (parsed.language === "markdown" && /^\s*(?:```|~~~)/.test(line)) fence = !fence;
          if (fence || (parsed.language !== "markdown" && i !== f.line - 1)) return;
          const cleaned = stripEmoji(line);
          if (cleaned !== line) ranges.push(cleaned.trim() && !/^\s*[#>*-]+\s*$/.test(cleaned) ? { start: i, end: i, replacement: [cleaned] } : { start: i, end: i });
        });
        if (ranges.length) addEdit(f, ranges);
        break;
      }
      default:
        needsRewrite(f);
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

// ---- Branch and apply.

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

/** Uncommitted changes, ignoring Artisanal's own output folder. */
function dirtyPaths(dir) {
  const out = git(dir, "status", "--porcelain", "--untracked-files=all") ?? "";
  return out.split("\n").filter((l) => l.trim()).map((l) => l.slice(3)).filter((p) => !p.replace(/^"|"$/g, "").startsWith(".artisanal/"));
}

/**
 * Checks that `dir` is a git repository with a clean working tree, then switches to a new
 * `artisanal/<skill>-<date>` branch. Already on an artisanal branch, it stays there.
 */
export function prepareBranch(projectDir, scope, { branch = null } = {}) {
  const dir = path.resolve(projectDir);
  if (!SCOPES[scope]) throw new Error(`Unknown scope ${scope}`);
  if (git(dir, "rev-parse", "--show-toplevel") === null) throw new Error("Not a git repository. Artisanal applies changes only where git can show and undo them.");
  if (git(dir, "rev-parse", "--verify", "HEAD") === null) throw new Error("The repository has no commits yet. Commit your work first so the cleanup can be reviewed and undone.");
  const current = git(dir, "branch", "--show-current")?.trim() ?? "";
  const dirty = dirtyPaths(dir);
  if (dirty.length && !current.startsWith("artisanal/")) {
    throw new Error(`The working tree has uncommitted changes (${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", ..." : ""}). Commit or stash them first.`);
  }
  if (current.startsWith("artisanal/") && !branch) return { branch: current, created: false };
  const base = branch ?? `artisanal/${SCOPES[scope].skill}-${today()}`;
  let name = base;
  for (let n = 2; git(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`) !== null; n++) name = `${base}-${n}`;
  if (git(dir, "switch", "-q", "-c", name) === null) throw new Error(`Could not create branch ${name}`);
  return { branch: name, created: true };
}

/** Applies the plan's actions named in `ids` (or all of them) and reports what happened. */
export function applyPlan(projectDir, plan, { ids = null, branch = null } = {}) {
  const dir = path.resolve(projectDir);
  if (plan.schema !== SCHEMA) throw new Error("The plan was made by another version of Artisanal; run the plan again.");
  const known = new Set(plan.actions.map((a) => a.id));
  const unknown = (ids ?? []).filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown action id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  const selected = plan.actions.filter((a) => !ids || ids.includes(a.id));
  const ready = prepareBranch(dir, plan.scope, { branch });

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
    if (why) skipped.push({ id: a.id, reason: why });
    else if (git(dir, "rm", "-q", "--", a.file) === null) skipped.push({ id: a.id, reason: "git rm failed" });
    else {
      deleted.add(a.file);
      applied.push(a.id);
    }
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
  for (const a of selected.filter((x) => x.ranges)) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);
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
    // Two actions on overlapping lines cannot both apply; the first one wins.
    const taken = [];
    const accepted = [];
    for (const a of list) {
      const overlaps = a.ranges.some((r) => taken.some(([s, e]) => r.lines[0] <= e && r.lines[1] >= s));
      if (overlaps) skipped.push({ id: a.id, reason: "it overlaps another approved change; run the plan again afterwards" });
      else {
        a.ranges.forEach((r) => taken.push(r.lines));
        accepted.push(a);
      }
    }
    const full = path.join(dir, file);
    const text = splitText(readFileSync(full, "utf8"));
    const ranges = accepted.flatMap((a) => a.ranges).sort((x, y) => y.lines[0] - x.lines[0]);
    for (const r of ranges) {
      const [start, end] = r.lines;
      text.lines.splice(start - 1, end - start + 1, ...r.new);
      if (r.new.length) continue;
      // Do not leave two blank lines (or a blank first line) where the removed lines were.
      const before = text.lines[start - 2];
      const after = text.lines[start - 1];
      if (after !== undefined && !after.trim() && (before === undefined || !before.trim())) text.lines.splice(start - 1, 1);
      else if (after === undefined && before !== undefined && !before.trim()) text.lines.splice(start - 2, 1);
    }
    writeFileSync(full, joinText(text));
    applied.push(...accepted.map((a) => a.id));
  }

  const order = new Map(plan.actions.map((a, i) => [a.id, i]));
  applied.sort((a, b) => order.get(a) - order.get(b));
  return {
    scope: plan.scope,
    branch: ready.branch,
    createdBranch: ready.created ? ready.branch : null,
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
    const span = `${a.file}:${a.lines[0]}${a.lines[1] > a.lines[0] ? `-${a.lines[1]}` : ""}`;
    if (a.kind === "edit-lines") return `${span}  edit (${a.rule})`;
    const count = a.ranges.reduce((n, r) => n + r.lines[1] - r.lines[0] + 1, 0);
    return `${span}  delete ${count} line${count === 1 ? "" : "s"} (${a.rule})`;
  };
  const section = (title, list) => {
    if (!list.length) return;
    out.push(title);
    for (const a of list) {
      out.push(`  ${a.id.padEnd(4)} ${describe(a)}`);
      for (const r of a.ranges ?? []) {
        for (const l of r.old) out.push(`         - ${l}`);
        for (const l of r.new) out.push(`         + ${l}`);
      }
    }
    out.push("");
  };
  section("Files to delete or untrack", plan.actions.filter((a) => !a.ranges));
  section("Line changes", plan.actions.filter((a) => a.ranges));
  const where = (m) => (m.commit ? `commit ${m.commit} "${m.subject}"` : `${m.file}${m.line ? `:${m.line}` : ""}`);
  const rewrites = plan.manual.filter((m) => m.handling === "rewrite");
  if (rewrites.length) {
    out.push("Needs a rewrite (the skill proposes each edit for approval)");
    for (const m of rewrites) out.push(`  -    ${where(m)}  ${m.rule}: ${m.message}`, `         ${m.reason}`);
    out.push("");
  }
  const people = plan.manual.filter((m) => m.handling === "person");
  if (people.length) {
    out.push("Needs a person (Artisanal does not change these)");
    for (const m of people) out.push(`  -    ${where(m)}  ${m.rule}`, `         ${m.reason}`);
    out.push("");
  }
  if (!plan.actions.length && !plan.manual.length) out.push("  Nothing to clean up.", "");
  out.push(plan.actions.length
    ? `Nothing has changed yet. Apply with: fix.mjs apply --scope ${plan.scope} --ids ${plan.actions.slice(0, 3).map((a) => a.id).join(",")}${plan.actions.length > 3 ? ",..." : ""} (or --all)`
    : "No mechanical actions to apply.");
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
  const usage = [
    "Usage: node fix.mjs plan  [projectDir] --scope <scope> [--json]",
    "       node fix.mjs apply [projectDir] --scope <scope> (--ids X1,X2 | --all) [--branch name] [--json]",
    "       node fix.mjs start [projectDir] --scope <scope> [--branch name]",
    `Scopes: ${Object.keys(SCOPES).join(", ")}`,
  ].join("\n");
  const [command, ...args] = process.argv.slice(2);
  const opts = { dir: ".", json: false };
  let error = ["plan", "apply", "start"].includes(command) ? null : `unknown command ${command ?? "(none)"}`;
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
  if (!error && !SCOPES[opts.scope]) error = `--scope must be one of ${Object.keys(SCOPES).join(", ")}`;
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
      } else if (command === "start") {
        const ready = prepareBranch(opts.dir, opts.scope, { branch: opts.branch });
        console.log(ready.created ? `Switched to new branch ${ready.branch}.` : `Already on ${ready.branch}; continuing there.`);
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
