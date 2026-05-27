# Slack AI Agent

A basic Node.js console application written in TypeScript.

## Requirements

- Node.js 20 or newer
- npm

## Setup

```sh
npm install
```

## Development

Run the TypeScript entrypoint directly:

```sh
npm run dev -- Rob
```

Expected output:

```text
Hello, Rob!
```

If no argument is provided, the app uses `World`:

```sh
npm run dev
```

## Build

Compile TypeScript to JavaScript:

```sh
npm run build
```

## Start

Run the compiled application:

```sh
npm start -- Rob
```

## Repository Guidance

Agent-facing project instructions live in [`AGENTS.md`](AGENTS.md). Update it when repository conventions, agent workflows, or important project context changes.
