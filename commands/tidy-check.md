---
description: Run Artisanal's checks and write a Markdown and HTML report with a cleanliness score (changes no code)
argument-hint: "[project folder]"
---

Run Artisanal's report on the project folder given in the arguments ($ARGUMENTS), or the current folder if none is given:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" <projectDir>
```

`${CLAUDE_PLUGIN_ROOT}` is the folder this plugin is installed in. The script runs every check, then writes `.artisanal/report.md`, `.artisanal/report.html` and `.artisanal/findings.json` in the project. It changes no source files.

Then:

1. Show the score and grade, and the counts per severity, as the script printed them.
2. Read `.artisanal/report.md` and summarize the three to five largest costs to the score in plain words, each with one example `file:line` from the report. Report only what the report contains.
3. Say which skill handles each area: `clean-traces` (AI traces), `remove-leftovers` (leftovers), `simplify-review` (defensive bloat, over-engineering, naming), `humanize-docs` (comments and wording), `commit-style` (commits). Offer to start with the area that costs the most; do not start any of them without the user's go-ahead.
4. Give the paths of both report files. If `.artisanal/` is not in the project's `.gitignore`, suggest adding it.
