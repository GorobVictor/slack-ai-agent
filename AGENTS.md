# Agent Instructions

## Project Overview

This repository contains a basic Node.js console application written in TypeScript. Application code lives in `src/`, and TypeScript builds compiled JavaScript into `dist/`.

## Repository Language

- Keep all repository files in English, including code, comments, documentation, rules, skills, prompts, commit messages, and configuration text.
- Reply to the user in the same language they use in chat.
- If a Plan Mode discussion happens in another language, translate approved plans to English before saving them in the repository.

## Common Commands

```sh
npm install
npm run dev -- Rob
npm run build
npm start -- Rob
npm run check
```

## Source Layout

- `src/index.ts` is the console application entrypoint.
- `dist/` is generated build output and must not be committed.
- `proto/features/` stores approved feature plans in English.
- `.cursor/rules/` stores persistent repository guidance for agents.
- `.cursor/skills/` stores repository-specific agent skills.

## Development Guidance

- Keep runtime application code inside `src/`.
- Prefer simple, maintainable TypeScript before adding abstractions.
- Use strict TypeScript and Node.js ESM conventions from `tsconfig.json`.
- Update `README.md` when setup, usage, scripts, or project structure changes.
- Update this file when agent workflow, repository conventions, or important project context changes.

## Commit Guidance

- Use the repository `gen-commits` skill when creating local commits from uncommitted changes.
- Do not commit `checkpoint.md`.
- Create local commits only unless the user explicitly asks for a push.
