---
name: artisanal-doctor
description: Checks whether the machine and a project are ready for Artisanal cleanups (Node.js 20+, Git, a git repository with a clean working tree) and reports what to fix first. Use when the user asks to check their Artisanal setup, verify the plugin is installed, or before running a first cleanup on a project.
---

# Artisanal Doctor

Reports whether Artisanal can work on a project. It is read-only: it runs version and `git status` checks only, installs nothing and changes no files.

## Workflow

1. Run the check script from this skill's base directory, passing the project folder (default: the current folder):

   ```
   node scripts/doctor.mjs <projectDir>
   ```

   Use the absolute path of this skill's folder if the working directory is different. Add `--json` for machine-readable output.

2. Show the user the result as the script printed it. Do not mark a check as passing unless the script reported it.

3. For each `missing` or `warn` line, give the hint the script printed. Do not run the fix yourself (no `git init`, `git commit` or `git stash`); the user decides.

4. Explain why the git checks matter: every Artisanal cleanup is applied on a new branch in a clean working tree, so the user can review each change and undo it.

## Safety rules

- Never install software, initialize a repository, commit, stash or change files from this skill.
- Report only what the script printed.
