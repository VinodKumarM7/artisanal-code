// Checks that need the whole project: AI tool files in git, files nothing refers to, scratch
// and backup files, and interfaces with a single implementation.
//
// A file counts as referenced when another file imports it (JavaScript, TypeScript, Python),
// names its class (Apex, Java), or mentions its file name or path (package.json scripts, CI
// files, Makefiles, docs, other code). Test files, framework entry points and files listed in
// package.json are always in use.

import path from "node:path";
import { TEST_DIR, isJsLike } from "../lib/source.mjs";

const posix = path.posix;

// ---- AI tool files.

const AI_TOOL_FILES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "GEMINI.md", ".cursorrules", ".windsurfrules", ".clinerules", ".aiderignore"]);
const AI_TOOL_DIRS = new Set([".claude", ".cursor", ".windsurf", ".continue", ".roo", ".clinerules"]);

/** The AI tool file or folder a path belongs to (`.claude/` for `.claude/settings.json`), or null. */
export function aiToolEntry(file) {
  const parts = file.split("/");
  const dirIdx = parts.findIndex((p, i) => i < parts.length - 1 && (AI_TOOL_DIRS.has(p) || /^\.aider/.test(p)));
  if (dirIdx >= 0) return `${parts.slice(0, dirIdx + 1).join("/")}/`;
  const base = parts[parts.length - 1];
  if (AI_TOOL_FILES.has(base) || /^\.aider/.test(base)) return file;
  if (/(^|\/)\.github\/(?:copilot-instructions\.md|instructions\/[^/]+\.instructions\.md)$/.test(file)) return file;
  return null;
}

export function checkAiToolFiles(ctx) {
  if (!ctx.tracked) return;
  const entries = new Map();
  for (const file of ctx.listed) {
    const entry = aiToolEntry(file);
    if (!entry) continue;
    const e = entries.get(entry) ?? { tracked: 0, untracked: 0, first: file };
    if (ctx.tracked.has(file)) e.tracked++;
    else e.untracked++;
    entries.set(entry, e);
  }
  for (const [entry, e] of entries) {
    const count = e.tracked + e.untracked;
    const what = entry.endsWith("/") ? `${entry} (${count} file${count === 1 ? "" : "s"})` : entry;
    const message = e.tracked ? `${what} is tracked in git` : `${what} is not in .gitignore and would be committed by \`git add\``;
    ctx.add("ai-tool-file-tracked", e.first, null, { evidence: entry, message });
  }
}

// ---- References.

