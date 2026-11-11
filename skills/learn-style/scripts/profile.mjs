#!/usr/bin/env node
// Builds a style profile of a project from its source files and git history: languages,
// naming, comment density, function length, error handling, logging, indentation, test
// layout and commit message format. Later Artisanal checks compare new code against it.
// Read-only except for the profile it writes to <projectDir>/.artisanal/profile.json.
//
// The analysis is line-based and heuristic (no parsers), so numbers are approximate.
//
// Usage: node profile.mjs [projectDir] [--json] [--no-write] [--max-commits N]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA = 1;
const MAX_FILES = 5000;
const MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_COMMITS = 300;

const ANALYZED = {
  javascript: { exts: [".js", ".mjs", ".cjs", ".jsx"], syntax: "c" },
  typescript: { exts: [".ts", ".tsx", ".mts", ".cts"], syntax: "c" },
  python: { exts: [".py"], syntax: "python" },
  apex: { exts: [".cls", ".trigger"], syntax: "c" },
  java: { exts: [".java"], syntax: "c" },
};
// Counted for the language mix only.
const COUNTED = {
  go: [".go"], rust: [".rs"], ruby: [".rb"], csharp: [".cs"], kotlin: [".kt", ".kts"], swift: [".swift"],
  php: [".php"], c: [".c", ".h"], cpp: [".cc", ".cpp", ".hpp"], shell: [".sh", ".bash"], powershell: [".ps1"],
  html: [".html", ".htm"], css: [".css", ".scss", ".less"], vue: [".vue"], svelte: [".svelte"], sql: [".sql"],
};
const EXT_LANG = new Map();
for (const [lang, { exts }] of Object.entries(ANALYZED)) for (const e of exts) EXT_LANG.set(e, lang);
for (const [lang, exts] of Object.entries(COUNTED)) for (const e of exts) EXT_LANG.set(e, lang);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", "vendor", "target", "obj", "__pycache__",
  ".venv", "venv", ".tox", ".next", ".nuxt", ".artisanal", ".sfdx", ".sf",
]);

// Sample and fixture code is often written badly on purpose, so it is not the team's style.
const EXAMPLE_DIRS = new Set(["examples", "example", "fixtures", "__fixtures__", "testdata"]);

const TEST_FILE = [
  ["*.test.*", /\.test\.[cm]?[jt]sx?$/],
  ["*.spec.*", /\.spec\.[cm]?[jt]sx?$/],
  ["test_*.py", /(^|\/)test_[^/]*\.py$/],
  ["*_test.py", /_test\.py$/],
  ["*Test.java", /(Test|Tests|IT)\.java$/],
];
const TEST_DIR = /^(.*?(?:^|\/)(?:tests?|__tests__|specs?|src\/test))\//;

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

const round = (x, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;
const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
const bump = (obj, key, n = 1) => { obj[key] = (obj[key] ?? 0) + n; };
const share = (n, total) => (total ? round(n / total) : 0);

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
const median = (values) => percentile(values, 0.5);

/** Naming style of one identifier or file name. `lowercase` is ambiguous (camelCase or snake_case). */
export function caseStyle(name) {
  const n = name.replace(/^[_$]+|[_$]+$/g, "");
  if (!n) return null;
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(n)) return "snake_case";
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(n)) return "SCREAMING_SNAKE";
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(n)) return "kebab-case";
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(n)) return "camelCase";
  if (/^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(n)) return "PascalCase";
  if (/^[a-z][a-z0-9]*$/.test(n)) return "lowercase";
  if (/^[A-Z][A-Z0-9]*$/.test(n)) return "UPPERCASE";
  return "mixed";
}

// ---- Lexers: one entry per source line, comments removed, string contents masked as "x".

const newLine = () => ({ code: "", comment: false, doc: false });

