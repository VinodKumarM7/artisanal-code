---
description: Tidy a project with Artisanal, step by step - setup check, style profile, AI traces, leftovers, simplifications, docs and commits, each change approved first
argument-hint: "[project folder] [traces|leftovers|simplify|docs|commits]"
---

Tidy the project with the Artisanal skills. The arguments ($ARGUMENTS) may name a project folder (default: the current folder) and one area to limit the run to: `traces`, `leftovers`, `simplify`, `docs` or `commits`. Without an area, go through all of them in this order, finishing each before the next:

1. **Setup**: use the `artisanal-doctor` skill. If the project is not ready (not a git repository, or uncommitted changes), show the hints and stop; do not fix them yourself.
2. **Style**: use the `learn-style` skill to build or refresh `.artisanal/profile.json`, and summarize the style in two or three sentences.
3. **AI traces**: the `clean-traces` skill.
4. **Leftovers**: the `remove-leftovers` skill.
5. **Simplify**: the `simplify-review` skill.
6. **Docs**: the `humanize-docs` skill.
7. **Commits**: the `commit-style` skill, to commit the work in focused commits, only if the user wants to commit now.

Rules for the whole run:

- Every skill shows its plan first. Apply nothing the user has not approved, and let the user skip any step.
- All changes stay on one `artisanal/` branch with nothing committed until step 7, so the user can review everything with `git diff` and undo it by switching back.
- Never change behavior while tidying, never rewrite published history, and never push.
- At the end, summarize what changed per step, what was skipped, and what still needs a person. Suggest the `/tidy-check` command to see the new score.
