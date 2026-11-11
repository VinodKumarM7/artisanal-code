// Shared by Artisanal's scripts: which files to read, how to split source into code and
// comments, and where the functions, classes, variables and catch blocks are.
//
// Everything here is line-based and heuristic (no parsers). Lexed code keeps its layout:
// comments are removed and string contents are masked as "x", so brackets and keywords
// inside strings never count as code.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const MAX_BYTES = 512 * 1024;

export const ANALYZED = {
  javascript: { exts: [".js", ".mjs", ".cjs", ".jsx"], syntax: "c" },
  typescript: { exts: [".ts", ".tsx", ".mts", ".cts"], syntax: "c" },
  python: { exts: [".py"], syntax: "python" },
  apex: { exts: [".cls", ".trigger"], syntax: "c" },
  java: { exts: [".java"], syntax: "c" },
};
// Counted for the language mix only.
export const COUNTED = {
  go: [".go"], rust: [".rs"], ruby: [".rb"], csharp: [".cs"], kotlin: [".kt", ".kts"], swift: [".swift"],
  php: [".php"], c: [".c", ".h"], cpp: [".cc", ".cpp", ".hpp"], shell: [".sh", ".bash"], powershell: [".ps1"],
  html: [".html", ".htm"], css: [".css", ".scss", ".less"], vue: [".vue"], svelte: [".svelte"], sql: [".sql"],
};
const EXT_LANG = new Map();
for (const [lang, { exts }] of Object.entries(ANALYZED)) for (const e of exts) EXT_LANG.set(e, lang);
for (const [lang, exts] of Object.entries(COUNTED)) for (const e of exts) EXT_LANG.set(e, lang);

export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", "vendor", "target", "obj", "__pycache__",
  ".venv", "venv", ".tox", ".next", ".nuxt", ".artisanal", ".sfdx", ".sf",
]);
// Sample and fixture code is often written badly on purpose, so it is not the team's style.
// "example" alone is left out: com/example is the usual Java package path.
export const EXAMPLE_DIRS = new Set(["examples", "fixtures", "__fixtures__", "testdata"]);

export const TEST_FILE = [
  ["*.test.*", /\.test\.[cm]?[jt]sx?$/],
  ["*.spec.*", /\.spec\.[cm]?[jt]sx?$/],
  ["test_*.py", /(^|\/)test_[^/]*\.py$/],
  ["*_test.py", /_test\.py$/],
  ["*Test.java", /(Test|Tests|IT)\.java$/],
];
export const TEST_DIR = /^(.*?(?:^|\/)(?:tests?|__tests__|specs?|src\/test))\//;

export const AI_NAMES = "claude|anthropic|copilot|cursor|openai|chatgpt|gpt-?\\d|codex|gemini|windsurf|codeium|aider|devin|tabnine|codewhisperer|amazon q";

export function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

export const round = (x, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;
export const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
export const bump = (obj, key, n = 1) => { obj[key] = (obj[key] ?? 0) + n; };
export const share = (n, total) => (total ? round(n / total) : 0);

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
export const median = (values) => percentile(values, 0.5);

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

export const isJsLike = (language) => language === "javascript" || language === "typescript";

// ---- Lexers: one entry per source line with `code` (comments removed, strings masked),
// `comment` and `doc` flags, and `text` (the comment or doc text on that line).

const newLine = () => ({ code: "", comment: false, doc: false, text: "" });
const finish = (line) => {
  line.text = line.text.replace(/^\s*\*+(?!\/)\s?/, "").trim();
  return line;
};

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
      lines.push(finish(line));
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
    } else if (state === "line") {
      line.text += c;
    } else if (state === "block" || state === "doc") {
      if (c === "*" && n === "/") {
        line[state === "doc" ? "doc" : "comment"] = true;
        state = "code";
        i++;
      } else {
        line.text += c;
        if (c.trim()) line[state === "doc" ? "doc" : "comment"] = true;
      }
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
  lines.push(finish(line));
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
      lines.push(finish(line));
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
    } else if (state === "line") {
      line.text += c;
    } else if (state === "string") {
      if (c === "\\" && n !== undefined && n !== "\n") {
        if (doc) line.text += c + n;
        else line.code += "xx";
        i++;
      } else if (text.startsWith(quote, i)) {
        state = "code";
        if (!doc) line.code += quote;
        i += quote.length - 1;
      } else if (doc) line.text += c;
      else line.code += c.trim() ? "x" : c;
    }
  }
  lines.push(finish(line));
  return lines;
}

