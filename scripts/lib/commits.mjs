// Reads commit history and sorts commit messages, for the style profile and the commit checks.

import { AI_NAMES, run } from "./source.mjs";

const CONVENTIONAL_TYPES = new Set(["feat", "fix", "docs", "doc", "style", "refactor", "perf", "test", "tests", "build", "ci", "chore", "revert", "release", "deps", "wip", "hotfix"]);
const VERBS = new Set(("add fix update remove refactor change improve rename move bump use make implement support clean handle allow create delete drop replace merge revert upgrade downgrade set show return prevent avoid simplify split extract document test enable disable introduce release apply adjust correct convert ensure skip reduce increase tweak format build write check load save run sort initialize init prepare migrate configure expose hide limit include exclude restore reset deprecate rewrite optimize optimise speed cache validate parse render log raise throw catch wrap guard store fetch pass call trim tidy polish align bootstrap scaffold publish deploy install").split(" "));
const IRREGULAR_PAST = new Map([["built", "build"], ["wrote", "write"], ["made", "make"], ["ran", "run"], ["rewrote", "rewrite"]]);

export const AI_TRAILER = new RegExp(`^(?:co-authored-by|generated-by|assisted-by):.*\\b(?:${AI_NAMES})`, "im");
export const AI_GENERATED = new RegExp(`generated (?:with|by)\\b.*\\b(?:${AI_NAMES})`, "i");
export const TRAILER_LINE = /^[A-Za-z][\w-]*: .+$/;
export const BULLET = /^\s*[-*•]\s+/;

/** Verb form of a commit subject's first word: imperative, past, gerund, thirdPerson or null. */
export function verbForm(word) {
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

/** The body without trailer lines (Co-authored-by, Signed-off-by, ...). */
export const proseLines = (body) => body.split(/\r?\n/).filter((l) => l.trim() && !TRAILER_LINE.test(l.trim()));

// A project inside a larger repo only counts commits that touch its folder.
const pathspec = (dir) => (run("git", ["rev-parse", "--show-prefix"], dir)?.trim() ? ["--", "."] : []);

/**
 * Recent non-merge commits that touch `dir`, newest first. With `numstat`, each commit also
 * has `files` ([{path, added, deleted}]) and `root` (true for a commit with no parent).
 */
export function readCommits(dir, max, { numstat = false } = {}) {
  const args = ["log", "--no-merges", "-n", String(max), `--format=%x1e%h%x1f%p%x1f%an%x1f%s%x1f%b%x1f`];
  if (numstat) args.push("--numstat");
  const log = run("git", [...args, ...pathspec(dir)], dir);
  if (!log) return [];
  return log.split("\x1e").filter((c) => c.trim()).map((c) => {
    const [hash, parents, author, subject, body = "", stat = ""] = c.split("\x1f");
    const commit = { hash, author, subject: subject.trim(), body: body.trim(), root: !parents.trim() };
    if (numstat) {
      commit.files = stat.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
        const [added, deleted, ...rest] = l.split("\t");
        return { path: rest.join("\t"), added: Number(added) || 0, deleted: Number(deleted) || 0 };
      });
    }
    return commit;
  });
}

/** Total non-merge commits that touch `dir`. */
export const countCommits = (dir) => Number(run("git", ["rev-list", "--count", "--no-merges", "HEAD", ...pathspec(dir)], dir)) || 0;
