// Checks for Markdown docs: AI credits, chat-style phrases, filler wording and emoji.
// Fenced code blocks are skipped; they show code, not prose.

import { AI_MENTION, AI_SELF_TALK, EMOJI, isPlaceholder, wordingIn } from "./code.mjs";

export const isMarkdown = (file) => /\.(?:md|markdown|mdx)$/i.test(file);

export function checkMarkdown(ctx, text) {
  let fence = null;
  const emojiLines = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const marker = line.match(/^\s*(```+|~~~+)/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1].startsWith(fence[0]) && marker[1].length >= fence.length) fence = null;
      return;
    }
    if (fence || !line.trim()) return;
    const prose = line.replace(/`[^`]*`/g, "");
    // A quoted phrase ("Here is the updated code") is being talked about, not left behind.
    const unquoted = prose.replace(/"[^"]*"|“[^”]*”/g, "");
    if (AI_MENTION.test(unquoted)) ctx.add("ai-mention", i);
    else if (AI_SELF_TALK.test(unquoted)) ctx.add("ai-self-talk", i);
    const words = wordingIn(unquoted);
    if (words.length) ctx.add("ai-wording", i, { message: `Filler wording: ${words.map((w) => `"${w}"`).join(", ")}` });
    if (EMOJI.test(prose)) emojiLines.push(i);
    if (isPlaceholder(prose)) ctx.add("placeholder-todo", i);
  });
  if (emojiLines.length) {
    ctx.add("emoji", emojiLines[0], { message: emojiLines.length > 1 ? `Emoji on ${emojiLines.length} lines` : "Emoji in docs" });
  }
}
