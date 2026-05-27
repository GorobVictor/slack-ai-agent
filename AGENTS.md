# Agent Instructions

## Project Overview

This repository contains a TypeScript Slack bot that runs as a Node.js console application. The bot uses Slack Socket Mode, stores active thread state in SQLite, and builds compiled JavaScript into `dist/`.

## Repository Language

- Keep all repository files in English, including code, comments, documentation, rules, skills, prompts, commit messages, and configuration text.
- Reply to the user in the same language they use in chat.
- If a Plan Mode discussion happens in another language, translate approved plans to English before saving them in the repository.

## Common Commands

```sh
npm install
npm run dev
npm run build
npm start
npm run check
```

## Source Layout

- `src/index.ts` is the console application entrypoint.
- `src/config.ts` reads required Slack token configuration from the environment.
- `src/slackBot.ts` wires Slack Socket Mode event handlers.
- `src/storage.ts` manages local SQLite persistence for active Slack threads.
- `dist/` is generated build output and must not be committed.
- `data/` is local SQLite runtime data and must not be committed.
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
