# Slack Cloudflare AI Agent

## Goal

Connect the existing Node.js Slack Socket Mode bot to a separate Cloudflare
Worker powered by the Agents SDK and Workers AI. The Node bot remains the Slack
transport, while the Cloudflare agent owns Slack thread context and generates
AI responses.

## Target Architecture

- Slack sends `app_mention` and thread `message` events to the existing Node.js
  bot through Socket Mode.
- The Node bot forwards the Slack message metadata and text to a Cloudflare
  Worker endpoint.
- The Worker authenticates requests from the Node bot and routes each Slack
  thread to a stable `SlackThreadAgent` instance keyed by `channel + thread_ts`.
- The agent stores a compact thread history, builds a prompt from that context,
  calls Workers AI, and returns the answer text.
- The Node bot posts the returned answer back into the same Slack thread through
  `chat.postMessage`.

## Node.js Bot Changes

- Add configuration for `CLOUDFLARE_AGENT_URL`, `CLOUDFLARE_AGENT_TOKEN`, and an
  optional `CLOUDFLARE_AGENT_TIMEOUT_MS`.
- Add a small HTTP client under `src/bot/` that sends `channel`, `thread_ts`,
  `message_ts`, `user`, `text`, and `isMention` to the Worker.
- Replace the current echo response in `src/bot/slackBot.ts` with the Cloudflare
  backend call and post the returned AI answer to the Slack thread.
- Keep the local SQLite store for active-thread tracking and duplicate-response
  protection.

## Cloudflare Worker And Agent

- Add the Worker under `src/worker/` with `wrangler.jsonc`, `server.ts`, and a
  Worker-specific TypeScript configuration.
- Configure a Workers AI binding named `AI` and a Durable Object/Agents SDK
  binding for `SlackThreadAgent`.
- Expose `POST /slack/answer` for the Node bot and require a bearer token.
- Implement `SlackThreadAgent` so each Slack thread has durable state, compact
  message history, prompt construction, and a Workers AI inference call.
- Start with a general Workers AI chat model and make the model configurable
  through Worker variables.

## Documentation And Verification

- Update `.env.example` and `README.md` with the new Node and Cloudflare
  configuration, local development flow, deploy notes, and manual Slack test.
- Keep the Slack bot token in the Node process for this phase; the Worker only
  returns answer text.
- Verify the Node TypeScript build with `npm run check`.
- Verify the Worker TypeScript build with a Worker check script.
- Manually test by running the Worker locally, running the Slack bot, mentioning
  it in Slack, and sending follow-up messages in the same thread.
