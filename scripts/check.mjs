#!/usr/bin/env node
// Runs Artisanal's deterministic checks on a project and reports each finding with its file,
// line and the source line as evidence. Rules and their severities are in references/rules.json;
// naming, indentation and commit format are compared with the project's style profile.
// Read-only except for <projectDir>/.artisanal/findings.json.
//
// A line can opt out with an `artisanal-ignore` comment on it or on the line above, optionally
// followed by rule ids; `artisanal-ignore-file` in the first ten lines skips the whole file.
//
// Usage: node check.mjs [projectDir] [--json] [--no-write] [--files a,b] [--rules id,...]
//                       [--no-commits] [--max-commits N]

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkSource } from "./checks/code.mjs";
import { checkCommits } from "./checks/commits.mjs";
import { checkMarkdown, isMarkdown } from "./checks/docs.mjs";
import { aiToolEntry, checkAiToolFiles, checkInterfaces, checkReferences } from "./checks/project.mjs";
import { readCommits } from "./lib/commits.mjs";
import { ANALYZED, isGenerated, isJsLike, isSkippedPath, languageOf, listFiles, parseSource, readText, run, testPattern } from "./lib/source.mjs";
import { buildProfile, loadProfile, writeArtisanalFile } from "./profile.mjs";

const SCHEMA = 1;
const DEFAULT_MAX_COMMITS = 200;
const SEVERITIES = ["high", "medium", "low"];

const catalog = JSON.parse(readFileSync(new URL("../references/rules.json", import.meta.url), "utf8"));
export const RULES = new Map(catalog.rules.map((r) => [r.id, r]));
export const GROUPS = catalog.groups;

const TEXT_EXTS = new Set([".md", ".mdx", ".markdown", ".json", ".yml", ".yaml", ".toml", ".cfg", ".ini", ".xml", ".txt", ".html", ".htm", ".sh", ".bash", ".ps1", ".bat", ".cmd", ".properties", ".gradle", ".page", ".cmp", ".component", ".vue", ".svelte", ".rst"]);
const TEXT_NAMES = /^(?:Makefile|Dockerfile|Procfile|Jenkinsfile|Justfile|Taskfile|Rakefile|Gemfile|Pipfile|Containerfile)$/i;
const CLI_DIR = /(^|\/)(?:bin|scripts|cli|tools)\//;

