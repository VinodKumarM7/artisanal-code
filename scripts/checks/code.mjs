// Checks that look at one source file at a time: comments, catch blocks, functions, names,
// indentation and logging. Each check calls `ctx.add(ruleId, line, details)` with a 0-based line.

import { indentStats, indentSummary, isConstantName } from "../profile.mjs";
import { AI_NAMES, caseStyle, isJsLike, matchPair, paramNames, splitStatements } from "../lib/source.mjs";

export const AI_MENTION = new RegExp(
  `\\b(?:generated|written|created|authored|produced|assisted|built|made|co-?authored)\\s+(?:with|by|using|via|in)\\s+(?:the\\s+help\\s+of\\s+)?(?:an?\\s+)?(?:github\\s+)?(?:ai\\b|${AI_NAMES}|llm\\b|large language model)|\\bai[- ]generated\\b|^co-authored-by:.*\\b(?:${AI_NAMES})`,
  "i",
);
export const AI_SELF_TALK = /\b(?:as an ai\b|as a (?:large )?language model|i hope this helps|here(?:'s| is) (?:the|your) (?:updated|modified|corrected|complete|refactored|fixed|new|revised) (?:code|version|file|implementation|function)|let me know if you|feel free to (?:ask|reach out|modify)|great question|i apologi[sz]e|happy to help|you'?re (?:absolutely )?right|as (?:you )?requested|per your request|i(?:'ve| have) (?:updated|added|fixed|created|modified|refactored|changed|implemented))\b|^certainly[!,.]/i;
const AI_WORDING = /\b(?:robust(?:ly|ness)?|seamless(?:ly)?|comprehensive(?:ly)?|leverag(?:e|es|ed|ing)|delv(?:e|es|ed|ing)|utiliz(?:e|es|ed|ing|ation)|streamlin(?:e|ed|es|ing)|cutting[- ]edge|state[- ]of[- ]the[- ]art|game[- ]?chang(?:er|ing)|supercharg(?:e|ed|es|ing)|effortless(?:ly)?|meticulous(?:ly)?|tapestry|testament to|it'?s worth noting|it is worth noting|in today'?s|plays? a (?:crucial|vital|pivotal|key) role|in the realm of|navigat(?:e|ing) the complexities|unlock(?:s|ing)? the (?:power|potential)|harness(?:es|ing)? the power|best[- ]in[- ]class|world[- ]class|blazing(?:ly)?[- ]fast|rest assured|a myriad of|ever[- ]evolving|paramount|empower(?:s|ing)?|elevat(?:e|es|ing) (?:your|the))\b/gi;
export const EMOJI = /(?![©®™↔-↙↩↪])\p{Extended_Pictographic}/u;

/** Marketing and filler words found in `text`, lowercased. */
export const wordingIn = (text) => [...new Set((text.match(AI_WORDING) ?? []).map((w) => w.toLowerCase()))];

const TODO = /\b(?:TODO|FIXME|XXX|HACK)\b[:\s-]*(.*)$/;
const TODO_OWNER = /^\(|[A-Z][A-Z0-9]+-\d+|#\d+|@\w+/;
const TODO_PLACEHOLDER = /^(?:implement(?:ation|ed)?\b|add (?:error handling|validation|logic|tests?|more|code|implementation|proper)|handle (?:errors?|edge cases?|this|exceptions?)|replace (?:this|with (?:real|actual|proper))|fill (?:this )?in|finish|complete|write (?:this|tests?)|fix (?:this|later|me)|placeholder|update this|refactor this|clean (?:this )?up)/i;
const ELIDED = /^\.{3}\s*(?:rest of|existing|remaining|other|more|previous)\b|\b(?:rest of|remaining) (?:the )?(?:code|implementation|logic|methods|functions)\b|\byour (?:code|logic|implementation) here\b|\bimplementation goes here\b|\b(?:add|put|insert) (?:your )?(?:code|logic|implementation) here\b/i;

/** True when a comment is a placeholder: a bare or generic TODO, or an "... existing code ..." marker. */
export function isPlaceholder(text) {
  if (ELIDED.test(text)) return true;
  const m = text.match(TODO);
  if (!m) return false;
  const rest = m[1].trim();
  if (TODO_OWNER.test(rest)) return false;
  return !rest || TODO_PLACEHOLDER.test(rest);
}

const DIRECTIVE = /^(?:eslint|@ts-|prettier-ignore|istanbul|c8\b|noqa|type:|pylint|pyright|mypy|fmt:|isort|nosec|NOSONAR|#?region|#?endregion|-\*-|!|jshint|global\s|exported\s|<reference|@vite-ignore|webpackChunkName|language=|noinspection|artisanal-)/i;
const CODE_LINE = [
  /;\s*$/,
  /\{\s*$/,
  /^(?:export\s+)?(?:const|let|var)\s+[\w${[]+\s*(?:=|;|$)/,
  /^(?:export\s+)?(?:async\s+)?function\b.*\(/,
  /^(?:if|for|while|switch|elif)\s*\(/,
  /^(?:if|elif|for|while|else|try|except|finally|def|class|with)\b.*:$/,
  /^def\s+\w+\s*\(/,
  /^return\b.*[(){}[\];.=]/,
  /^import\s+(?:[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+)*|\{.*|\*.*|["'].*)$/,
  /^from\s+[\w.]+\s+import\s+\S/,
  /^(?:await\s+)?[\w$.]+\([^)]*\)\s*;?$/,
  /^[\w$.[\]'"]+\s*[-+*/]?=\s*[^=\s]/,
];
const CLOSING_ONLY = /^[)}\]]+[;,)]*$/;
const isCodeLike = (t) => CLOSING_ONLY.test(t) || CODE_LINE.some((re) => re.test(t));

const STOP = new Set("the a an to of and or for in on at with by from into this that these those it its is are be been was were we our you then now here there all each every some any just also new current given value values variable var function method code line next following below above do does will should can may get gets through over up out as so if else via using use".split(" "));
const SYNONYMS = {
  increment: ["++", "+="], decrement: ["--", "-="], add: ["+", "push", "append", "add"], loop: ["for", "while", "foreach", "map"],
  iterate: ["for", "while", "foreach", "map"], return: ["return"], returns: ["return"], create: ["new", "create"], initialize: ["=", "new"],
  init: ["=", "new"], set: ["=", "set"], assign: ["="], check: ["if"], call: ["("], import: ["import", "require", "from"],
  define: ["const", "let", "var", "def", "function"], declare: ["const", "let", "var"], print: ["print", "console"], log: ["log", "console", "print"],
  throw: ["throw", "raise"], raise: ["raise", "throw"], instantiate: ["new"], update: ["=", "update"], append: ["push", "append"],
  fetch: ["fetch", "get"], save: ["save", "="], store: ["="], delete: ["delete", "remove"], remove: ["delete", "remove", "pop", "splice"],
};
const stem = (w) => (w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, "") : w);
const identWords = (code) => (code.match(/[A-Za-z_$][\w$]*/g) ?? []).flatMap((id) => id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_\s$]+/)).filter(Boolean).map((w) => w.toLowerCase());

/** True when a short comment only names things the next line already says. */
export function restatesCode(comment, code) {
  const words = (comment.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length || words.length > 6 || /\d/.test(comment)) return false;
  const tokens = identWords(code);
  const stems = new Set(tokens.map(stem));
  let named = 0;
  for (const w of words) {
    if (stems.has(stem(w))) named++;
    else if (!(SYNONYMS[w] ?? []).some((s) => (/\w/.test(s) ? tokens.includes(s) : code.includes(s)))) return false;
  }
  return named > 0;
}

const GENERIC_NAMES = new Set(["data", "result", "temp", "tmp", "obj", "stuff", "thing", "things", "foo", "bar", "baz", "myvar", "mydata", "info", "val", "retval", "dummy"]);
// `result = db.execute(q)` returned on the next line is fine; a `result` carried through a function is not.
const SHORT_LIVED_OK = new Set(["data", "result", "info", "val"]);
const isGenericName = (name) => {
  const n = name.replace(/_/g, "").toLowerCase();
  return GENERIC_NAMES.has(n) || /^(?:data|result|temp|tmp|obj|item|value|val|info)\d+$/.test(n);
};

/** Lines between a variable's declaration and its last use inside the enclosing function. */
function usageSpan(parsed, v) {
  const owner = parsed.functions.filter((f) => f.line <= v.line && (f.endLine ?? -1) >= v.line).sort((a, b) => b.line - a.line)[0];
  const end = owner ? owner.endLine : Math.min(parsed.lines.length - 1, v.line + 30);
  const word = new RegExp(`(?<![\\w$.])${esc(v.name)}(?![\\w$])`);
  let last = v.line;
  for (let i = v.line + 1; i <= end; i++) if (word.test(parsed.lines[i].code)) last = i;
  return last - v.line;
}
const VAGUE_FUNCTION = /^(?:handle|process|do|manage|perform|execute|run)(?:data|info|item|items|stuff|thing|things|it|logic|task|tasks|work|input|output|all|everything|object|value|values)$/;
const DUMPING_GROUND = new Set(["utils", "util", "helpers", "helper", "misc", "common", "functions", "stuff", "tools", "utilities"]);
// "This hook ..." talks about the code itself; "The hook settings ..." names a domain thing.
const THIS_FUNCTION = /^this\s+(?:function|method|class|helper|utility|util|component|module|hook|routine|procedure)\b|^the\s+(?:function|method|helper|utility|routine|procedure)\s+(?:that|which|to|will|is|does|takes|returns)\b|^(?:a\s+)?(?:simple\s+|small\s+)?(?:helper|utility)\s+(?:function|method)\b|^(?:function|method)\s+(?:to|that|which|for)\b/i;
const CONFIG_NAME = /config|options|settings|defaults/i;
const STUB_ERROR = /\bthrow\s+new\s+(?:\w*Error|\w*Exception)\s*\(\s*["'`]\s*(?:not (?:yet )?implemented|todo|implement me|stub)/i;
const BANNER = /^(?:\/\/+|#+|\/\*+|\*+|--)\s*.*?([=\-*#~_+])\1{3,}/;
const STYLE_CONFLICT = { camelCase: ["snake_case"], snake_case: ["camelCase"] };

const esc = (s) => s.replace(/[$.*+?^()[\]{}|\\]/g, "\\$&");

/** The dominant style for a kind of name, when the profile is confident enough to enforce it. */
function enforcedStyle(langProfile, kind, minCount) {
  const n = langProfile?.naming?.[kind];
  if (!n || n.share < 0.8) return null;
  const counted = Object.entries(n.counts).filter(([k]) => k !== "lowercase").reduce((a, [, v]) => a + v, 0);
  return counted >= minCount ? n : null;
}

function commentChecks(ctx) {
  const { lines, raw } = ctx.parsed;
  let codeLines = 0;
  for (const l of lines) if (l.code.trim()) codeLines++;
  let run = [];
  const flushRun = () => {
    if (run.length >= 2 || (run.length === 1 && !CLOSING_ONLY.test(lines[run[0]].text))) {
      ctx.add("commented-out-code", run[0], { endLine: run[run.length - 1], message: run.length > 1 ? `${run.length} lines of commented-out code` : "Commented-out line of code" });
    }
    run = [];
  };

  lines.forEach((l, i) => {
    const hasComment = l.comment || l.doc;
    const text = l.text;
    const commentOnly = hasComment && !l.code.trim();
    if (hasComment && text) {
      // A quoted phrase is being talked about, not left behind.
      const unquoted = text.replace(/"[^"]*"|“[^”]*”/g, "");
      if (AI_MENTION.test(unquoted)) ctx.add("ai-mention", i);
      else if (AI_SELF_TALK.test(unquoted)) ctx.add("ai-self-talk", i);
      const words = wordingIn(unquoted);
      if (words.length) ctx.add("ai-wording", i, { message: `Filler wording: ${words.map((w) => `"${w}"`).join(", ")}` });
      if (EMOJI.test(text)) ctx.add("emoji", i);
      if (isPlaceholder(text)) ctx.add("placeholder-todo", i);
    }
    if (!hasComment && /\bconsole\.\w+\s*\(|\bprint\s*\(|System\.debug|\blog(?:ger)?\.\w+\s*\(/.test(l.code) && EMOJI.test(raw[i] ?? "")) {
      ctx.add("emoji", i, { message: "Emoji in a log message" });
    }

    if (commentOnly && l.comment && !l.doc && text && !DIRECTIVE.test(text) && isCodeLike(text)) {
      if (run.length && run[run.length - 1] !== i - 1) flushRun();
      run.push(i);
    } else if (!(commentOnly && !text)) flushRun();

    if (commentOnly && codeLines < 200 && BANNER.test((raw[i] ?? "").trim())) ctx.add("section-banner", i);

    if (commentOnly && l.comment && !l.doc && text && !isCodeLike(text) && !BANNER.test((raw[i] ?? "").trim())) {
      const next = lines[i + 1];
      if (next && next.code.trim() && !(lines[i - 1]?.comment && !lines[i - 1].code.trim()) && restatesCode(text, next.code)) {
        ctx.add("comment-restates-code", i);
      }
    }
  });
  flushRun();
}

function catchChecks(ctx) {
  const lp = ctx.langProfile;
  const bodies = lp?.errorHandling?.catchBodies;
  const blocks = lp?.errorHandling?.catchBlocks ?? 0;
  const logOnlyIsNorm = bodies && blocks >= 6 && bodies.logOnly / blocks >= 0.5;
  const python = ctx.language === "python";
  for (const c of ctx.parsed.catches) {
    if (c.kind === "rethrow" && c.statements.length === 1 && !c.followedByCatch) {
      const same = python
        ? new RegExp(`^raise(?:\\s+${c.param ? esc(c.param) : "\\b"})?\\s*$`).test(c.statements[0])
        : c.param && new RegExp(`^throw\\s+${esc(c.param)}\\s*;?$`).test(c.statements[0]);
      if (same) ctx.add("catch-rethrow-only", c.line);
    }
    if (c.kind === "empty" && !c.hasComment) ctx.add("empty-catch", c.line);
    if (c.kind === "logOnly" && !logOnlyIsNorm && !c.followedByCatch) ctx.add("catch-log-only", c.line);
    const catchesAll = python ? c.bare || /^(?:BaseException)$/.test(c.type ?? "") : /^(?:Throwable|java\.lang\.Throwable)$/.test(c.type ?? "");
    if (catchesAll && c.kind !== "rethrow") ctx.add("catch-all", c.line, { message: python && c.bare ? "Bare `except:` catches everything, including KeyboardInterrupt" : undefined });
  }
}

function variableChecks(ctx) {
  const { lines, variables, raw } = ctx.parsed;
  const python = ctx.language === "python";
  const varStyle = enforcedStyle(ctx.langProfile, "variables", 8);
  for (const v of variables) {
    const value = v.value ?? "";
    const isObject = /^new\s+[A-Z_$]/.test(value) || /^[[{]/.test(value) || (python && /^(?:[A-Z]\w*|dict|list|set)\(/.test(value));
    const fresh = isObject || /^["'`]/.test(value) || /^-?\d/.test(value);
    if (fresh) {
      const n = esc(v.name);
      const nullCheck = python
        ? new RegExp(`\\b${n}\\s+is\\s+(?:not\\s+)?None\\b`)
        : new RegExp(`(?<![\\w$.])${n}\\s*[!=]==?\\s*(?:null|undefined)\\b|\\b(?:null|undefined)\\s*[!=]==?\\s*${n}(?![\\w$])|typeof\\s+${n}\\s*[!=]==?${isObject ? `|if\\s*\\(\\s*!\\s*${n}\\s*\\)` : ""}`);
      const reassigned = new RegExp(`(?<![\\w$.])${n}\\s*=[^=]`);
      let seen = 0;
      for (let i = v.line + 1; i < lines.length && seen < 3; i++) {
        const code = lines[i].code;
        if (!code.trim()) continue;
        seen++;
        if (reassigned.test(code)) break;
        if (nullCheck.test(code)) {
          ctx.add("null-check-on-fresh-value", i, { message: `\`${v.name}\` was just set to a ${isObject ? "new object" : "literal"} and cannot be null here` });
          break;
        }
      }
    }
    const genericAndLongLived = isGenericName(v.name) && (!SHORT_LIVED_OK.has(v.name.toLowerCase()) || usageSpan(ctx.parsed, v) >= 4);
    if (!ctx.isTest && genericAndLongLived) ctx.add("generic-name", v.line, { message: `\`${v.name}\` says nothing about what it holds` });
    if (isJsLike(ctx.language) && v.topLevel && !v.exported && value.startsWith("{") && CONFIG_NAME.test(v.name)) {
      const uses = raw.filter((r, i) => lines[i]?.code.trim() && new RegExp(`(?<![\\w$])${esc(v.name)}(?![\\w$])`).test(r)).length;
      if (uses <= 2) ctx.add("single-use-config", v.line, { message: `\`${v.name}\` is defined for a single use` });
    }
    if (varStyle && !isConstantName(v.name) && STYLE_CONFLICT[varStyle.dominant]?.includes(caseStyle(v.name))) {
      ctx.add("naming-style-mismatch", v.line, { message: `Variable \`${v.name}\` is ${caseStyle(v.name)}; ${Math.round(varStyle.share * 100)}% of this project's ${ctx.language} variables are ${varStyle.dominant}` });
    }
  }
}

/** True when `fn` only calls another function with its own parameters, in the same order. */
export function isForwarding(fn, language) {
  if (!fn.body || fn.decorators.length) return false;
  const statements = splitStatements(fn.body);
  if (statements.length !== 1) return false;
  const stmt = statements[0].replace(/^return\s+/, "").replace(/^await\s+/, "").replace(/;$/, "").trim();
  const m = stmt.match(/^([A-Za-z_$][\w$.]*)\s*(?:<[^>()]*>)?\s*\(/);
  // Only plain function names: method calls and constructors usually add something (a bound object, a new instance).
  if (!m || m[1].includes(".") || /^[A-Z]/.test(m[1]) || m[1] === fn.name) return false;
  if (/\bDepends\s*\(/.test(fn.params ?? "")) return false; // FastAPI dependency providers
  const open = m[0].length - 1;
  if (matchPair(stmt, open) !== stmt.length - 1) return false;
  const args = splitStatements(stmt.slice(open + 1, -1).replace(/,/g, ";"));
  const params = paramNames(fn.params, language);
  return args.length === params.length && args.every((a, i) => a === params[i]);
}

function functionChecks(ctx) {
  const { parsed, language } = ctx;
  const python = language === "python";
  const lp = ctx.langProfile;
  const docHeavy = lp && lp.codeLines && lp.comments.docLines / lp.codeLines >= 0.2;
  const fnStyle = enforcedStyle(lp, "functions", 8);
  for (const fn of parsed.functions) {
    if (fn.kind === "constructor") continue;
    const topLevel = !/^\s/.test(parsed.lines[fn.line].code);
    const plain = topLevel && (python ? fn.kind === "function" : fn.kind === "function" || fn.kind === "arrow");
    if (plain && isForwarding(fn, language)) ctx.add("forwarding-wrapper", fn.line, { message: `\`${fn.name}\` only passes its arguments on to another function` });

    const docLines = fn.above?.doc ? fn.above.end - fn.above.start + 1 : python ? fn.bodyDocLines : 0;
    if (!docHeavy && docLines >= 5 && docLines > 2 * Math.max(1, fn.bodyCodeLines)) {
      ctx.add("doc-longer-than-code", fn.above?.doc ? fn.above.start : fn.line, { message: `${docLines} doc lines for a ${fn.bodyCodeLines}-line body` });
    }
    const docText = fn.above?.text ?? (python ? parsed.lines.slice(fn.line + 1, (fn.endLine ?? fn.line) + 1).filter((l) => l.doc).map((l) => l.text).join(" ").trim() : "");
    if (docText && THIS_FUNCTION.test(docText) && fn.bodyCodeLines <= 5) ctx.add("this-function-comment", fn.above ? fn.above.start : fn.line + 1);

    if (VAGUE_FUNCTION.test(fn.name.replace(/_/g, "").toLowerCase())) ctx.add("vague-function-name", fn.line, { message: `\`${fn.name}\` does not say what it does` });

    if (fn.body !== null) {
      const statements = splitStatements(fn.body);
      const rawBody = parsed.raw.slice(fn.line, (fn.endLine ?? fn.line) + 1).join("\n");
      const abstract = fn.decorators.some((d) => /abstractmethod|overload/.test(d)) || isInAbstractClass(parsed, fn);
      let stub = false;
      if (statements.length === 1 && /^throw\b/.test(statements[0]) && STUB_ERROR.test(rawBody)) stub = true;
      // "Groq does not provide embeddings" is an answer, not a stub.
      const unsupported = /not (?:support|provide|available)|unsupported|does not|doesn't|cannot|can't/i.test(rawBody);
      if (python && !abstract && !unsupported && statements.length === 1 && /^raise\s+NotImplementedError\b/.test(statements[0])) stub = true;
      if (python && !abstract && fn.kind === "function" && statements.length && statements.every((s) => s === "pass" || s === "...")) stub = true;
      if (stub) ctx.add("not-implemented-stub", fn.line, { message: `\`${fn.name}\` is a stub` });
    }

    // JavaScript methods often carry outside names (protocol handlers, JSON keys), so only plain functions count.
    const externalName = isJsLike(language) && fn.kind === "method";
    if (fnStyle && !externalName && !(python && /^__\w+__$/.test(fn.name)) && STYLE_CONFLICT[fnStyle.dominant]?.includes(caseStyle(fn.name))) {
      ctx.add("naming-style-mismatch", fn.line, { message: `Function \`${fn.name}\` is ${caseStyle(fn.name)}; ${Math.round(fnStyle.share * 100)}% of this project's ${language} functions are ${fnStyle.dominant}` });
    }
  }
}

function isInAbstractClass(parsed, fn) {
  return parsed.classes.some((c) => c.line < fn.line && (c.endLine ?? Infinity) >= fn.line && /\b(?:ABC|ABCMeta|Protocol)\b/.test(c.extends ?? ""));
}

function classChecks(ctx) {
  const { parsed } = ctx;
  for (const c of parsed.classes) {
    if (c.kind !== "class" || !/Factory$/.test(c.name) || c.endLine === null) continue;
    const methods = parsed.functions.filter((f) => f.line > c.line && f.line <= c.endLine && f.kind !== "constructor" && f.name !== "__init__");
    if (methods.length !== 1 || !methods[0].body) continue;
    const body = methods[0].body;
    const builds = /\bnew\s+[A-Z]/.test(body) || (ctx.language === "python" && /\breturn\s+[A-Z]\w*\(/.test(body));
    if (builds && !/\b(?:if|switch|when|case|match|elif)\b|\?/.test(body)) ctx.add("single-product-factory", c.line, { message: `\`${c.name}\` has one method that always builds the same thing` });
  }
}

const isDebugLike = (args) => !/["'`]/.test(args) || /\b(?:debug|here|test(?:ing)?|got|xxx|todo|wtf|hmm|inside|reached|called)\b|!!!|>>>|-->|={3,}/i.test(args) || /^\s*["'][\w\s.-]*:\s*["']\s*,/.test(args);

function loggingChecks(ctx) {
  const { lines, raw } = ctx.parsed;
  const { language, isTest, isCli } = ctx;
  lines.forEach((l, i) => {
    const code = l.code;
    if (!code.trim()) return;
    if (isJsLike(language)) {
      if (/(?<![\w$.])debugger\s*;?/.test(code) && /^\s*debugger\b/.test(code)) ctx.add("debug-logging", i, { message: "`debugger` statement" });
      if (isTest || isCli) return;
      if (/\bconsole\.(?:debug|trace|dir|table)\s*\(/.test(code)) ctx.add("debug-logging", i);
      else if (/\bconsole\.log\s*\(/.test(code)) {
        const args = (raw[i] ?? "").split(/console\.log\s*\(/)[1] ?? "";
        if (isDebugLike(args)) ctx.add("debug-logging", i);
      }
    } else if (language === "python") {
      if (/\bbreakpoint\s*\(\s*\)|\bpdb\.set_trace\s*\(|^\s*import\s+pdb\b/.test(code)) ctx.add("debug-logging", i, { message: "Debugger call left in the code" });
      else if (!isTest && !isCli && /(?<![\w.])print\s*\(/.test(code)) ctx.add("debug-logging", i, { message: "`print` in library code" });
    } else if (language === "apex") {
      if (!isTest && /\bSystem\.debug\s*\(/i.test(code)) ctx.add("debug-logging", i);
    } else if (language === "java") {
      if (!isTest && !isCli && /\bSystem\.(?:out|err)\.print|\.printStackTrace\s*\(\s*\)/.test(code)) ctx.add("debug-logging", i);
    }
  });
}

function fileChecks(ctx) {
  const { parsed, language, file } = ctx;
  const lp = ctx.langProfile;
  const base = file.split("/").pop().split(".")[0];

  const topLevel = parsed.functions.filter((f) => f.kind !== "nested" && f.kind !== "constructor");
  if (!ctx.isTest && DUMPING_GROUND.has(base.toLowerCase()) && topLevel.length >= 6) {
    ctx.add("dumping-ground-file", 0, { evidence: file, message: `${file} collects ${topLevel.length} functions under a generic name` });
  }

  const fileStyle = !ctx.isTest && enforcedStyle(lp, "files", 5);
  if (fileStyle) {
    const style = caseStyle(base);
    const ignorable = [null, "lowercase", "mixed", "UPPERCASE", fileStyle.dominant];
    if (!ignorable.includes(style) && !(isJsLike(language) && style === "PascalCase") && !(language === "python" && /^__\w+__$/.test(base))) {
      ctx.add("file-name-style-mismatch", 0, { evidence: file, message: `${base} is ${style}; ${Math.round(fileStyle.share * 100)}% of this project's ${language} file names are ${fileStyle.dominant}` });
    }
  }

  const projectIndent = lp?.indentation;
  if (projectIndent && projectIndent.consistency >= 0.9) {
    const own = indentStats(parsed.lines);
    const mine = indentSummary(own);
    const firstIndented = parsed.lines.findIndex((l) => l.code.trim() && /^[ \t]/.test(l.code));
    if (mine && firstIndented >= 0) {
      if (projectIndent.style !== mine.style && own.tabs + own.spaces >= 5) {
        ctx.add("indentation-mismatch", firstIndented, { message: `Indented with ${mine.style}; the project uses ${projectIndent.style}` });
      } else if (mine.style === "spaces" && projectIndent.style === "spaces" && projectIndent.size && mine.size && mine.size !== projectIndent.size && own.spaces >= 8) {
        ctx.add("indentation-mismatch", firstIndented, { message: `Indented with ${mine.size} spaces; the project uses ${projectIndent.size}` });
      }
    }
  }
}

/** Runs every per-file check on one parsed source file. */
export function checkSource(ctx) {
  commentChecks(ctx);
  catchChecks(ctx);
  variableChecks(ctx);
  functionChecks(ctx);
  classChecks(ctx);
  loggingChecks(ctx);
  fileChecks(ctx);
}
