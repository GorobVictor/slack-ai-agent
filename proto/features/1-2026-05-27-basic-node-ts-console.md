# Basic Node.js Console App With TypeScript

## Files To Create
- `[package.json](../../package.json)` with `type: "module"`, npm scripts for `dev`, `build`, and `start`, plus `typescript`, `tsx`, and `@types/node` as development dependencies.
- `[tsconfig.json](../../tsconfig.json)` for Node.js ESM, strict TypeScript, and compiling from `[src](../../src)` to `[dist](../../dist)`.
- `[src/index.ts](../../src/index.ts)` as a simple console entrypoint, such as greeting a CLI argument.
- All application code and future runtime modules will live inside `[src](../../src)`. A single file is enough at the start, but the logic can later move into folders such as `src/cli` or `src/app`.
- `[.gitignore](../../.gitignore)` for `node_modules`, `dist`, logs, and local env files.
- `[README.md](../../README.md)` with short setup, run, and build commands.

## Application Behavior
The CLI will run like this:

```sh
npm run dev -- Rob
```

and print a basic message like this:

```text
Hello, Rob!
```

Without an argument, the app will use a neutral default such as `World`.

## Verification
After implementation, run:
- `npm install`
- `npm run build`
- `npm start -- Rob`
- `npm run dev -- Rob`

## Constraints
- Do not add frameworks or complex architecture for this starter CLI.
- `package.json`, `tsconfig.json`, `.gitignore`, and `README.md` stay in the repository root because they are standard project files required by tooling and documentation.
- All repository files must be written in English, according to the repository language policy.