function isCli(file, text, language, binFiles) {
  if (/^#!/.test(text) || CLI_DIR.test(file)) return true;
  if (isJsLike(language)) return /\bprocess\.argv\b/.test(text) || binFiles.has(file);
  if (language === "python") return /__name__\s*==\s*["']__main__["']|\b(?:argparse|sys\.argv|click|typer)\b/.test(text) || /(^|\/)(?:__main__|manage|setup)\.py$/.test(file);
  if (language === "java") return /\bstatic\s+void\s+main\s*\(/.test(text);
  return false;
}

/** True when an `artisanal-ignore` comment on the line or the one above covers `rule`. */
function ignored(rawLines, line, rule) {
  for (const l of [rawLines[line], rawLines[line - 1]]) {
    const m = l?.match(/artisanal-ignore(?!-file)\b(.*)$/);
    if (m) {
      const ids = m[1].match(/[a-z][a-z0-9-]+/g)?.filter((id) => RULES.has(id)) ?? [];
      if (!ids.length || ids.includes(rule)) return true;
    }
  }
  return false;
}

const clip = (s) => (s.length > 160 ? `${s.slice(0, 157)}...` : s);

/** Runs every check on `projectDir` and returns the findings with a summary. */
export function runChecks(projectDir = ".", opts = {}) {
  const dir = path.resolve(projectDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Folder not found: ${projectDir}`);
  const maxCommits = opts.maxCommits ?? DEFAULT_MAX_COMMITS;
  const isRepo = run("git", ["rev-parse", "--show-toplevel"], dir) !== null;
  const listed = listFiles(dir).filter((f) => !isSkippedPath(f));
  const tracked = isRepo ? new Set(listFiles(dir, { trackedOnly: true })) : null;

  let profile = opts.profile ?? null;
  let profileSource = "given";
  if (!profile) {
    profile = loadProfile(dir);
    profileSource = profile ? ".artisanal/profile.json" : "built for this run";
    profile ??= buildProfile(dir, { maxCommits });
  }

  let packageJson = null;
  try {
    packageJson = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    // No package.json, or not valid JSON: nothing to learn from it.
  }
  const binFiles = new Set(Object.values(typeof packageJson?.bin === "string" ? { bin: packageJson.bin } : packageJson?.bin ?? {}).map((v) => String(v).replace(/^\.\//, "")));

  const texts = new Map();
  const sources = [];
  const ignoredFiles = new Set();
  for (const file of listed) {
    const language = languageOf(file);
    const ext = path.extname(file).toLowerCase();
    if (!language && !TEXT_EXTS.has(ext) && !TEXT_NAMES.test(path.basename(file))) continue;
    const text = readText(path.join(dir, file));
    if (text === null) continue;
    texts.set(file, text);
    if (/artisanal-ignore-file/.test(text.split("\n", 10).join("\n"))) ignoredFiles.add(file);
    if (ANALYZED[language] && !isGenerated(text)) {
      sources.push({ file, language, text, parsed: parseSource(text, language), isTest: Boolean(testPattern(file, language, text)) });
    }
  }

  const findings = [];
  const push = (rule, base) => {
    const meta = RULES.get(rule);
    if (!meta) throw new Error(`Unknown rule ${rule}`);
    findings.push({ rule, group: meta.group, severity: meta.severity, autoFixable: meta.autoFixable, message: meta.title, ...base, instead: meta.instead });
  };
  const fileAdder = (file, rawLines) => (rule, line, details = {}) => {
    if (ignoredFiles.has(file) || (line !== null && ignored(rawLines, line, rule))) return;
    const evidence = details.evidence ?? (line !== null ? clip((rawLines[line] ?? "").trim()) : file);
    push(rule, {
      file, line: line === null ? null : line + 1, ...(details.endLine !== undefined ? { endLine: details.endLine + 1 } : {}),
      evidence, ...(details.message ? { message: details.message } : {}),
    });
  };

  for (const s of sources) {
    const add = fileAdder(s.file, s.parsed.raw);
    checkSource({ ...s, langProfile: profile.byLanguage?.[s.language], isCli: isCli(s.file, s.text, s.language, binFiles), add });
  }
  for (const [file, text] of texts) {
    if (isMarkdown(file) && !aiToolEntry(file)) checkMarkdown({ add: fileAdder(file, text.split(/\r?\n/)) }, text);
  }

  const projectCtx = {
    dir, listed, tracked, texts, sources, profile, packageJson,
    add: (rule, file, line, details) => fileAdder(file, texts.get(file)?.split(/\r?\n/) ?? [])(rule, line, details),
  };
  checkAiToolFiles(projectCtx);
  checkReferences(projectCtx);
  checkInterfaces(projectCtx);

  let commitCount = 0;
  if (isRepo && opts.commits !== false && !opts.files) {
    const commits = readCommits(dir, maxCommits, { numstat: true });
    commitCount = commits.length;
    checkCommits({
      profile,
      addCommit: (rule, c, details = {}) => push(rule, { commit: c.hash, subject: c.subject, evidence: details.evidence ?? c.subject, ...(details.message ? { message: details.message } : {}) }),
    }, commits);
  }

  let result = findings;
  if (opts.files) {
    const wanted = new Set(opts.files.map((f) => path.relative(dir, path.resolve(dir, f)).split(path.sep).join("/")));
    result = result.filter((f) => f.file && wanted.has(f.file));
  }
  if (opts.rules) result = result.filter((f) => opts.rules.includes(f.rule));
  const order = Object.keys(GROUPS);
  result.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || (a.file ?? "~").localeCompare(b.file ?? "~") || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, result.filter((f) => f.severity === s).length]));
  const byGroup = Object.fromEntries(order.map((g) => [g, result.filter((f) => f.group === g).length]).filter(([, n]) => n));
  return {
    tool: "artisanal-code",
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    project: path.basename(dir),
    profileSource,
    scanned: { files: listed.length, sources: sources.length, commits: commitCount },
    summary: {
      findings: result.length, bySeverity, byGroup,
      files: new Set(result.filter((f) => f.file).map((f) => f.file)).size,
      commits: new Set(result.filter((f) => f.commit).map((f) => f.commit)).size,
    },
    findings: result,
  };
}

export function formatText(report) {
  const out = [`Artisanal check: ${report.project} (profile: ${report.profileSource})`, ""];
  if (!report.findings.length) out.push("  No findings.");
  for (const [group, label] of Object.entries(GROUPS)) {
    const list = report.findings.filter((f) => f.group === group);
    if (!list.length) continue;
    out.push(`${label} (${list.length})`);
    for (const f of list) {
      const where = f.commit ? `commit ${f.commit}` : f.line ? `${f.file}:${f.line}` : f.file;
      out.push(`  ${f.severity.padEnd(7)} ${where}  ${f.rule}: ${f.message}`);
      if (f.evidence && f.evidence !== f.file && f.evidence !== f.subject) out.push(`          ${f.evidence}`);
      else if (f.commit) out.push(`          ${f.subject}`);
    }
    out.push("");
  }
  const s = report.summary;
  const sev = SEVERITIES.map((k) => `${k} ${s.bySeverity[k]}`).join(", ");
  out.push(`Summary: ${s.findings} finding${s.findings === 1 ? "" : "s"} (${sev}) in ${s.files} file${s.files === 1 ? "" : "s"}${s.commits ? ` and ${s.commits} commit${s.commits === 1 ? "" : "s"}` : ""}.`);
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const usage = "Usage: node check.mjs [projectDir] [--json] [--no-write] [--files a,b] [--rules id,...] [--no-commits] [--max-commits N]";
  const args = process.argv.slice(2);
  const opts = { json: false, write: true, dir: "." };
  let error = null;
  const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") opts.json = true;
    else if (a === "--no-write") opts.write = false;
    else if (a === "--no-commits") opts.commits = false;
    else if (a === "--files") opts.files = list(args[++i]);
    else if (a === "--rules") {
      opts.rules = list(args[++i]);
      const unknown = opts.rules.find((r) => !RULES.has(r));
      if (unknown) error = `unknown rule ${unknown}`;
    } else if (a === "--max-commits") {
      opts.maxCommits = Number(args[++i]);
      if (!Number.isInteger(opts.maxCommits) || opts.maxCommits < 1) error = "--max-commits needs a positive number";
    } else if (a.startsWith("--")) error = `unknown option ${a}`;
    else opts.dir = a;
  }
  if ((opts.files && !opts.files.length) || (opts.rules && !opts.rules.length)) error ??= "--files and --rules need a comma-separated list";
  if (error) {
    console.error(`check: ${error}\n${usage}`);
    process.exitCode = 2;
  } else {
    try {
      const report = runChecks(opts.dir, opts);
      const file = opts.write ? writeArtisanalFile(opts.dir, "findings.json", report) : null;
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else console.log(`${formatText(report)}${file ? `\nWritten to ${file}` : ""}`);
    } catch (err) {
      console.error(`check: ${err.message}`);
      process.exitCode = 1;
    }
  }
}
