#!/usr/bin/env node
// Writes a Markdown and an HTML report of the checks with a cleanliness score, for /tidy-check.
//
// Score: each finding costs points by severity (high 4, medium 2, low 0.5). One rule costs at
// most 12 points, so a single noisy rule cannot sink the score. The total is divided by a size
// allowance, sqrt(thousands of code lines) but at least 1, and the score is 100 minus that,
// never below 0. Grades: A 90+, B 75+, C 60+, D 40+, F below.
//
// Usage: node report.mjs [projectDir] [--from findings.json] [--out dir] [--json]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GROUPS, RULES, runChecks } from "./check.mjs";
import { ANALYZED, isGenerated, isSkippedPath, languageOf, listFiles, readText } from "./lib/source.mjs";

export const WEIGHTS = { high: 4, medium: 2, low: 0.5 };
export const RULE_CAP = 12;
const GRADES = [[90, "A"], [75, "B"], [60, "C"], [40, "D"], [0, "F"]];

/** Non-blank lines in the project's analyzed source files. */
export function codeLines(projectDir) {
  const dir = path.resolve(projectDir);
  let lines = 0;
  for (const file of listFiles(dir)) {
    if (isSkippedPath(file) || !ANALYZED[languageOf(file)]) continue;
    const text = readText(path.join(dir, file));
    if (text && !isGenerated(text)) lines += text.split("\n").filter((l) => l.trim()).length;
  }
  return lines;
}

/** The cleanliness score for a list of findings in a project of `lines` code lines. */
export function score(findings, lines) {
  const byRule = new Map();
  for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + WEIGHTS[f.severity]);
  const points = [...byRule.values()].reduce((sum, p) => sum + Math.min(RULE_CAP, p), 0);
  const allowance = Math.max(1, Math.sqrt(lines / 1000));
  const value = Math.max(0, Math.round(100 - points / allowance));
  const grade = GRADES.find(([min]) => value >= min)[1];
  const costs = [...byRule.entries()].map(([rule, p]) => ({ rule, points: Math.min(RULE_CAP, p) })).sort((a, b) => b.points - a.points);
  return { value, grade, points: Math.round(points * 10) / 10, allowance: Math.round(allowance * 100) / 100, codeLines: lines, costs };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const localDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const where = (f) => (f.commit ? `commit ${f.commit}` : f.line ? `${f.file}:${f.line}` : f.file);
const SEVERITIES = ["high", "medium", "low"];

export function toMarkdown(report, s) {
  const md = [`# Artisanal report: ${report.project}`, ""];
  md.push(`**Cleanliness score: ${s.value}/100 (${s.grade})** from ${report.summary.findings} finding${report.summary.findings === 1 ? "" : "s"} in ${s.codeLines} lines of code.`, "");
  md.push(`Generated ${localDate(report.generatedAt)}. Scanned ${plural(report.scanned.files, "file")} and ${plural(report.scanned.commits, "commit")}.`, "");
  if (!report.findings.length) {
    md.push("No findings.", "");
    return md.join("\n");
  }
  md.push("## Summary", "", "| Area | High | Medium | Low |", "|---|---|---|---|");
  for (const [group, label] of Object.entries(GROUPS)) {
    const list = report.findings.filter((f) => f.group === group);
    if (list.length) md.push(`| ${label} | ${SEVERITIES.map((sev) => list.filter((f) => f.severity === sev).length).join(" | ")} |`);
  }
  md.push("", "Largest costs to the score:", "");
  for (const c of s.costs.slice(0, 5)) md.push(`- \`${c.rule}\` (${RULES.get(c.rule).title}): ${c.points} points`);
  md.push("");
  const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  for (const [group, label] of Object.entries(GROUPS)) {
    const list = report.findings.filter((f) => f.group === group);
    if (!list.length) continue;
    md.push(`## ${label}`, "", "| Severity | Where | Finding | Evidence |", "|---|---|---|---|");
    for (const f of list) md.push(`| ${f.severity} | \`${cell(where(f))}\` | ${cell(f.message)} | ${f.evidence && f.evidence !== f.file ? `\`${cell(f.evidence).replace(/`/g, "'")}\`` : ""} |`);
    md.push("", "What to do instead:", "");
    for (const rule of [...new Set(list.map((f) => f.rule))]) md.push(`- \`${rule}\`: ${RULES.get(rule).instead}`);
    md.push("");
  }
  md.push("## How the score works", "");
  md.push(`Each finding costs ${WEIGHTS.high} points (high), ${WEIGHTS.medium} (medium) or ${WEIGHTS.low} (low). One rule costs at most ${RULE_CAP} points. The total (${s.points}) is divided by a size allowance of ${s.allowance} (the square root of thousands of code lines, at least 1), and the score is 100 minus that.`, "");
  return md.join("\n");
}

