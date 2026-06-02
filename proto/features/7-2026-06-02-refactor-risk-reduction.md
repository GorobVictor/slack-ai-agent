# Refactor Risk Reduction

## Goal

Reduce bug risk in the Slack AI agent by centralizing shared contracts and limits,
splitting fragile Worker parsing/tool code into focused modules, and adding tests
around the behavior most likely to regress.

## Scope

- Centralize bot/Worker request contracts, JSON guards, and runtime limits under
  `src/shared/`.
- Extract artifact tool behavior from `src/worker/server.ts` into a dedicated
  Worker module.
- Extract Workers AI response parsing and tool-call normalization from
  `src/worker/server.ts`.
- Ensure failed answer generation does not persist a dangling user turn in
  Durable Object thread state.
- Add a lightweight TypeScript test harness and focused tests for contracts,
  artifact parsing, AI response parsing, thread state helpers, and attachment
  limits.
- Deduplicate Slack event handling for mentions and active thread replies.
- Improve bot/Worker error handling, MCP tool definition lifecycle, and Slack
  file download byte-limit enforcement.

## Completion Criteria

- `src/worker/server.ts` primarily coordinates request handling and generation
  flow instead of owning parsing and artifact implementation details.
- Bot and Worker use shared request and attachment contracts.
- Artifact and AI response parsing have focused unit coverage.
- Failed AI generation leaves existing thread history unchanged.
- Local checks pass with `npm run check`, `npm run worker:check`, and `npm test`.
