// Checks on recent commit messages and sizes. Findings point at a commit, not a file.

import { AI_GENERATED, AI_TRAILER, BULLET, classifySubject, proseLines } from "../lib/commits.mjs";
import { EMOJI, wordingIn } from "./code.mjs";

const HEADING = /^#{1,3}\s+\S/;
const BOLD_BULLET = /^\s*[-*]\s+\*\*[^*]+\*\*/;
const SECTION_LABEL = /^(?:summary|changes|test plan|testing|motivation|context|details|overview|key changes)\s*:?\s*$/i;

/** Why a commit body reads like a generated report, or null. */
export function templatedReason(body) {
  const prose = proseLines(body);
  const headings = prose.filter((l) => HEADING.test(l)).length;
  const bold = prose.filter((l) => BOLD_BULLET.test(l)).length;
  const bullets = prose.filter((l) => BULLET.test(l)).length;
  const labels = prose.filter((l) => SECTION_LABEL.test(l.replace(/^#+\s*/, "").trim())).length;
  if (headings) return "Markdown headings in the body";
  if (bold >= 2) return "bold-labelled bullets";
  if (labels >= 2) return "report-style sections";
  if (bullets >= 6) return `${bullets} bullet points`;
  return null;
}

export function checkCommits(ctx, commits) {
  const format = ctx.profile?.commits?.format;
  const enforceFormat = format && format.share >= 0.8 && (ctx.profile.commits.analyzed ?? 0) >= 10 ? format.dominant : null;

  for (const c of commits) {
    const lines = c.body.split(/\r?\n/);
    const trailer = lines.find((l) => AI_TRAILER.test(l));
    if (trailer) ctx.addCommit("ai-commit-trailer", c, { evidence: trailer.trim() });
    const generated = [c.subject, ...lines].find((l) => AI_GENERATED.test(l));
    if (generated) ctx.addCommit("ai-commit-mention", c, { evidence: generated.trim() });

    const reason = templatedReason(c.body);
    if (reason) ctx.addCommit("templated-commit-message", c, { message: `Commit message laid out like a generated report: ${reason}` });

    if (EMOJI.test(c.subject)) ctx.addCommit("emoji", c, { message: "Emoji in a commit subject" });
    const words = wordingIn([c.subject, ...proseLines(c.body)].join("\n"));
    if (words.length) ctx.addCommit("ai-wording", c, { message: `Filler wording in a commit message: ${words.map((w) => `"${w}"`).join(", ")}` });

    if (!c.root && c.files) {
      const changed = c.files.reduce((n, f) => n + f.added + f.deleted, 0);
      const areas = new Set(c.files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : ".")));
      if ((c.files.length >= 30 || changed >= 1500) && areas.size >= 3) {
        ctx.addCommit("large-mixed-commit", c, { message: `${c.files.length} files and ${changed} lines across ${areas.size} areas in one commit` });
      }
    }

    if (enforceFormat && !c.root && !/^(?:Merge|Revert ")/.test(c.subject)) {
      const own = classifySubject(c.subject).format;
      if (own !== enforceFormat) ctx.addCommit("commit-format-mismatch", c, { message: `${own} subject; ${Math.round(format.share * 100)}% of recent commits use ${enforceFormat} format` });
    }
  }
}