// In JavaScript a `/` starts a regex (not a division) after an operator, an opening bracket or a keyword.
const startsRegex = (before) => {
  const t = before.trimEnd();
  return !t || /[(,=:[!&|?{};+\-*%<>~^]$/.test(t) || /\b(?:return|typeof|case|in|of|delete|void|throw|new|yield|await)$/.test(t);
};

/** Lexes C-like source (JavaScript, TypeScript, Java, Apex). `/** ... *\/` blocks count as doc. */
export function lexC(text, { backtick = false } = {}) {
  const lines = [];
  let line = newLine();
  let state = "code"; // code | line | block | doc | string
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "\r") continue;
    if (c === "\n") {
      lines.push(line);
      line = newLine();
      if (state === "line" || (state === "string" && quote !== "`")) state = "code";
      continue;
    }
    if (state === "code") {
      if (c === "/" && n === "/") {
        state = "line";
        line.comment = true;
        i++;
      } else if (c === "/" && n === "*") {
        state = text[i + 2] === "*" && text[i + 3] !== "/" ? "doc" : "block";
        line[state === "doc" ? "doc" : "comment"] = true;
        i++;
      } else if (c === '"' || c === "'" || (c === "`" && backtick)) {
        state = "string";
        quote = c;
        line.code += c;
      } else if (c === "/" && backtick && startsRegex(line.code)) {
        // Regex literal: mask it so brackets and quotes inside do not count as code.
        let j = i + 1;
        let inClass = false;
        while (j < text.length && text[j] !== "\n") {
          if (text[j] === "\\") j++;
          else if (text[j] === "[") inClass = true;
          else if (text[j] === "]") inClass = false;
          else if (text[j] === "/" && !inClass) break;
          j++;
        }
        if (text[j] !== "/") line.code += c;
        else {
          line.code += `/${"x".repeat(j - i - 1)}/`;
          i = j;
        }
      } else if (c === "\\" && n !== undefined && n !== "\n") {
        line.code += c + n;
        i++;
      } else line.code += c;
    } else if (state === "block" || state === "doc") {
      if (c === "*" && n === "/") {
        state = "code";
        i++;
      } else if (c.trim()) line[state === "doc" ? "doc" : "comment"] = true;
    } else if (state === "string") {
      if (c === "\\" && n !== undefined && n !== "\n") {
        line.code += "xx";
        i++;
      } else if (c === quote) {
        state = "code";
        line.code += c;
      } else line.code += c.trim() ? "x" : c;
    }
  }
  lines.push(line);
  return lines;
}

/** Lexes Python. A triple-quoted string that starts a statement counts as doc. */
export function lexPython(text) {
  const lines = [];
  let line = newLine();
  let state = "code"; // code | line | string
  let quote = "";
  let doc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "\r") continue;
    if (c === "\n") {
      lines.push(line);
      line = newLine();
      if (state === "line" || (state === "string" && quote.length === 1)) state = "code";
      if (state === "string" && doc) line.doc = true;
      continue;
    }
    if (state === "code") {
      if (c === "#") {
        state = "line";
        line.comment = true;
      } else if (c === '"' || c === "'") {
        quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
        state = "string";
        doc = quote.length === 3 && !line.code.trim();
        if (doc) line.doc = true;
        else line.code += quote;
        i += quote.length - 1;
      } else line.code += c;
    } else if (state === "string") {
      if (c === "\\" && n !== undefined && n !== "\n") {
        if (!doc) line.code += "xx";
        i++;
      } else if (text.startsWith(quote, i)) {
        state = "code";
        if (!doc) line.code += quote;
        i += quote.length - 1;
      } else if (!doc) line.code += c.trim() ? "x" : c;
    }
  }
  lines.push(line);
  return lines;
}

// ---- Helpers over lexed code.

function matchPair(src, open) {
  const o = src[open];
  const c = o === "(" ? ")" : o === "{" ? "}" : "]";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return i;
  }
  return -1;
}

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

