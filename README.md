# Slack AI Agent

A TypeScript Slack bot that runs through Socket Mode and asks a Cloudflare
Worker/Agents SDK backend to generate replies with Workers AI.

## Requirements

- Node.js 20 or newer
- npm
- A Slack app with Socket Mode enabled
- A Cloudflare account with Workers AI enabled

## Setup

```sh
npm install
```

Export these variables before starting the app:

```sh
SLACK_APP_TOKEN=xapp-your-app-level-token
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_AGENT_DB_PATH=./data/slack-ai-agent.sqlite
CLOUDFLARE_AGENT_URL=http://localhost:8787/slack/answer
CLOUDFLARE_AGENT_TOKEN=replace-with-shared-worker-token
CLOUDFLARE_AGENT_TIMEOUT_MS=30000
```

`SLACK_AGENT_DB_PATH` is optional. If it is not set, the app stores SQLite data
at `./data/slack-ai-agent.sqlite`. `CLOUDFLARE_AGENT_TIMEOUT_MS` is optional and
defaults to `30000`.

The Cloudflare Worker uses a separate secret named `AGENT_AUTH_TOKEN`. It must
match `CLOUDFLARE_AGENT_TOKEN` in the Node.js process.

For local Worker development, create `src/worker/.dev.vars`:

```sh
AGENT_AUTH_TOKEN=replace-with-shared-worker-token
```

## Slack App Configuration

Enable Socket Mode for the Slack app and create an app-level token with:

- `connections:write`

Add these bot token scopes:

- `app_mentions:read`
- `chat:write`
- `channels:history` for public channel thread replies
- `groups:history` for private channel thread replies, if needed
- `im:history` for direct message thread replies, if needed
- `mpim:history` for multi-person direct message thread replies, if needed

Subscribe to bot events:

- `app_mention`
- `message.channels` for public channel thread replies
- `message.groups` for private channel thread replies, if needed
- `message.im` for direct message thread replies, if needed
- `message.mpim` for multi-person direct message thread replies, if needed

## Development

Start the Cloudflare Worker locally:

```sh
npm run worker:dev
```

Workers AI uses the remote Cloudflare binding even during local development and
may incur usage charges.

In another terminal, run the Slack bot:

```sh
npm run dev
```

The bot replies in a thread when it is mentioned. It also keeps replying in
threads that started with a mention. Each Slack message is sent to the
Cloudflare Worker, which routes the message to a durable `SlackThreadAgent`
instance keyed by `channel + thread_ts`.

Active Slack threads are stored in SQLite so the bot can continue conversations
after a process restart. The Cloudflare agent stores compact AI conversation
context for each Slack thread.

## Project Layout

- [`src/bot/`](src/bot/) contains the Node.js Slack Socket Mode application.
- [`src/worker/`](src/worker/) contains the Cloudflare Worker,
  `SlackThreadAgent`, Wrangler configuration, and local Worker development
  variables.

## Cloudflare Worker

The Worker lives under [`src/worker/`](src/worker/). It exposes:

- `GET /health` for a basic health check.
- `POST /slack/answer` for authenticated Slack answer requests from the Node.js
  bot.

Useful commands:

```sh
npm run worker:types
npm run worker:check
npm run worker:dev
npm run worker:deploy
```

Before deploying, set the Worker secret:

```sh
npx wrangler secret put AGENT_AUTH_TOKEN --config src/worker/wrangler.jsonc
```

## Build

Compile the Node.js bot TypeScript to JavaScript:

```sh
npm run build
```

Check the Worker TypeScript:

```sh
npm run worker:check
```

## Start

Run the compiled Node.js Slack bot:

```sh
npm start
```

## Repository Guidance

Agent-facing project instructions live in [`AGENTS.md`](AGENTS.md). Update it when repository conventions, agent workflows, or important project context changes.
