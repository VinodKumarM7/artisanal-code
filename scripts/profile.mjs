#!/usr/bin/env node
// Builds a style profile of a project from its source files and git history: languages,
// naming, comment density, function length, error handling, logging, indentation, test
// layout and commit message format. The checks compare code against it.
// Read-only except for the profile it writes to <projectDir>/.artisanal/profile.json.
//
// Usage: node profile.mjs [projectDir] [--json] [--no-write] [--max-commits N]

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AI_GENERATED, AI_TRAILER, BULLET, classifySubject, countCommits, proseLines, readCommits, verbForm } from "./lib/commits.mjs";
import {
  ANALYZED, TEST_DIR, bump, caseStyle, isGenerated, isJsLike, isSkippedPath, languageOf, leadingWidth, listFiles,
  median, parseSource, percentile, readText, round, run, share, sum, testPattern,
} from "./lib/source.mjs";

export { caseStyle };
export { classifySubject } from "./lib/commits.mjs";
export { lexC, lexPython } from "./lib/source.mjs";

const SCHEMA = 1;
const MAX_FILES = 5000;
const DEFAULT_MAX_COMMITS = 300;

function newStats() {
  return {
    files: 0, codeLines: 0, commentLines: 0, trailingComments: 0, docLines: 0, functionCount: 0, functionLengths: [],
    names: { functions: {}, classes: {}, variables: {}, constants: {}, files: {} },
    errors: { try: 0, catch: 0, throws: 0, promiseCatch: 0, bareExcept: 0, empty: 0, rethrow: 0, logOnly: 0, handled: 0 },
    logging: {}, indent: { tabs: 0, spaces: 0, steps: {} },
  };
}

/** SCREAMING_SNAKE names are constants; counting them as variables would hide the variable style. */
export const isConstantName = (name) => {
  const style = caseStyle(name);
  return style === "SCREAMING_SNAKE" || (style === "UPPERCASE" && name.length > 1);
};