const JS_EXTS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"];
const JS_IMPORTS = [
  /\bimport\s+(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+[^'";]*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bnew\s+(?:URL|Worker)\(\s*["']([^"']+)["']/g,
];
const ALIAS = /^(?:@\/|~\/|#\/?|\$lib\/|src\/)/;

const ENTRY_PATHS = [
  /(^|\/)[\w.-]*\.config\.[cm]?[jt]s$/,
  /(^|\/)\.[\w-]+rc\.[cm]?[jt]s$/,
  /(^|\/)(?:gulpfile|gruntfile|jakefile)\.[cm]?[jt]s$/i,
  /\.(?:stories|story)\.[cm]?[jt]sx?$/,
  /^(?:index|main|app|server|cli)\.[cm]?[jt]sx?$/,
  /(^|\/)src\/(?:index|main|app|server|cli)\.[cm]?[jt]sx?$/,
  /(^|\/)(?:pages|app|routes|api)\/.*\.[cm]?[jt]sx?$/,
  /(^|\/)(?:lwc|aura)\//,
  /(^|\/)(?:__init__|__main__|setup|manage|conftest|wsgi|asgi|noxfile|fabfile|tasks)\.py$/,
  /^(?:app|main|run|server|cli)\.py$/,
  /(^|\/)migrations\//,
  /(^|\/)(?:module|package)-info\.java$/,
  /\.trigger$/,
];
const APEX_ENTRY = /@(?:RestResource|AuraEnabled|InvocableMethod|InvocableVariable|RemoteAction|HttpGet|HttpPost|ReadOnly)\b|\bglobal\s+(?:with|without|inherited|class|abstract|virtual)\b|\bimplements\b[^{]*\b(?:Schedulable|Batchable|Queueable|InboundEmailHandler|Process\.Plugin|Auth\.\w+)/i;
const JAVA_ENTRY = /\bstatic\s+void\s+main\s*\(|@(?:SpringBootApplication|RestController|Controller|Service|Component|Repository|Configuration|Entity|WebServlet|Mapper|WebFilter)\b/;

const SCRATCH_NAME = /^(?:scratch|scratchpad|temp|tmp|debug|playground|sandbox|untitled|foo|bar|test|tests|try|testing|experiment|demo|quick|fix|verify|repro|reproduce|poc|check)(?:[-_.][\w.-]*)?$/i;
const BACKUP_FILE = /(?:\.(?:bak|orig|old|swp)|~)$|[-_ ](?:old|backup|copy|bak)\.\w+$|\scopy(?:\s\d+)?\.\w+$/i;

const withoutExt = (file) => file.replace(/\.[^./]+$/, "");

function resolveJs(from, spec, files, byStem) {
  if (spec.startsWith(".")) {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    const tries = [base, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => `${base}/index${e}`)];
    if (/\.[cm]?jsx?$/.test(base)) tries.push(...[".ts", ".tsx", ".mts", ".cts"].map((e) => base.replace(/\.[cm]?jsx?$/, e)));
    return tries.filter((t) => files.has(t));
  }
  const rest = spec.replace(ALIAS, "");
  if (rest === spec && !spec.includes("/")) return [];
  const found = [];
  for (const [stem, list] of byStem) {
    if (stem === rest || stem.endsWith(`/${rest}`) || stem === `${rest}/index` || stem.endsWith(`/${rest}/index`)) found.push(...list);
  }
  return found;
}

function resolvePython(from, modules, byStem) {
  const found = [];
  for (const mod of modules) {
    const dots = mod.match(/^\.*/)[0].length;
    let rel = mod.slice(dots).replace(/\./g, "/");
    if (dots) {
      let dir = posix.dirname(from);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      rel = posix.normalize(rel ? posix.join(dir, rel) : dir);
    }
    for (const [stem, list] of byStem) {
      if (!list[0].endsWith(".py")) continue;
      const matches = dots ? stem === rel || stem === `${rel}/__init__` : stem === rel || stem.endsWith(`/${rel}`) || stem === `${rel}/__init__` || stem.endsWith(`/${rel}/__init__`);
      if (matches) found.push(...list);
    }
  }
  return found;
}

function pythonImports(src) {
  const modules = [];
  for (const m of src.matchAll(/^[ \t]*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm)) {
    for (const part of m[1].split(",")) modules.push(part.trim().split(/\s+/)[0]);
  }
  for (const m of src.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(?:\(([^)]*)\)|([\w \t,*]+))/gm)) {
    const base = m[1];
    modules.push(base);
    for (const name of (m[2] ?? m[3]).split(",").map((s) => s.trim().split(/\s+/)[0]).filter((s) => s && s !== "*")) {
      modules.push(base.endsWith(".") ? `${base}${name}` : `${base}.${name}`);
    }
  }
  return modules.filter((m) => m && m !== ".");
}

function packageEntries(pkg) {
  const out = new Set();
  const addValue = (v) => {
    if (typeof v === "string") out.add(posix.normalize(v.replace(/^\.\//, "")));
    else if (v && typeof v === "object") Object.values(v).forEach(addValue);
  };
  if (pkg) for (const key of ["main", "module", "browser", "bin", "exports", "types", "typings"]) addValue(pkg[key]);
  return out;
}

/** Builds who-refers-to-what for the project's files. */
function buildReferences(ctx) {
  const files = new Set(ctx.listed);
  const byStem = new Map();
  for (const f of ctx.listed) {
    if (!/\.(?:[cm]?[jt]sx?|py)$/.test(f)) continue;
    const stem = withoutExt(f);
    byStem.set(stem, [...(byStem.get(stem) ?? []), f]);
  }
  const importedBy = new Map();
  const link = (target, from) => {
    if (target === from) return;
    if (!importedBy.has(target)) importedBy.set(target, new Set());
    importedBy.get(target).add(from);
  };
  for (const s of ctx.sources) {
    if (isJsLike(s.language)) {
      const code = s.parsed.raw.filter((_, i) => s.parsed.lines[i]?.code.trim()).join("\n");
      for (const re of JS_IMPORTS) for (const m of code.matchAll(re)) for (const t of resolveJs(s.file, m[1], files, byStem)) link(t, s.file);
    } else if (s.language === "python") {
      for (const t of resolvePython(s.file, pythonImports(s.parsed.src), byStem)) link(t, s.file);
    }
  }
  // Words and file names mentioned anywhere, and by which files.
  const mentions = new Map();
  for (const [file, text] of ctx.texts) {
    for (const token of new Set(text.match(/[\w.@$/-]+/g) ?? [])) {
      for (const key of new Set([token, token.split("/").pop(), ...(token.match(/[A-Za-z_]\w*/g) ?? [])])) {
        if (!mentions.has(key)) mentions.set(key, new Set());
        mentions.get(key).add(file);
      }
    }
  }
  const mentionedElsewhere = (key, self) => [...(mentions.get(key) ?? [])].some((f) => f !== self);
  return { importedBy, mentionedElsewhere };
}

export function checkReferences(ctx) {
  const refs = buildReferences(ctx);
  const entries = packageEntries(ctx.packageJson);
  const separateTests = ctx.profile?.tests?.layout === "separate";

  for (const file of ctx.listed) {
    const base = file.split("/").pop();
    if (BACKUP_FILE.test(base)) ctx.add("scratch-file", file, null, { evidence: file, message: `${file} looks like a backup copy` });
  }

  for (const s of ctx.sources) {
    const { file, language, text } = s;
    const base = file.split("/").pop();
    const stem = base.replace(/\.[^.]+$/, "");
    if (BACKUP_FILE.test(base)) continue;
    if (s.isTest) {
      if (separateTests && !TEST_DIR.test(file) && /(^|\/)test_[^/]*\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) {
        ctx.add("scratch-file", file, null, { evidence: file, message: `${file} is a test file outside the project's test folders` });
      }
      continue;
    }
    if (ENTRY_PATHS.some((re) => re.test(file)) || entries.has(file)) continue;
    if (language === "apex" && APEX_ENTRY.test(text)) continue;
    if (language === "java" && JAVA_ENTRY.test(text)) continue;

    let used = refs.importedBy.has(file) || refs.mentionedElsewhere(base, file) || refs.mentionedElsewhere(file, file);
    if (!used && (language === "apex" || language === "java")) used = refs.mentionedElsewhere(stem, file);
    if (!used && language === "python") {
      const dotted = withoutExt(file).replace(/\//g, ".");
      used = refs.mentionedElsewhere(dotted, file);
    }
    if (used) continue;
    if (SCRATCH_NAME.test(stem)) ctx.add("scratch-file", file, null, { evidence: file, message: `${file} looks like a scratch or one-off script and nothing refers to it` });
    else ctx.add("unreferenced-file", file, null, { evidence: file, message: `Nothing imports, runs or mentions ${file}` });
  }
}

// ---- Interfaces with one implementation.

export function checkInterfaces(ctx) {
  const interfaces = [];
  const implementers = new Map();
  const extended = new Set();
  for (const s of ctx.sources) {
    if (!["java", "apex", "typescript"].includes(s.language)) continue;
    for (const c of s.parsed.classes) {
      if (c.kind === "interface") {
        interfaces.push({ ...c, file: s.file });
        if (c.extends) extended.add(c.extends.split(".").pop());
      }
      for (const name of c.implements) {
        const short = name.split(".").pop();
        implementers.set(short, [...(implementers.get(short) ?? []), `${c.name} (${s.file})`]);
      }
    }
  }
  for (const i of interfaces) {
    const impls = implementers.get(i.name) ?? [];
    if (impls.length === 1 && !extended.has(i.name)) {
      ctx.add("single-implementation-interface", i.file, i.line, { message: `\`${i.name}\` has one implementation: ${impls[0]}` });
    }
  }
}
