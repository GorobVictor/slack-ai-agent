---
name: gen-commits
description: Analyze uncommitted git changes, split them into logical groups, and create local commits with the required tag format. Use when the user asks to commit current work, split changes into commits, or explicitly invokes this skill.
disable-model-invocation: true
---

# Gen Commits

## Purpose

Create clean local commits from uncommitted changes by grouping related work logically, then keep repository guidance documents current.

## Required Commit Format

Use this subject format:

```text
{tag}: {commit name}
```

Allowed tags:

- `feat`
- `test`
- `fix`
- `ref`
- `migration`

Always include a detailed commit body that explains the purpose and important context for the change.

## Workflow

1. Inspect the working tree before committing:
   - Run `git status --short`.
   - Review staged and unstaged changes with `git diff` and `git diff --staged`.
   - Review recent commit style with `git log --oneline -n 10`.
2. Identify logical commit groups by behavior, feature area, test coverage, fixes, refactoring, or migrations.
3. Do not include unrelated changes in the same commit.
4. Do not commit `checkpoint.md`.
5. Stage only the files that belong to the current logical group.
6. Create one local commit per group using the required subject format and a detailed body.
7. Run `git status --short` after each commit to verify what remains.
8. After all intended code/configuration commits are created, review `AGENTS.md` and `README.md` against the committed changes.
9. If repository conventions, commands, setup, usage, project structure, or agent workflows changed, update `AGENTS.md` and `README.md` to match the current state.
10. Commit those documentation updates as their own logical local commit using the required subject format.
11. Stop only when all intended changes are committed and `AGENTS.md` and `README.md` are current, or when remaining changes are unrelated or unclear.

## Hard Rules

- Create local commits only.
- Never push to any remote.
- Never use force operations.
- Never skip git hooks unless the user explicitly requests it.
- Do not finish a `/gen-commits` run without checking whether `AGENTS.md` and `README.md` need updates.
- If a hook changes files, inspect those changes before deciding whether they belong in a new commit.
- If grouping is ambiguous, ask the user before committing.
