# Slack Markdown Support

## Goal

Render bot answers in Slack using Slack-compatible Markdown without adding a full CommonMark conversion layer.

## Approach

- Send bot answers through Block Kit `section` blocks with `mrkdwn` text by default.
- Keep the top-level Slack `text` field populated as fallback and notification text.
- Split long answers into multiple section blocks so each block stays within Slack's 3,000 character `mrkdwn` text limit.
- Leave generated file `initial_comment` values as strings because Slack comments already support Markdown-style rendering.
- Update the Worker system prompt so the model prefers Slack-compatible `mrkdwn` syntax and avoids GitHub-only Markdown features.

## Verification

- Add focused unit coverage for short `mrkdwn` answers, long answer splitting, and fallback `text` preservation.
- Run the bot test target and TypeScript checks for the bot and Worker.
