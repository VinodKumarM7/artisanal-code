# Changelog

## 0.1.0 (2026-11-12)

First release: seven skills, the `/tidy` and `/tidy-check` commands and an optional edit hook.

- Phase 7 release: `scripts/install.mjs` installs the skills for Codex, Cursor, Claude Code without plugins, or any folder of `SKILL.md` skills; `check.mjs --fail-on` for CI; CI on Linux and Windows with Node 20 and 22; a sample report in `docs/sample-report/`; README rewritten.
- Phase 6 hook and report: `/tidy` and `/tidy-check` commands; `scripts/report.mjs` writes Markdown and HTML reports with a documented cleanliness score; an optional PostToolUse hook (`hooks/check-edit.mjs`, off until enabled per project) tells the agent about new findings in each file it edits.
- Phase 5 commit style: `commit-style` skill and `scripts/commit-plan.mjs`, which groups changes into focused commits (AI tool files, removals, each area with its tests, config, docs), learns the commit format from history, lints draft messages (AI trailers and "Generated with" lines are refused) and commits one approved group at a time as the user.
- Phase 4 simplify and humanize: `simplify-review` and `humanize-docs` skills, `references/patterns-by-language.md`, and `fix.mjs` scopes `simplify` and `docs`. Mechanical edits (unwrapping a try/catch that only rethrows, removing impossible null checks, deleting comments that repeat the code and banners, stripping emoji) are applied after approval; everything else is a rewrite proposed one change at a time with its code context. `fix.mjs start` prepares the branch for hand edits.
- Phase 3 cleanups: `clean-traces` and `remove-leftovers` skills on top of `scripts/fix.mjs`, which plans numbered actions with previews and applies only approved ids on an `artisanal/<skill>-<date>` branch in a clean tree. AI tool files are untracked and added to `.gitignore` but kept on disk; untracked files, history and risky edits are left to a person.
- Phase 2 checks: `scripts/check.mjs` runs 35 rules (AI traces, comment noise, defensive bloat, over-engineering, naming, leftovers, wording, commits) against the style profile and writes `.artisanal/findings.json`. Unreferenced-file detection follows imports, class names, package.json, CI and doc mentions. Rules, severities and suggested rewrites are in `references/rules.json`. `examples/ai-heavy-project` (every rule planted) and `examples/clean-project` (no findings) back the tests.
- The profile script moved to `scripts/profile.mjs`, sharing its parser with the checks.
- Phase 1 style profile: `learn-style` skill and `profile.mjs`, which measure languages, naming, comment density, function length, error handling, logging, indentation, test layout and commit message format (JavaScript, TypeScript, Python, Apex, Java) and write `.artisanal/profile.json`.
- Phase 0 scaffolding: Claude Code plugin manifest and marketplace, MIT license, `artisanal-doctor` skill (checks Node.js, Git and that the project is a clean git repository), tests (`npm test`, no dependencies).