function countLogging(src, logging) {
  bump(logging, "console", (src.match(/\bconsole\.(?:log|debug|info|warn|error|trace)\s*\(/g) ?? []).length);
  bump(logging, "systemDebug", (src.match(/\bSystem\.debug\s*\(/gi) ?? []).length);
  bump(logging, "systemOut", (src.match(/\bSystem\.(?:out|err)\.print/g) ?? []).length);
  bump(logging, "print", (src.match(/(?<![\w.])print\s*\(/g) ?? []).length);
  bump(logging, "logger", (src.match(/\b(?:log|logger|_logger|LOG|LOGGER|logging)\.(?:debug|info|warn|warning|error|trace|fatal|exception|critical)\s*\(/g) ?? []).length);
}

/** Indentation counts for one file's lexed lines: tab and space lines, and indent steps. */
export function indentStats(lines, into = { tabs: 0, spaces: 0, steps: {} }) {
  let prevIndent = 0;
  for (const l of lines) {
    if (!l.code.trim()) continue;
    const lead = l.code.match(/^[ \t]*/)[0];
    if (lead.startsWith("\t")) into.tabs++;
    else if (lead) into.spaces++;
    const width = leadingWidth(l.code);
    if (!lead.startsWith("\t") && width > prevIndent) bump(into.steps, width - prevIndent);
    prevIndent = width;
  }
  return into;
}

/** Adds one source file's numbers to `acc` (a fresh accumulator if omitted) and returns it. */
export function analyzeSource(text, language, acc = newStats()) {
  const p = parseSource(text, language);
  acc.files++;
  for (const l of p.lines) {
    if (l.code.trim()) {
      acc.codeLines++;
      if (l.comment) acc.trailingComments++;
    } else if (l.doc) acc.docLines++;
    else if (l.comment) acc.commentLines++;
  }
  indentStats(p.lines, acc.indent);

  for (const fn of p.functions) {
    acc.functionCount++;
    if (fn.kind !== "constructor" && fn.name !== "constructor") bump(acc.names.functions, caseStyle(fn.name));
    if (fn.endLine !== null && !fn.expression) acc.functionLengths.push(fn.endLine - fn.line + 1);
  }
  for (const c of p.classes) bump(acc.names.classes, caseStyle(c.name));
  for (const v of p.variables) bump(isConstantName(v.name) ? acc.names.constants : acc.names.variables, caseStyle(v.name));

  acc.errors.try += p.tries;
  acc.errors.throws += p.throws;
  for (const c of p.catches) {
    acc.errors.catch++;
    acc.errors[c.kind]++;
    if (language === "python" && c.bare) acc.errors.bareExcept++;
  }
  if (isJsLike(language)) acc.errors.promiseCatch += (p.src.match(/\.catch\s*\(/g) ?? []).length;
  countLogging(p.src, acc.logging);
  return acc;
}

// ---- Summaries.

function namingSummary(counts) {
  delete counts.null;
  const total = sum(counts);
  if (!total) return null;
  const ranked = Object.entries(counts).filter(([k]) => k !== "lowercase").sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { dominant: "lowercase", share: 1, counts };
  return { dominant: ranked[0][0], share: share(ranked[0][1], total - (counts.lowercase ?? 0)), counts };
}

/** Tabs or spaces, and the most common indent step. */
export function indentSummary({ tabs, spaces, steps }) {
  if (!tabs && !spaces) return null;
  if (tabs > spaces) return { style: "tabs", consistency: share(tabs, tabs + spaces) };
  const common = Object.entries(steps).filter(([k]) => [2, 3, 4, 8].includes(Number(k))).sort((a, b) => b[1] - a[1]);
  return { style: "spaces", size: common.length ? Number(common[0][0]) : null, consistency: share(spaces, tabs + spaces) };
}

function languageSummary(language, s) {
  const commentTotal = s.commentLines + s.docLines;
  const e = s.errors;
  const errorHandling = {
    tryBlocks: e.try, catchBlocks: e.catch, perThousandLines: round((e.try * 1000) / Math.max(1, s.codeLines), 1),
    catchBodies: { empty: e.empty, rethrow: e.rethrow, logOnly: e.logOnly, handled: e.handled }, throws: e.throws,
  };
  if (language === "python") errorHandling.bareExcept = e.bareExcept;
  if (isJsLike(language)) errorHandling.promiseCatch = e.promiseCatch;
  return {
    files: s.files,
    codeLines: s.codeLines,
    comments: {
      commentLines: s.commentLines, docLines: s.docLines, trailingComments: s.trailingComments,
      density: share(commentTotal, commentTotal + s.codeLines),
    },
    functions: {
      count: s.functionCount, measured: s.functionLengths.length, medianLines: median(s.functionLengths),
      p90Lines: percentile(s.functionLengths, 0.9), maxLines: s.functionLengths.length ? Math.max(...s.functionLengths) : 0,
    },
    naming: Object.fromEntries(Object.entries(s.names).map(([k, v]) => [k, namingSummary(v)]).filter(([, v]) => v)),
    errorHandling,
    logging: Object.fromEntries(Object.entries(s.logging).filter(([, n]) => n > 0)),
    indentation: indentSummary(s.indent),
  };
}

// ---- Tests and commits.

function detectFrameworks(dir, files, testTexts) {
  const found = new Set();
  const pkgPath = path.join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [dep, name] of [["jest", "jest"], ["vitest", "vitest"], ["mocha", "mocha"], ["ava", "ava"], ["jasmine", "jasmine"], ["tap", "tap"], ["uvu", "uvu"], ["@playwright/test", "playwright"], ["cypress", "cypress"]]) {
        if (deps[dep]) found.add(name);
      }
      if (/node\s+--test/.test(pkg.scripts?.test ?? "")) found.add("node:test");
    } catch {
      // An unreadable package.json just means no frameworks from it.
    }
  }
  if (files.some((f) => /(^|\/)(conftest\.py|pytest\.ini)$/.test(f))) found.add("pytest");
  for (const text of testTexts) {
    if (/["']node:test["']/.test(text)) found.add("node:test");
    if (/^\s*(import pytest|from pytest\b)|@pytest\./m.test(text)) found.add("pytest");
    if (/^\s*(import unittest|from unittest\b)/m.test(text)) found.add("unittest");
    if (/org\.junit\.jupiter/.test(text)) found.add("junit5");
    else if (/org\.junit\./.test(text)) found.add("junit4");
    if (/org\.testng/.test(text)) found.add("testng");
    if (/@isTest\b/i.test(text)) found.add("apex");
  }
  return [...found].sort();
}

function testsSummary(tests, sourceFiles, frameworks) {
  const inDir = tests.filter((t) => t.dir);
  const dirs = {};
  for (const t of inDir) bump(dirs, t.dir);
  let layout = "none";
  if (tests.length) {
    const separate = inDir.length / tests.length;
    layout = separate >= 0.8 ? "separate" : separate <= 0.2 ? "colocated" : "mixed";
  }
  const patterns = {};
  for (const t of tests) bump(patterns, t.pattern);
  return {
    testFiles: tests.length, sourceFiles, ratio: share(tests.length, sourceFiles), layout,
    directories: Object.entries(dirs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d]) => d),
    patterns, frameworks,
  };
}

function commitsSummary(dir, maxCommits) {
  const commits = readCommits(dir, maxCommits);
  if (!commits.length) return { analyzed: 0 };
  const formats = {};
  const types = {};
  const moods = {};
  const lengths = [];
  let scoped = 0, capitalized = 0, period = 0, emoji = 0, withBody = 0, bulletBodies = 0;
  let coAuthored = 0, aiCoAuthored = 0, aiGenerated = 0, signedOff = 0;
  for (const c of commits) {
    const s = classifySubject(c.subject);
    bump(formats, s.format);
    if (s.type) bump(types, s.type);
    if (s.scoped) scoped++;
    lengths.push(c.subject.length);
    if (/^[A-Z]/.test(s.description)) capitalized++;
    if (/\.$/.test(c.subject)) period++;
    if (/\p{Extended_Pictographic}/u.test(c.subject)) emoji++;
    const form = verbForm(s.description.split(/\s+/)[0] ?? "");
    if (form) bump(moods, form);

    const prose = proseLines(c.body);
    if (prose.length) {
      withBody++;
      if (prose.filter((l) => BULLET.test(l)).length >= 2) bulletBodies++;
    }
    if (/^co-authored-by:/im.test(c.body)) coAuthored++;
    if (AI_TRAILER.test(c.body)) aiCoAuthored++;
    if (AI_GENERATED.test(c.body) || AI_GENERATED.test(c.subject)) aiGenerated++;
    if (/^signed-off-by:/im.test(c.body)) signedOff++;
  }
  const n = commits.length;
  const rankedFormats = Object.entries(formats).sort((a, b) => b[1] - a[1]);
  const rankedMoods = Object.entries(moods).sort((a, b) => b[1] - a[1]);
  return {
    total: countCommits(dir) || n, analyzed: n, authors: new Set(commits.map((c) => c.author)).size,
    format: { dominant: rankedFormats[0][0], share: share(rankedFormats[0][1], n), counts: formats },
    ...(Object.keys(types).length ? { conventionalTypes: types, scopedShare: share(scoped, formats.conventional ?? 0) } : {}),
    subject: {
      medianLength: median(lengths), p90Length: percentile(lengths, 0.9), capitalizedShare: share(capitalized, n),
      endsWithPeriodShare: share(period, n), emojiShare: share(emoji, n),
      mood: rankedMoods.length ? { dominant: rankedMoods[0][0], share: share(rankedMoods[0][1], sum(moods)), counts: moods } : null,
    },
    body: { share: share(withBody, n), bulletShare: share(bulletBodies, withBody) },
    trailers: { coAuthoredBy: coAuthored, aiCoAuthoredBy: aiCoAuthored, signedOffBy: signedOff },
    aiGeneratedMentions: aiGenerated,
    recentSubjects: commits.slice(0, 8).map((c) => c.subject),
  };
}

// ---- Profile.

/** Builds the style profile for `projectDir`. */
export function buildProfile(projectDir = ".", { maxCommits = DEFAULT_MAX_COMMITS } = {}) {
  const dir = path.resolve(projectDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Folder not found: ${projectDir}`);
  const isRepo = run("git", ["rev-parse", "--show-toplevel"], dir) !== null;

  const all = listFiles(dir);
  const listed = all.filter((f) => !isSkippedPath(f));
  const skipped = { examples: all.length - listed.length, large: 0, generated: 0, overLimit: 0 };
  const mix = {};
  const stats = {};
  const tests = [];
  const testTexts = [];
  let sourceFiles = 0;
  let analyzed = 0;

  for (const file of listed) {
    const language = languageOf(file);
    if (!language) continue;
    const text = readText(path.join(dir, file));
    if (text === null) {
      skipped.large++;
      continue;
    }
    if (isGenerated(text)) {
      skipped.generated++;
      continue;
    }
    const entry = (mix[language] ??= { files: 0, lines: 0 });
    entry.files++;
    entry.lines += text.split("\n").filter((l) => l.trim()).length;
    if (!ANALYZED[language]) continue;
    if (analyzed >= MAX_FILES) {
      skipped.overLimit++;
      continue;
    }
    analyzed++;

    const pattern = testPattern(file, language, text);
    if (pattern) {
      tests.push({ file, pattern, dir: file.match(TEST_DIR)?.[1] ?? null });
      testTexts.push(text);
      continue;
    }
    sourceFiles++;
    const acc = (stats[language] ??= newStats());
    analyzeSource(text, language, acc);
    bump(acc.names.files, caseStyle(path.basename(file).split(".")[0]));
  }

  const totalLines = sum(Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, v.lines])));
  const languages = Object.entries(mix)
    .map(([language, v]) => ({ language, files: v.files, lines: v.lines, share: share(v.lines, totalLines), analyzed: Boolean(ANALYZED[language]) }))
    .sort((a, b) => b.lines - a.lines);
  const byLanguage = Object.fromEntries(Object.entries(stats).sort((a, b) => b[1].codeLines - a[1].codeLines).map(([lang, s]) => [lang, languageSummary(lang, s)]));

  return {
    tool: "artisanal-code",
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    project: path.basename(dir),
    git: { isRepo },
    files: { listed: listed.length, analyzed, skipped },
    languages,
    primaryLanguage: Object.keys(byLanguage)[0] ?? languages[0]?.language ?? null,
    byLanguage,
    tests: testsSummary(tests, sourceFiles, detectFrameworks(dir, listed, testTexts)),
    commits: isRepo ? commitsSummary(dir, maxCommits) : { analyzed: 0 },
  };
}

/** Reads `.artisanal/profile.json` if it exists and has this schema, else returns null. */
export function loadProfile(projectDir) {
  const file = path.join(path.resolve(projectDir), ".artisanal", "profile.json");
  try {
    const profile = JSON.parse(readFileSync(file, "utf8"));
    return profile.schema === SCHEMA ? profile : null;
  } catch {
    return null;
  }
}

/** Writes `json` to `<projectDir>/.artisanal/<name>` and returns the file path. */
export function writeArtisanalFile(projectDir, name, json) {
  const outDir = path.join(path.resolve(projectDir), ".artisanal");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, name);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  return file;
}

export const writeProfile = (projectDir, profile) => writeArtisanalFile(projectDir, "profile.json", profile);

const pct = (x) => `${Math.round(x * 100)}%`;

export function formatText(p) {
  const out = [`Artisanal style profile: ${p.project}`, ""];
  const row = (label, text) => out.push(`  ${label.padEnd(12)} ${text}`);
  if (!p.languages.length) row("Languages", "no source files found");
  else row("Languages", p.languages.slice(0, 5).map((l) => `${l.language} ${pct(l.share)} (${l.files} file${l.files === 1 ? "" : "s"})`).join(", "));

  for (const [lang, s] of Object.entries(p.byLanguage)) {
    const naming = Object.entries(s.naming).filter(([, v]) => v.dominant !== "lowercase").map(([k, v]) => `${v.dominant} ${k}`).join(", ");
    const indent = s.indentation ? (s.indentation.style === "tabs" ? "tabs" : `${s.indentation.size ?? "?"} spaces`) : "no indentation data";
    row(lang, [naming || "naming unclear", indent].join("; "));
    const fn = s.functions.measured ? `functions median ${s.functions.medianLines} lines (p90 ${s.functions.p90Lines})` : "no functions found";
    row("", `comments ${pct(s.comments.density)} of lines; ${fn}; try ${s.errorHandling.perThousandLines} per 1000 lines`);
  }

  const t = p.tests;
  row("Tests", t.testFiles ? `${t.layout}, ${t.testFiles} file${t.testFiles === 1 ? "" : "s"} (${Object.keys(t.patterns).join(", ")})${t.frameworks.length ? `, ${t.frameworks.join(", ")}` : ""}` : "none found");

  const c = p.commits;
  if (!c.analyzed) row("Commits", p.git.isRepo ? "no commits yet" : "not a git repository");
  else {
    const mood = c.subject.mood ? `, ${c.subject.mood.dominant}` : "";
    row("Commits", `${c.format.dominant} (${pct(c.format.share)} of ${c.analyzed}), ${c.subject.capitalizedShare >= 0.5 ? "capitalized" : "lowercase"}, ${c.subject.endsWithPeriodShare >= 0.5 ? "ends with a period" : "no period"}${mood}, median ${c.subject.medianLength} chars`);
    row("", `bodies ${pct(c.body.share)} (bulleted ${pct(c.body.bulletShare)}); AI co-author trailers ${c.trailers.aiCoAuthoredBy}; "Generated with" mentions ${c.aiGeneratedMentions}`);
  }
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const usage = "Usage: node profile.mjs [projectDir] [--json] [--no-write] [--max-commits N]";
  const args = process.argv.slice(2);
  const opts = { json: false, write: true, maxCommits: DEFAULT_MAX_COMMITS, dir: "." };
  let error = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") opts.json = true;
    else if (a === "--no-write") opts.write = false;
    else if (a === "--max-commits") {
      opts.maxCommits = Number(args[++i]);
      if (!Number.isInteger(opts.maxCommits) || opts.maxCommits < 1) error = "--max-commits needs a positive number";
    } else if (a.startsWith("--")) error = `unknown option ${a}`;
    else opts.dir = a;
  }
  if (error) {
    console.error(`profile: ${error}\n${usage}`);
    process.exitCode = 2;
  } else {
    try {
      const profile = buildProfile(opts.dir, opts);
      const file = opts.write ? writeProfile(opts.dir, profile) : null;
      if (opts.json) console.log(JSON.stringify(profile, null, 2));
      else console.log(`${formatText(profile)}${file ? `\n\nWritten to ${file}` : ""}`);
    } catch (err) {
      console.error(`profile: ${err.message}`);
      process.exitCode = 1;
    }
  }
}
