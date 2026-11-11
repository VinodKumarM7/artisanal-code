# Artisanal

Makes AI-assisted code read like a careful developer on your team wrote it: no AI traces, no leftover scripts, simple solutions that follow the project's own conventions.

Artisanal is a plugin for Claude Code, with an install script for Codex, Cursor and other agents that read `SKILL.md` skills. Deterministic scripts find the problems, with the file, line and source text as evidence; the agent then proposes small, behavior-preserving edits in your project's style. Every change is shown before it is applied, on a new branch, with nothing committed until you say so.

## What it does

| Skill | What it handles |
|---|---|
| `learn-style` | Learns how the project is written: naming, comment density, function length, error handling, indentation, test layout and commit format. |
| `clean-traces` | AI tool files tracked in git (`CLAUDE.md`, `AGENTS.md`, `.cursor/`, ...): untracked and ignored, but kept on disk. AI credit lines and chat-style phrases in comments and docs. AI trailers in commit history are reported, never rewritten unless you ask. |
| `remove-leftovers` | Files nothing imports, runs or mentions; scratch, debug and backup files; commented-out code; debug logging. Placeholder TODOs and stubs are listed for you. |
| `simplify-review` | Try/catch that only rethrows or logs, impossible null checks, single-implementation interfaces and factories, forwarding wrappers, generic names, and names or indentation that differ from the rest of the project. |
| `humanize-docs` | Comments that repeat the code, banners, oversized doc comments, filler wording and emoji, with every fact kept. |
| `commit-style` | Splits your work into focused commits with messages in the format your history already uses. |
| `artisanal-doctor` | Checks Node.js, Git and that the project is a clean git repository. |

There are 35 rules in all; see [`references/rules.json`](references/rules.json) for each one's severity and what a person would write instead, and [`docs/sample-report/report.md`](docs/sample-report/report.md) for a report on the planted example project.

## Install

### Claude Code

```
/plugin marketplace add VinodKumarM7/artisanal-code
/plugin install artisanal-code@artisanal-code
```

### Other agents

With Node.js 20 or later:

```
npx artisanal-code install
```

It asks which agent to install for. To choose up front:

```
npx artisanal-code install --agent codex                         # ~/.codex/skills
npx artisanal-code install --agent cursor --dest path/to/project # .cursor/rules/artisanal-*.mdc
npx artisanal-code install --agent claude                        # ~/.claude/skills and commands, without the plugin system
npx artisanal-code install --agent dir --dest path/to/skills     # any agent that reads SKILL.md folders
```

The scripts are copied to `~/.artisanal-code` (change with `--home`), and the skills point there. Existing files are kept unless you pass `--force`; `--dry-run` lists what would be written. To run the latest code from GitHub instead of npm, use `npx github:VinodKumarM7/artisanal-code install`.

### Command line

The same command runs the checks without any agent:

```
npx artisanal-code check .            # findings with file, line and evidence
npx artisanal-code report .           # Markdown and HTML report with the cleanliness score
npx artisanal-code profile .          # the project's style profile
npx artisanal-code help               # every command
```

## Use

Ask in plain words, for example "Remove AI traces from this repo", "Clean up leftovers", "Simplify this code", "Humanize the docs", "Commit my changes" or "Learn my project's coding style". Or use the commands:

- `/tidy [folder] [area]` goes through every skill in order, with your approval at each step. Name an area (`traces`, `leftovers`, `simplify`, `docs`, `commits`) to run just that one.
- `/tidy-check [folder]` writes `.artisanal/report.md` and `report.html` with a cleanliness score, and changes nothing.

Artisanal keeps its working files (style profile, plans, reports) in `.artisanal/` inside your project. Add it to your `.gitignore`.

### Edit hook

An optional hook checks each file the agent edits and tells the agent about new findings, so it fixes its habits as it works. It is off until you enable it for a project:

```
node <plugin folder>/hooks/check-edit.mjs enable <project> [--level low|medium|high]
```

It reports medium and high findings by default, mentions each finding once, and never edits files. `disable` turns it off; `ARTISANAL_EDIT_HOOK=0` or `1` overrides the setting for a session.

## How it stays safe

- Nothing is changed without your approval. Plans list deletions first, with a preview of every line removed or changed.
- Changes are applied only in a git repository with a clean working tree, on a new `artisanal/<skill>-<date>` branch, and nothing is committed, so you can review everything with `git diff` and undo it by switching back.
- A change that could alter behavior is flagged for you instead of applied. Untracked files are never deleted, since git could not bring them back.
- Published history is never rewritten unless you ask for that specific action. Nothing is pushed.

## What it will not do

Artisanal removes noise and follows your conventions. It does not forge authorship evidence: no rewritten commit dates, simulated typing or edit history, or commits spread over time. It does not add typos or inconsistencies on purpose, and it is not tuned against AI-detection tools.

## Cleanliness score

Each finding costs points by severity: 4 (high), 2 (medium) or 0.5 (low). One rule costs at most 12 points, so a single noisy rule cannot sink the score. The total is divided by a size allowance, the square root of the project's thousands of code lines (at least 1), and the score is 100 minus that. Grades: A 90+, B 75+, C 60+, D 40+, F below.

## Using the checks in CI

```
npx artisanal-code check . --no-write --fail-on medium
```

The exit code is 1 when a finding at or above the given severity is found. Add `artisanal-ignore` (optionally followed by rule ids) on or above a line to skip it, or `artisanal-ignore-file` near the top of a file.

## Requirements

Node.js 20+ and Git. No other dependencies.

## Development

```
npm test                    # unit tests, no dependencies
npm run check -- <dir>      # findings with file, line and evidence
npm run report -- <dir>     # Markdown and HTML report with the score
npm run profile -- <dir>    # style profile
npm run fix -- plan <dir> --scope traces|leftovers|simplify|docs
npm run commit-plan -- plan <dir>
claude plugin validate .    # plugin and marketplace manifests
```

`examples/ai-heavy-project` has every rule planted once and `examples/clean-project` has none; the tests check both. CI runs the tests on Linux and Windows with Node 20 and 22.

## License

MIT