const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function toHtml(report, s) {
  const rows = (list) => list.map((f) => `<tr class="${f.severity}"><td>${f.severity}</td><td><code>${esc(where(f))}</code></td><td>${esc(f.message)}</td><td>${f.evidence && f.evidence !== f.file ? `<code>${esc(f.evidence)}</code>` : ""}</td></tr>`).join("\n");
  const sections = Object.entries(GROUPS).map(([group, label]) => {
    const list = report.findings.filter((f) => f.group === group);
    if (!list.length) return "";
    const instead = [...new Set(list.map((f) => f.rule))].map((r) => `<li><code>${esc(r)}</code>: ${esc(RULES.get(r).instead)}</li>`).join("");
    return `<section><h2>${esc(label)} <span class="count">${list.length}</span></h2>
<table><thead><tr><th>Severity</th><th>Where</th><th>Finding</th><th>Evidence</th></tr></thead><tbody>
${rows(list)}
</tbody></table><details><summary>What to do instead</summary><ul>${instead}</ul></details></section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artisanal report: ${esc(report.project)}</title>
<style>
  :root { --bg: #fafaf8; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e1dc; --high: #b42318; --medium: #b54708; --low: #475467; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe6; --muted: #a3a29c; --line: #34332f; --high: #f97066; --medium: #fdb022; --low: #98a2b3; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 32px 0 8px; }
  .meta, .count, summary { color: var(--muted); } .count { font-weight: normal; font-size: 14px; }
  .score { display: flex; align-items: baseline; gap: 12px; margin: 16px 0; }
  .score b { font-size: 48px; } .grade { font-size: 24px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  td:first-child { font-weight: 600; text-transform: uppercase; font-size: 12px; } tr.high td:first-child { color: var(--high); } tr.medium td:first-child { color: var(--medium); } tr.low td:first-child { color: var(--low); }
  code { font: 13px/1.4 ui-monospace, monospace; overflow-wrap: anywhere; } details { margin: 8px 0; }
  .wrap { overflow-x: auto; }
</style>
</head>
<body><main>
<h1>Artisanal report: ${esc(report.project)}</h1>
<p class="meta">Generated ${esc(localDate(report.generatedAt))}. Scanned ${plural(report.scanned.files, "file")} and ${plural(report.scanned.commits, "commit")}.</p>
<div class="score"><b>${s.value}</b><span>/ 100</span><span class="grade">${s.grade}</span></div>
<p>${report.summary.findings} finding${report.summary.findings === 1 ? "" : "s"} in ${s.codeLines} lines of code: ${SEVERITIES.map((k) => `${report.summary.bySeverity[k]} ${k}`).join(", ")}.</p>
<div class="wrap">${sections || "<p>No findings.</p>"}</div>
<h2>How the score works</h2>
<p class="meta">Each finding costs ${WEIGHTS.high} points (high), ${WEIGHTS.medium} (medium) or ${WEIGHTS.low} (low). One rule costs at most ${RULE_CAP} points. The total (${s.points}) is divided by a size allowance of ${s.allowance} (the square root of thousands of code lines, at least 1), and the score is 100 minus that.</p>
</main></body>
</html>
`;
}

/** Runs the checks (or reads saved findings), scores them and writes report.md and report.html. */
export function writeReport(projectDir, { from = null, out = null } = {}) {
  const dir = path.resolve(projectDir);
  const report = from ? JSON.parse(readFileSync(from, "utf8")) : runChecks(dir);
  const s = score(report.findings, codeLines(dir));
  const outDir = path.resolve(out ?? path.join(dir, ".artisanal"));
  mkdirSync(outDir, { recursive: true });
  const markdown = path.join(outDir, "report.md");
  const html = path.join(outDir, "report.html");
  writeFileSync(markdown, `${toMarkdown(report, s)}\n`);
  writeFileSync(html, toHtml(report, s));
  writeFileSync(path.join(outDir, "findings.json"), `${JSON.stringify({ ...report, score: s }, null, 2)}\n`);
  return { score: s, summary: report.summary, files: { markdown, html } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opts = { dir: ".", json: false };
  let error = null;
  for (let i = 0; i < args.length && !error; i++) {
    const a = args[i];
    if (a === "--json") opts.json = true;
    else if (a === "--from") opts.from = args[++i];
    else if (a === "--out") opts.out = args[++i];
    else if (a.startsWith("--")) error = `unknown option ${a}`;
    else opts.dir = a;
  }
  if (!error && !existsSync(opts.dir)) error = `folder not found: ${opts.dir}`;
  if (!error && opts.from && !existsSync(opts.from)) error = `file not found: ${opts.from}`;
  if (error) {
    console.error(`report: ${error}\nUsage: node report.mjs [projectDir] [--from findings.json] [--out dir] [--json]`);
    process.exitCode = 2;
  } else {
    try {
      const result = writeReport(opts.dir, opts);
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        const s = result.summary;
        console.log(`Cleanliness score: ${result.score.value}/100 (${result.score.grade}). ${s.findings} findings: ${SEVERITIES.map((k) => `${s.bySeverity[k]} ${k}`).join(", ")}.`);
        console.log(`Report: ${result.files.markdown}\n        ${result.files.html}`);
      }
    } catch (err) {
      console.error(`report: ${err.message}`);
      process.exitCode = 1;
    }
  }
}
