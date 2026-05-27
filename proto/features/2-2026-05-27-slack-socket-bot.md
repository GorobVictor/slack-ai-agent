# Slack Socket Mode Echo Bot

## Goal

Add a console-only Slack bot that connects through Socket Mode, responds in
threads when mentioned, and continues replying in those activated threads.

## Behavior

- The bot starts from the TypeScript console entrypoint without exposing an HTTP
  API.
- When Slack sends an `app_mention` event, the bot replies in the message thread
  using `thread_ts = event.thread_ts ?? event.ts`.
- The bot stores the activated thread key (`channel_id + thread_ts`) in SQLite.
- For regular Slack `message` events, the bot replies only when the message is in
  an already activated thread.
- The bot ignores its own messages and Slack message subtypes to avoid reply
  loops.
- For the test implementation, each bot response echoes the text it received.
- Active threads persist across process restarts through the local SQLite
  database.

## Implementation Notes

- Use `@slack/bolt` with Socket Mode enabled.
- Read `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, and optional
  `SLACK_AGENT_DB_PATH` from environment variables.
- Store local runtime data under `data/` by default and keep SQLite files out of
  version control.
- Keep the code small and explicit: configuration, Slack event wiring, and
  storage can live in separate modules under `src/`.

## Slack Configuration

- Enable Socket Mode in the Slack app.
- Create an app-level token with `connections:write`.
- Grant bot token scopes: `app_mentions:read`, `chat:write`, and the relevant
  history scopes for channels where thread continuation should work.
- Subscribe to `app_mention` and the relevant `message.*` bot events.

## Verification

- Run `npm install`.
- Run `npm run check`.
- With valid Slack tokens, mention the bot in a channel and confirm it replies in
  a thread.
- Send another message in that thread and confirm the bot echoes it.
- Restart the process and confirm the bot continues replying in the previously
  activated thread.