/** Splits a block body into statements at `;` or newlines outside brackets. */
function splitStatements(body) {
  const out = [];
  let cur = "";
  let depth = 0;
  for (const c of body) {
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    if ((c === ";" || c === "\n") && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s && !/^[{}]+$/.test(s));
}

const LOG_CALL = /^(?:console\.\w+|System\.debug|System\.(?:out|err)\.print\w*|(?:this\.|self\.)?(?:log|logger|_logger|LOG|LOGGER|logging)\.\w+|\w+\.printStackTrace|print)\s*\(/i;

function classifyHandler(statements, { python = false } = {}) {
  const real = python ? statements.filter((s) => s !== "pass" && s !== "...") : statements;
  if (!real.length) return "empty";
  if (real.every((s) => (python ? /^raise\b/ : /^throw\b/).test(s))) return "rethrow";
  if (real.every((s) => LOG_CALL.test(s))) return "logOnly";
  return "handled";
}

function countLogging(src, logging) {
  bump(logging, "console", (src.match(/\bconsole\.(?:log|debug|info|warn|error|trace)\s*\(/g) ?? []).length);
  bump(logging, "systemDebug", (src.match(/\bSystem\.debug\s*\(/gi) ?? []).length);
  bump(logging, "systemOut", (src.match(/\bSystem\.(?:out|err)\.print/g) ?? []).length);
  bump(logging, "print", (src.match(/(?<![\w.])print\s*\(/g) ?? []).length);
  bump(logging, "logger", (src.match(/\b(?:log|logger|_logger|LOG|LOGGER|logging)\.(?:debug|info|warn|warning|error|trace|fatal|exception|critical)\s*\(/g) ?? []).length);
}

const leadingWidth = (s) => s.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;

// ---- Per-file analysis.

function newStats() {
  return {
    files: 0, codeLines: 0, commentLines: 0, trailingComments: 0, docLines: 0, functionCount: 0, functionLengths: [],
    names: { functions: {}, classes: {}, variables: {}, constants: {}, files: {} },
    errors: { try: 0, catch: 0, throws: 0, promiseCatch: 0, bareExcept: 0, empty: 0, rethrow: 0, logOnly: 0, handled: 0 },
    logging: {}, indent: { tabs: 0, spaces: 0, steps: {} },
  };
}

// SCREAMING_SNAKE names are constants; counting them as variables would hide the variable style.
function addVariable(acc, name) {
  const style = caseStyle(name);
  bump(style === "SCREAMING_SNAKE" || (style === "UPPERCASE" && name.length > 1) ? acc.names.constants : acc.names.variables, style);
}

const JS_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "do", "else", "try", "typeof", "new", "await", "super", "import", "export", "constructor", "delete", "void", "yield", "in", "of"]);
const JAVA_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw", "else", "do", "try", "super", "this", "synchronized", "case", "import", "package", "goto", "assert", "instanceof", "when"]);

const JS_FUNCTIONS = [
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b\s*\*?\s*[\w$]*\s*\(/g,
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g,
  /^[ \t]*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm,
];
const JS_ARROW = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|[A-Za-z_$][\w$]*)\s*(?::[^=;{]+)?=>\s*/g;
const JAVA_METHOD = /^[ \t]*(?:@\w+(?:\([^)]*\))?\s+)*((?:(?:public|private|protected|global|static|final|abstract|override|virtual|synchronized|native|webservice|testmethod|default)\s+)*)(?:<[^>]+>\s+)?(?:([A-Za-z_][\w.]*(?:<[^()]*?>)?(?:\[\])*)\s+)?([A-Za-z_]\w*)\s*\(/gim;
const JAVA_VAR = /^[ \t]*(?:(?:public|private|protected|global|static|final|transient)\s+)*([A-Za-z_][\w.]*(?:<[^()=;]*?>)?(?:\[\])*)\s+([A-Za-z_]\w*)\s*(?:=|;)/gim;

/** Index just past the `{` that opens the body after the parameter list at `paren`, or -1. */
function bodyAfterParams(src, paren) {
  const close = matchPair(src, paren);
  if (close < 0) return -1;
  const m = /^\s*(?::[^;{}=]*|throws[^;{}=]*)?\{/i.exec(src.slice(close + 1, close + 300));
  return m ? close + 1 + m[0].length : -1;
}

function analyzeC(lines, language, acc) {
  const src = lines.map((l) => l.code).join("\n");
  const lineOf = lineIndex(src);
  const fnNames = new Set();
  const addFunction = (name, nameIdx, openIdx) => {
    if (name !== "constructor") bump(acc.names.functions, caseStyle(name));
    fnNames.add(name);
    acc.functionCount++;
    if (openIdx < 0) return;
    const close = matchPair(src, openIdx - 1);
    if (close > 0) acc.functionLengths.push(lineOf(close) - lineOf(nameIdx) + 1);
  };

  if (language === "javascript" || language === "typescript") {
    const seen = new Set();
    for (const re of JS_FUNCTIONS) {
      for (const m of src.matchAll(re)) {
        const paren = m.index + m[0].length - 1;
        if (seen.has(paren) || JS_KEYWORDS.has(m[1])) continue;
        const open = bodyAfterParams(src, paren);
        if (re === JS_FUNCTIONS[2] && open < 0) continue; // a call, not a method
        seen.add(paren);
        addFunction(m[1], m.index + m[0].indexOf(m[1]), open);
      }
    }
    for (const m of src.matchAll(JS_ARROW)) {
      const end = m.index + m[0].length;
      addFunction(m[1], m.index, src[end] === "{" ? end + 1 : -1);
    }
    for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
      if (!fnNames.has(m[1])) addVariable(acc, m[1]);
    }
    acc.errors.promiseCatch += (src.match(/\.catch\s*\(/g) ?? []).length;
  } else {
    for (const m of src.matchAll(JAVA_METHOD)) {
      const [, mods, type, name] = m;
      if (JAVA_KEYWORDS.has(name.toLowerCase()) || (type && JAVA_KEYWORDS.has(type.toLowerCase()))) continue;
      if (!type && !mods.trim()) continue;
      const nameIdx = m.index + m[0].lastIndexOf(name);
      if (!type) {
        // Constructor: its name is the class name, so it says nothing about method naming.
        acc.functionCount++;
        const open = bodyAfterParams(src, m.index + m[0].length - 1);
        if (open > 0) acc.functionLengths.push(lineOf(matchPair(src, open - 1)) - lineOf(nameIdx) + 1);
        continue;
      }
      addFunction(name, nameIdx, bodyAfterParams(src, m.index + m[0].length - 1));
    }
    for (const m of src.matchAll(JAVA_VAR)) {
      if (!JAVA_KEYWORDS.has(m[1].toLowerCase())) addVariable(acc, m[2]);
    }
  }
  for (const m of src.matchAll(/\b(?:class|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) bump(acc.names.classes, caseStyle(m[1]));

  acc.errors.try += (src.match(/\btry\s*\{/g) ?? []).length;
  acc.errors.throws += (src.match(/\bthrow\b/g) ?? []).length;
  for (const m of src.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    acc.errors.catch++;
    const open = m.index + m[0].length - 1;
    const close = matchPair(src, open);
    if (close > 0) acc.errors[classifyHandler(splitStatements(src.slice(open + 1, close)))]++;
  }
  countLogging(src, acc.logging);
}

function analyzePython(lines, acc) {
  lines.forEach((line, i) => {
    const code = line.code;
    const def = code.match(/^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (def) {
      bump(acc.names.functions, caseStyle(def[2]));
      acc.functionCount++;
      const indent = leadingWidth(def[1]);
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.code.trim()) {
          if (leadingWidth(l.code) <= indent && !/^\s*[)\]}]/.test(l.code)) break;
          end = j;
        } else if (l.doc) end = j;
      }
      acc.functionLengths.push(end - i + 1);
    }
    const cls = code.match(/^\s*class\s+([A-Za-z_]\w*)/);
    if (cls) bump(acc.names.classes, caseStyle(cls[1]));
    const v = code.match(/^[ \t]*([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/);
    if (v && !def) addVariable(acc, v[1]);

    if (/^\s*try\s*:/.test(code)) acc.errors.try++;
    if (/^\s*raise\b/.test(code)) acc.errors.throws++;
    const ex = code.match(/^([ \t]*)except\b([^:]*):(.*)$/);
    if (ex) {
      acc.errors.catch++;
      if (!ex[2].trim()) acc.errors.bareExcept++;
      let body = ex[3];
      if (!body.trim()) {
        const indent = leadingWidth(ex[1]);
        const parts = [];
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j].code;
          if (!l.trim()) continue;
          if (leadingWidth(l) <= indent && !/^\s*[)\]}]/.test(l)) break;
          parts.push(l);
        }
        body = parts.join("\n");
      }
      acc.errors[classifyHandler(splitStatements(body), { python: true })]++;
    }
  });
  countLogging(lines.map((l) => l.code).join("\n"), acc.logging);
}

/** Adds one source file's numbers to `acc` (a fresh accumulator if omitted) and returns it. */
export function analyzeSource(text, language, acc = newStats()) {
  const { syntax } = ANALYZED[language];
  const lines = syntax === "python" ? lexPython(text) : lexC(text, { backtick: language === "javascript" || language === "typescript" });
  acc.files++;
  let prevIndent = 0;
  for (const l of lines) {
    const hasCode = Boolean(l.code.trim());
    if (hasCode) {
      acc.codeLines++;
      if (l.comment) acc.trailingComments++;
      const lead = l.code.match(/^[ \t]*/)[0];
      if (lead.startsWith("\t")) acc.indent.tabs++;
      else if (lead) acc.indent.spaces++;
      const width = leadingWidth(l.code);
      if (!lead.startsWith("\t") && width > prevIndent) bump(acc.indent.steps, width - prevIndent);
      prevIndent = width;
    } else if (l.doc) acc.docLines++;
    else if (l.comment) acc.commentLines++;
  }
  if (syntax === "python") analyzePython(lines, acc);
  else analyzeC(lines, language, acc);
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

function indentSummary({ tabs, spaces, steps }) {
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
  if (language === "javascript" || language === "typescript") errorHandling.promiseCatch = e.promiseCatch;
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

// ---- Files, tests and commits.

function languageOf(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".d.ts") || /\.min\.[cm]?js$/.test(lower)) return null;
  return EXT_LANG.get(path.extname(lower)) ?? null;
}

function listFiles(dir) {
  const out = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], dir);
  if (out !== null) return out.split("\0").filter(Boolean);
  const files = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile()) files.push(p);
    }
  };
  walk("");
  return files;
}

