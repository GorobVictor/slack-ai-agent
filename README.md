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
CLOUDFLARE_AGENT_TIMEOUT_MS=120000
```

`SLACK_AGENT_DB_PATH` is optional. If it is not set, the app stores SQLite data
at `./data/slack-ai-agent.sqlite`. `CLOUDFLARE_AGENT_TIMEOUT_MS` is optional and
defaults to `120000`.

The Cloudflare Worker uses a separate secret named `AGENT_AUTH_TOKEN`. It must
match `CLOUDFLARE_AGENT_TOKEN` in the Node.js process.

For local Worker development, create `src/worker/.dev.vars`:

```sh
AGENT_AUTH_TOKEN=replace-with-shared-worker-token
CONTEXT7_API_KEY=replace-with-context7-api-key
```

## Slack App Configuration

Enable Socket Mode for the Slack app and create an app-level token with:

- `connections:write`

Add these bot token scopes:

- `app_mentions:read`
- `chat:write`
- `files:read` for reading files that users attach to messages
- `files:write` for uploading generated files back into Slack threads
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

When users attach files, the Node.js bot downloads them with the Slack bot token
and sends normalized attachment content to the Worker. The bot extracts text from
text-like files, PDFs, CSV files, and Excel workbooks. Small images are passed as
bounded inline image payloads; unsupported or oversized files are represented by
metadata and a note so the assistant can explain the limitation.

When the assistant needs to create a downloadable artifact, the Worker exposes a
controlled `create_artifact` AI tool. The tool validates file names, MIME types,
content, file count, and size before returning generated file payloads to the
Node.js bot. The bot then uploads those files to the same Slack thread with
Slack's file upload API. This is useful for code snippets, CSV or
spreadsheet-ready data, and other artifacts that should not be pasted directly
into a Slack message.

When the assistant needs fresh public web context, the Worker exposes a
controlled `web_request` AI tool. The tool supports read-only `GET` and `HEAD`
requests to public `http` and `https` URLs, sends browser-compatible default
headers, blocks credentials and private/local hosts, follows only a bounded
number of safe redirects, and truncates response bodies before returning them to
the AI loop. It is intended for public pages, public API responses, and status
checks; Context7 MCP remains the preferred tool for library and framework
documentation.

Active Slack threads are stored in SQLite so the bot can continue conversations
after a process restart. The Cloudflare agent stores compact AI conversation
context for each Slack thread.

## Project Layout

- [`src/bot/`](src/bot/) contains the Node.js Slack Socket Mode application.
- [`src/shared/`](src/shared/) contains shared bot/Worker contracts, limits, and
  validation helpers.
- [`src/worker/`](src/worker/) contains the Cloudflare Worker,
  `SlackThreadAgent`, Wrangler configuration, and local Worker development
  variables.

## Cloudflare Worker

The Worker lives under [`src/worker/`](src/worker/). It exposes:

- `GET /health` for a basic health check.
- `POST /slack/answer` for authenticated Slack answer requests from the Node.js
  bot.

AI behavior is configured in [`src/worker/wrangler.jsonc`](src/worker/wrangler.jsonc)
under `vars`:

- `WORKERS_AI_MODEL` selects the Workers AI model.
- `AI_SYSTEM_PROMPT` controls the assistant behavior.
- `AI_MAX_TOKENS` controls the response length budget.
- `AI_TEMPERATURE` controls response variability.
- `AI_MAX_THREAD_MESSAGES` controls how many recent thread messages are kept in
  the prompt context.
- `AI_GATEWAY_ID` selects the Cloudflare AI Gateway used for Workers AI calls.
  The default value, `default`, lets Cloudflare create the default gateway on
  first authenticated use.
- `AI_GATEWAY_SKIP_CACHE` controls whether AI Gateway caching is bypassed for
  Slack thread requests.
- `AI_GATEWAY_COLLECT_LOGS` controls whether requests are collected in AI
  Gateway logs and analytics.
- `MCP_CONNECTION_TIMEOUT_MS` controls how long the Worker waits for configured
  MCP servers to connect before generating an answer without their tools.
- `LOG_LEVEL` controls structured Worker log verbosity. Supported values are
  `debug`, `info`, `warn`, `error`, and `silent`.
- `AI_LOG_RESPONSE_SNIPPET_CHARS` controls how much AI/MCP response text can
  appear in structured debug logs before truncation.

MCP servers are configured in [`src/worker/mcp.config.ts`](src/worker/mcp.config.ts).
The initial configuration enables Context7 over Streamable HTTP. Add more
servers by appending entries to `mcpServers`; header values can reference Worker
secrets or vars with `${ENV_VAR}` placeholders. Keep API keys in Worker secrets
or local `.dev.vars`, not in the config file.

Worker logs are emitted as structured JSON through `console.*`. Each Slack
answer request gets a `requestId` that appears in start, success, failure, AI
round, MCP, and tool-call log events. Use `LOG_LEVEL=debug` temporarily when
investigating fallback replies such as `I could not generate an answer for that
message.` or malformed tool-call output.

Useful commands:

```sh
npm test
npm run worker:types
npm run worker:check
npm run worker:dev
npm run worker:deploy
```

Before deploying, set the Worker secret:

```sh
npx wrangler secret put AGENT_AUTH_TOKEN --config src/worker/wrangler.jsonc
npx wrangler secret put CONTEXT7_API_KEY --config src/worker/wrangler.jsonc
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

Run the unit test suite:

```sh
npm test
```

## Start

Run the compiled Node.js Slack bot:

```sh
npm start
```

## Repository Guidance

Agent-facing project instructions live in [`AGENTS.md`](AGENTS.md). Update it when repository conventions, agent workflows, or important project context changes.
