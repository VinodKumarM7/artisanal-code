# Artisanal

Makes AI-assisted code read like a careful developer on your team wrote it.

Artisanal is a plugin for Claude Code (and other agents that read `SKILL.md` skills). It finds AI traces, leftover scripts and over-engineered code with deterministic checks, then has the agent propose small, behavior-preserving edits that follow your project's own conventions. Every change is shown before it is applied, on a new branch, so it can be reviewed and undone.

> Status: **Phase 5** (commit style). All cleanup skills are available; hooks, the report and the install script for other agents come next.

## What it will do

| Area | Examples |
|---|---|
| AI traces | AI co-author trailers, "Generated with ..." lines, AI tool files (`CLAUDE.md`, `.cursor/`, ...) tracked in git |
| Leftovers | Unreferenced scripts, debug and scratch files, commented-out code, debug logging |
| Simplicity | Single-use interfaces and factories, forwarding wrappers, defensive try/catch, generic names |
| Your style | Naming, comments, error handling and commit messages learned from your repo |

## Install (Claude Code)

```
/plugin marketplace add VinodKumarM7/artisanal-code
/plugin install artisanal-code@artisanal-code
```

Then ask:

- "Check my Artisanal setup"
- "Remove AI traces from this repo": lists AI tool files to untrack (kept locally) and AI credit lines to remove, then applies the ones you approve on a new branch
- "Clean up leftovers": lists unused files, scratch scripts, commented-out code and debug logging, deletions first
- "Simplify this code": over-engineering, needless try/catch, wrappers and unclear names, one approved change at a time, behavior unchanged
- "Humanize the docs": comment noise, filler wording and emoji in comments and docs, every fact kept
- "Commit my changes": splits the work into focused commits with messages in your repo's own format, never with AI trailers
- "Learn my project's coding style": writes `.artisanal/profile.json` (naming, comments, function length, error handling, tests, commit format). Add `.artisanal/` to your `.gitignore`.

## Requirements

Node.js 20+ and Git. No other dependencies.

## Development

```
npm test                    # unit tests, no dependencies
npm run profile -- <dir>    # print a project's style profile
npm run check -- <dir>      # run the checks and list findings with file, line and evidence
npm run fix -- plan <dir> --scope traces|leftovers|simplify|docs   # list proposed cleanups (changes nothing)
npm run commit-plan -- plan <dir>                  # group staged changes into commits, show the commit style
claude plugin validate .    # plugin and marketplace manifests
```

## License

MIT
