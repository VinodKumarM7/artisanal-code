# Changelog

## 0.0.1 (unreleased)

- Phase 2 checks: `scripts/check.mjs` runs 35 rules (AI traces, comment noise, defensive bloat, over-engineering, naming, leftovers, wording, commits) against the style profile and writes `.artisanal/findings.json`. Unreferenced-file detection follows imports, class names, package.json, CI and doc mentions. Rules, severities and suggested rewrites are in `references/rules.json`. `examples/ai-heavy-project` (every rule planted) and `examples/clean-project` (no findings) back the tests.
- The profile script moved to `scripts/profile.mjs`, sharing its parser with the checks.
- Phase 1 style profile: `learn-style` skill and `profile.mjs`, which measure languages, naming, comment density, function length, error handling, logging, indentation, test layout and commit message format (JavaScript, TypeScript, Python, Apex, Java) and write `.artisanal/profile.json`.
- Phase 0 scaffolding: Claude Code plugin manifest and marketplace, MIT license, `artisanal-doctor` skill (checks Node.js, Git and that the project is a clean git repository), tests (`npm test`, no dependencies).