const isGenerated = (text) =>
  /@generated|do not edit|auto-generated/i.test(text.slice(0, 600)) || text.split("\n", 50).some((l) => l.length > 2000);

function testPattern(file, language, text) {
  for (const [name, re] of TEST_FILE) if (re.test(file)) return name;
  if (language === "apex" && /@isTest\b/i.test(text)) return "@isTest";
  if (ANALYZED[language] && TEST_DIR.test(file)) return "in test folder";
  return null;
}

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

const CONVENTIONAL_TYPES = new Set(["feat", "fix", "docs", "doc", "style", "refactor", "perf", "test", "tests", "build", "ci", "chore", "revert", "release", "deps", "wip", "hotfix"]);
const VERBS = new Set(("add fix update remove refactor change improve rename move bump use make implement support clean handle allow create delete drop replace merge revert upgrade downgrade set show return prevent avoid simplify split extract document test enable disable introduce release apply adjust correct convert ensure skip reduce increase tweak format build write check load save run sort initialize init prepare migrate configure expose hide limit include exclude restore reset deprecate rewrite optimize optimise speed cache validate parse render log raise throw catch wrap guard store fetch pass call trim tidy polish align bootstrap scaffold publish deploy install").split(" "));
const IRREGULAR_PAST = new Map([["built", "build"], ["wrote", "write"], ["made", "make"], ["ran", "run"], ["rewrote", "rewrite"]]);
const AI_NAMES = "claude|anthropic|copilot|cursor|openai|chatgpt|gpt-\\d|codex|gemini|windsurf|codeium|aider|devin|tabnine|codewhisperer|amazon q";
const AI_TRAILER = new RegExp(`^(?:co-authored-by|generated-by|assisted-by):.*\\b(?:${AI_NAMES})`, "im");
const AI_GENERATED = new RegExp(`generated (?:with|by)\\b.*\\b(?:${AI_NAMES})`, "i");
const TRAILER_LINE = /^[A-Za-z][\w-]*: .+$/;
const BULLET = /^\s*[-*•]\s+/;