// ---- Helpers over lexed code.

export function matchPair(src, open) {
  const o = src[open];
  const c = o === "(" ? ")" : o === "{" ? "}" : o === "[" ? "]" : ">";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return i;
  }
  return -1;
}

/** Returns the line starts of `src` and a function from a character index to its line (0-based). */
export function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return { starts, lineOf };
}

/** Splits a block body into statements at `;` or newlines outside brackets. */
export function splitStatements(body) {
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

export const LOG_CALL = /^(?:console\.\w+|System\.debug|System\.(?:out|err)\.print\w*|(?:this\.|self\.)?(?:log|logger|_logger|LOG|LOGGER|logging)\.\w+|\w+\.printStackTrace|print)\s*\(/i;

/** Sorts a catch or except body into empty, rethrow, logOnly or handled. */
export function classifyHandler(statements, { python = false } = {}) {
  const real = python ? statements.filter((s) => s !== "pass" && s !== "...") : statements;
  if (!real.length) return "empty";
  if (real.every((s) => (python ? /^raise\b/ : /^throw\b/).test(s))) return "rethrow";
  if (real.every((s) => LOG_CALL.test(s))) return "logOnly";
  return "handled";
}

export const leadingWidth = (s) => s.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;

/** Splits a parameter list into names, dropping types, defaults and `self`/`cls`. */
export function paramNames(params, language) {
  if (!params || !params.trim()) return [];
  const parts = splitStatements(params.replace(/,/g, ";"));
  return parts.map((p) => {
    const clean = p.replace(/=.*$/s, "").replace(/^\.\.\.|^\*{1,2}/, "").trim();
    if (language === "java" || language === "apex") return clean.split(/\s+/).pop();
    return clean.split(/[\s:?]/)[0];
  }).filter((n) => n && n !== "self" && n !== "cls");
}

// ---- Files.

export function languageOf(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".d.ts") || /\.min\.[cm]?js$/.test(lower)) return null;
  return EXT_LANG.get(path.extname(lower)) ?? null;
}

/** True for paths inside dependency, build, sample or fixture folders. */
export const isSkippedPath = (file) => file.split("/").slice(0, -1).some((part) => SKIP_DIRS.has(part) || EXAMPLE_DIRS.has(part));

