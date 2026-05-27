# Slack AI Agent

A TypeScript console application that runs a Slack echo bot through Socket Mode.
The app does not expose an HTTP API.

## Requirements

- Node.js 20 or newer
- npm
- A Slack app with Socket Mode enabled

## Setup

```sh
npm install
```

Export these variables before starting the app:

```sh
SLACK_APP_TOKEN=xapp-your-app-level-token
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_AGENT_DB_PATH=./data/slack-ai-agent.sqlite
```

`SLACK_AGENT_DB_PATH` is optional. If it is not set, the app stores SQLite data
at `./data/slack-ai-agent.sqlite`.

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

Run the TypeScript entrypoint directly:

```sh
npm run dev
```

The bot replies in a thread when it is mentioned. It also keeps replying in
threads that started with a mention. For now, each reply echoes the message text
it received.

Active Slack threads are stored in SQLite so the bot can continue conversations
after a process restart.

## Build

Compile TypeScript to JavaScript:

```sh
npm run build
```

## Start

Run the compiled application:

```sh
npm start
```

## Repository Guidance

Agent-facing project instructions live in [`AGENTS.md`](AGENTS.md). Update it when repository conventions, agent workflows, or important project context changes.