function verbForm(word) {
  const w = word.toLowerCase();
  if (VERBS.has(w)) return "imperative";
  if (IRREGULAR_PAST.has(w)) return "past";
  if (w.endsWith("ed") && [w.slice(0, -2), w.slice(0, -1), w.slice(0, -3)].some((b) => VERBS.has(b))) return "past";
  if (w.endsWith("ing")) {
    const base = w.slice(0, -3);
    if (VERBS.has(base) || VERBS.has(`${base}e`) || VERBS.has(base.slice(0, -1))) return "gerund";
  }
  if (w.endsWith("s") && (VERBS.has(w.slice(0, -1)) || (w.endsWith("es") && VERBS.has(w.slice(0, -2))))) return "thirdPerson";
  return null;
}

/** Splits a commit subject into its format and the description that follows any prefix. */
export function classifySubject(subject) {
  const conv = subject.match(/^([a-z]+)(\([^)]*\))?!?:\s+(.*)$/i);
  if (conv && CONVENTIONAL_TYPES.has(conv[1].toLowerCase())) return { format: "conventional", type: conv[1].toLowerCase(), scoped: Boolean(conv[2]), description: conv[3] };
  const ticket = subject.match(/^\[?([A-Z][A-Z0-9]+-\d+)\]?[:\s-]+(.*)$/) ?? subject.match(/^\(?#\d+\)?[:\s-]+(.*)$/);
  if (ticket) return { format: "ticket", description: ticket[ticket.length - 1] };
  const tag = subject.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (tag) return { format: "bracket-tag", description: tag[2] };
  return { format: "plain", description: subject };
}

function commitsSummary(dir, maxCommits) {
  const log = run("git", ["log", "--no-merges", "-n", String(maxCommits), "--format=%an%x1f%s%x1f%b%x1e"], dir);
  if (!log) return { analyzed: 0 };
  const commits = log.split("\x1e").map((c) => c.replace(/^\r?\n/, "")).filter((c) => c.trim()).map((c) => {
    const [author, subject, body = ""] = c.split("\x1f");
    return { author, subject: subject.trim(), body: body.trim() };
  });
  if (!commits.length) return { analyzed: 0 };
  const total = Number(run("git", ["rev-list", "--count", "--no-merges", "HEAD"], dir)) || commits.length;

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

    const bodyLines = c.body.split(/\r?\n/);
    const prose = bodyLines.filter((l) => l.trim() && !TRAILER_LINE.test(l.trim()));
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
    total, analyzed: n, authors: new Set(commits.map((c) => c.author)).size,
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

  const listed = listFiles(dir).filter((f) => !f.split("/").some((part) => SKIP_DIRS.has(part)));
  const skipped = { examples: 0, large: 0, generated: 0, unreadable: 0, overLimit: 0 };
  const mix = {};
  const stats = {};
  const tests = [];
  const testTexts = [];
  let sourceFiles = 0;
  let analyzed = 0;

  for (const file of listed) {
    const language = languageOf(file);
    if (!language) continue;
    if (file.split("/").slice(0, -1).some((part) => EXAMPLE_DIRS.has(part))) {
      skipped.examples++;
      continue;
    }
    const full = path.join(dir, file);
    let text;
    try {
      if (statSync(full).size > MAX_BYTES) {
        skipped.large++;
        continue;
      }
      text = readFileSync(full, "utf8");
    } catch {
      skipped.unreadable++;
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
    const base = path.basename(file).split(".")[0];
    bump(acc.names.files, caseStyle(base));
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

export function writeProfile(projectDir, profile) {
  const outDir = path.join(path.resolve(projectDir), ".artisanal");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "profile.json");
  writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`);
  return file;
}

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