/** Lists project files relative to `dir` with forward slashes; git-aware when `dir` is in a repo. */
export function listFiles(dir, { trackedOnly = false } = {}) {
  const args = trackedOnly ? ["ls-files", "-z", "--cached"] : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const out = run("git", args, dir);
  if (out !== null) {
    return [...new Set(out.split("\0").filter(Boolean))].filter((f) => {
      try {
        return statSync(path.join(dir, f)).isFile();
      } catch {
        return false; // deleted but still in the index
      }
    });
  }
  if (trackedOnly) return [];
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

/** Reads a text file, or returns null if it is too large or unreadable. */
export function readText(full) {
  try {
    if (statSync(full).size > MAX_BYTES) return null;
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

const AI_HEADER = new RegExp(`\\b(?:${AI_NAMES})\\b`, "i");
/** Code generators mark their output; a header that names an AI tool is a trace, not codegen. */
export function isGenerated(text) {
  const head = text.slice(0, 600);
  return (/@generated|do not edit|auto-generated/i.test(head) && !AI_HEADER.test(head)) || text.split("\n", 50).some((l) => l.length > 2000);
}

export function testPattern(file, language, text) {
  for (const [name, re] of TEST_FILE) if (re.test(file)) return name;
  if (language === "apex" && /@isTest\b/i.test(text)) return "@isTest";
  if (ANALYZED[language] && TEST_DIR.test(file)) return "in test folder";
  return null;
}

// ---- Parsing: functions, classes, variables and catch blocks.

const JS_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "do", "else", "try", "typeof", "new", "await", "super", "import", "export", "delete", "void", "yield", "in", "of"]);
const JAVA_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw", "else", "do", "try", "super", "this", "synchronized", "case", "import", "package", "goto", "assert", "instanceof", "when"]);

const JS_FUNCTIONS = [
  ["function", /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b\s*\*?\s*[\w$]*\s*(?:<[^>()]*>)?\s*\(/g],
  ["function", /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g],
  ["method", /^[ \t]*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/gm],
];
const JS_ARROW = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:<[^>()]*>\s*)?(\([^()]*(?:\([^()]*\)[^()]*)*\)|[A-Za-z_$][\w$]*)\s*(?::[^=;{]+)?=>\s*/g;
const JAVA_METHOD = /^[ \t]*((?:@\w+(?:\([^)]*\))?\s+)*)((?:(?:public|private|protected|global|static|final|abstract|override|virtual|synchronized|native|webservice|testmethod|default)\s+)*)(?:<[^>]+>\s+)?(?:([A-Za-z_][\w.]*(?:<[^()]*?>)?(?:\[\])*)\s+)?([A-Za-z_]\w*)\s*\(/gim;
const JAVA_VAR = /^[ \t]*(?:(?:public|private|protected|global|static|final|transient)\s+)*([A-Za-z_][\w.]*(?:<[^()=;]*?>)?(?:\[\])*)\s+([A-Za-z_]\w*)\s*(=\s*[^;\n]*|;)/gim;

/** Index of the `{` that opens the body after the parameter list at `paren`, or -1. */
function bodyOpen(src, paren) {
  const close = matchPair(src, paren);
  if (close < 0) return -1;
  const m = /^\s*(?::[^;{}=]*|throws[^;{}=]*)?\{/i.exec(src.slice(close + 1, close + 300));
  return m ? close + m[0].length : -1;
}

/** End of an arrow function's expression body: the first `;`, `,` or newline outside brackets. */
function expressionEnd(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if ((c === ";" || c === "\n" || c === ",") && depth === 0) return i;
  }
  return src.length;
}

function countBodyLines(p, from, to) {
  let code = 0;
  let doc = 0;
  for (let i = from; i <= to && i < p.lines.length; i++) {
    if (p.lines[i].code.trim()) code++;
    else if (p.lines[i].doc) doc++;
  }
  return { code, doc };
}

/** Comment or doc lines directly above `line`, skipping annotation and decorator lines. */
function commentAbove(p, line) {
  let i = line - 1;
  while (i >= 0 && /^\s*@/.test(p.lines[i].code)) i--;
  const found = [];
  while (i >= 0 && !p.lines[i].code.trim() && (p.lines[i].comment || p.lines[i].doc)) found.unshift(i--);
  if (!found.length) return null;
  return { start: found[0], end: found[found.length - 1], doc: found.some((j) => p.lines[j].doc), text: found.map((j) => p.lines[j].text).filter(Boolean).join(" ") };
}

function parseC(p) {
  const { src, lineOf } = p;
  const js = isJsLike(p.language);
  const add = ({ name, kind, nameIdx, paren, params, open, exprStart, decorators = [] }) => {
    const line = lineOf(nameIdx);
    const fn = { name, kind, line, endLine: null, params: params ?? null, body: null, expression: false, decorators, exported: /\bexport\b/.test(p.lines[line].code) };
    if (paren >= 0) fn.params = src.slice(paren + 1, matchPair(src, paren));
    if (open >= 0) {
      const close = matchPair(src, open);
      if (close > 0) {
        fn.body = src.slice(open + 1, close);
        fn.endLine = lineOf(close);
        fn.bodyStart = lineOf(open);
      }
    } else if (exprStart >= 0) {
      const end = expressionEnd(src, exprStart);
      fn.body = src.slice(exprStart, end);
      fn.expression = true;
      fn.endLine = lineOf(end);
      fn.bodyStart = lineOf(exprStart);
    }
    p.functions.push(fn);
  };

  if (js) {
    const seen = new Set();
    for (const [kind, re] of JS_FUNCTIONS) {
      for (const m of src.matchAll(re)) {
        const paren = m.index + m[0].length - 1;
        if (seen.has(paren) || JS_KEYWORDS.has(m[1])) continue;
        const open = bodyOpen(src, paren);
        if (kind === "method" && open < 0) continue; // a call, not a method
        seen.add(paren);
        add({ name: m[1], kind, nameIdx: m.index + m[0].indexOf(m[1]), paren, open });
      }
    }
    for (const m of src.matchAll(JS_ARROW)) {
      const end = m.index + m[0].length;
      const params = m[2].replace(/^\(|\)$/g, "");
      add({ name: m[1], kind: "arrow", nameIdx: m.index, paren: -1, params, open: src[end] === "{" ? end : -1, exprStart: src[end] === "{" ? -1 : end });
    }
  } else {
    for (const m of src.matchAll(JAVA_METHOD)) {
      const [, annotations, mods, type, name] = m;
      if (JAVA_KEYWORDS.has(name.toLowerCase()) || (type && JAVA_KEYWORDS.has(type.toLowerCase()))) continue;
      if (!type && !mods.trim()) continue;
      const paren = m.index + m[0].length - 1;
      add({
        name, kind: type ? "method" : "constructor", nameIdx: m.index + m[0].lastIndexOf(name), paren, open: bodyOpen(src, paren),
        decorators: (annotations.match(/@\w+/g) ?? []).map((a) => a.toLowerCase()),
      });
      p.functions[p.functions.length - 1].modifiers = mods.trim().toLowerCase().split(/\s+/).filter(Boolean);
    }
  }
  p.functions.sort((a, b) => a.line - b.line);
  const fnNames = new Set(p.functions.map((f) => f.name));

  for (const m of src.matchAll(/\b(class|interface|enum)\s+([A-Za-z_$][\w$]*)([^{;]*)/g)) {
    const header = m[3];
    const implementsList = (header.match(/\bimplements\s+([^{]+)/i)?.[1] ?? "").replace(/<[^>]*>/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    const cls = { name: m[2], kind: m[1], line: lineOf(m.index), implements: implementsList, extends: header.match(/\bextends\s+([\w.]+)/i)?.[1] ?? null, endLine: null };
    const open = m.index + m[0].length;
    if (src[open] === "{") {
      const close = matchPair(src, open);
      if (close > 0) cls.endLine = lineOf(close);
    }
    p.classes.push(cls);
  }

  if (js) {
    for (const m of src.matchAll(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?(=\s*[^;\n]*)?/g)) {
      if (fnNames.has(m[2])) continue;
      const line = lineOf(m.index);
      p.variables.push({ name: m[2], line, value: m[3] ? m[3].slice(1).trim() : null, exported: /\bexport\b/.test(p.lines[line].code), topLevel: !/^\s/.test(p.lines[line].code) });
    }
  } else {
    for (const m of src.matchAll(JAVA_VAR)) {
      if (JAVA_KEYWORDS.has(m[1].toLowerCase())) continue;
      const line = lineOf(m.index);
      p.variables.push({ name: m[2], line, value: m[3].startsWith("=") ? m[3].slice(1).trim() : null, exported: false, topLevel: false });
    }
  }

  p.tries = (src.match(/\btry\s*\{/g) ?? []).length;
  p.throws = (src.match(/\bthrow\b/g) ?? []).length;
  for (const m of src.matchAll(/\bcatch\s*(?:\(([^)]*)\))?\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchPair(src, open);
    if (close < 0) continue;
    const head = (m[1] ?? "").trim();
    const words = head.match(/[A-Za-z_$][\w$.]*/g) ?? [];
    const param = js ? words[0] ?? null : words[words.length - 1] ?? null;
    const statements = splitStatements(src.slice(open + 1, close));
    const line = lineOf(m.index);
    const endLine = lineOf(close);
    let hasComment = false;
    for (let i = line; i <= endLine; i++) if (p.lines[i].comment || p.lines[i].doc) hasComment = true;
    p.catches.push({
      line, endLine, param, type: js ? null : words.slice(0, -1).join(" ") || null, statements,
      kind: classifyHandler(statements), hasComment, bare: !head, followedByCatch: /^\s*catch\b/.test(src.slice(close + 1, close + 40)),
    });
  }
}

function parsePython(p) {
  const { lines, src, starts, lineOf } = p;
  const blockEnd = (i, indent) => {
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.code.trim()) {
        if (leadingWidth(l.code) <= indent && !/^\s*[)\]}]/.test(l.code)) break;
        end = j;
      } else if (l.doc) end = j;
    }
    return end;
  };

  lines.forEach((line, i) => {
    const code = line.code;
    const def = code.match(/^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (def) {
      const indent = leadingWidth(def[1]);
      const paren = starts[i] + def[0].length - 1;
      const close = matchPair(src, paren);
      const sigEnd = close > 0 ? lineOf(close) : i;
      const end = blockEnd(sigEnd, indent);
      const after = close > 0 ? src.slice(close + 1, starts[sigEnd + 1] ?? src.length) : "";
      const inline = after.replace(/^[^:]*:/, "").trim();
      const bodyLines = [inline, ...lines.slice(sigEnd + 1, end + 1).map((l) => l.code)].filter((s) => s.trim());
      const params = close > 0 ? src.slice(paren + 1, close) : "";
      const decorators = [];
      for (let j = i - 1; j >= 0 && /^\s*@/.test(lines[j].code); j--) decorators.push(lines[j].code.trim().split("(")[0].toLowerCase());
      const first = paramNames(params.replace(/\bself\b|\bcls\b/, "__self__"), "python")[0];
      p.functions.push({
        name: def[2], kind: first === "__self__" ? "method" : indent > 0 ? "nested" : "function", line: i, endLine: end, bodyStart: sigEnd,
        params: params.replace(/^\s*(self|cls)\s*,?/, ""), body: bodyLines.join("\n"), expression: false, decorators, exported: !def[2].startsWith("_"),
      });
    }
    const cls = code.match(/^([ \t]*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/);
    if (cls) {
      p.classes.push({ name: cls[2], kind: "class", line: i, endLine: blockEnd(i, leadingWidth(cls[1])), implements: [], extends: cls[3]?.trim() || null });
    }
    const v = code.match(/^([ \t]*)([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)\s*(.*)$/);
    const prev = lines.slice(0, i).reverse().find((l) => l.code.trim())?.code.trimEnd() ?? "";
    if (v && !def && !/[(,[{]$/.test(prev)) {
      p.variables.push({ name: v[2], line: i, value: v[3].trim() || null, exported: !v[2].startsWith("_"), topLevel: !v[1] });
    }

    if (/^\s*try\s*:/.test(code)) p.tries++;
    if (/^\s*raise\b/.test(code)) p.throws++;
    const ex = code.match(/^([ \t]*)except\b\s*([^:]*?)\s*:(.*)$/);
    if (ex) {
      const indent = leadingWidth(ex[1]);
      const asName = ex[2].match(/\bas\s+(\w+)$/)?.[1] ?? null;
      let body = ex[3];
      let endLine = i;
      let hasComment = line.comment;
      if (!body.trim()) {
        const parts = [];
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (!l.code.trim()) {
            if (l.comment) hasComment = true;
            continue;
          }
          if (leadingWidth(l.code) <= indent && !/^\s*[)\]}]/.test(l.code)) break;
          if (l.comment) hasComment = true;
          parts.push(l.code);
          endLine = j;
        }
        body = parts.join("\n");
      }
      const statements = splitStatements(body);
      const next = lines.slice(endLine + 1).find((l) => l.code.trim());
      p.catches.push({
        line: i, endLine, param: asName, type: ex[2].replace(/\s+as\s+\w+$/, "").trim() || null, statements,
        kind: classifyHandler(statements, { python: true }), hasComment, bare: !ex[2].trim(),
        followedByCatch: Boolean(next && leadingWidth(next.code) === indent && /^\s*except\b/.test(next.code)),
      });
    }
  });
}

/**
 * Parses one source file. Lines and line numbers are 0-based. Each function has `name`, `kind`,
 * `line`, `endLine`, `params`, `body` (lexed code) and `decorators`; each catch has its `statements`
 * and a `kind` of empty, rethrow, logOnly or handled.
 */
export function parseSource(text, language) {
  const python = ANALYZED[language].syntax === "python";
  const lines = python ? lexPython(text) : lexC(text, { backtick: isJsLike(language) });
  const src = lines.map((l) => l.code).join("\n");
  const { starts, lineOf } = lineIndex(src);
  const p = { language, lines, raw: text.split(/\r?\n/), src, starts, lineOf, functions: [], classes: [], variables: [], catches: [], tries: 0, throws: 0 };
  if (python) parsePython(p);
  else parseC(p);
  for (const fn of p.functions) {
    fn.above = commentAbove(p, fn.line);
    const counts = fn.endLine === null ? { code: 0, doc: 0 } : countBodyLines(p, (fn.bodyStart ?? fn.line) + 1, fn.endLine - (python || fn.expression ? 0 : 1));
    if (python) fn.bodyCodeLines = fn.body ? fn.body.split("\n").length : 0;
    else if (fn.expression || (fn.endLine !== null && fn.bodyStart === fn.endLine)) fn.bodyCodeLines = 1;
    else fn.bodyCodeLines = counts.code;
    fn.bodyDocLines = counts.doc;
  }
  return p;
}
