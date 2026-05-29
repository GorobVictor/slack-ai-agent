# Worker Observability And Tool Call Diagnostics

## Goal

Add structured Worker logging for Slack answer generation failures and make
artifact tool handling robust when the model emits tool-call markup as plain text
instead of real `tool_calls`.

## Scope

- Add a structured JSON logger for the Worker with request context, log levels,
  safe error serialization, and truncation for large snippets.
- Include Slack request context in logs: request ID, channel, thread timestamp,
  message timestamp, Slack user, model, and generation round.
- Log start, success, and failure events for `/slack/answer` without exposing
  secrets.
- Log image description failures, AI response fallback reasons, tool execution
  outcomes, and exhausted tool workflows.
- Replace ad hoc MCP warnings with structured logs for registration, connection,
  discovered tools, and tool call failures.
- Detect plain-text `create_artifact` markers before sending model content to
  Slack, and either execute the artifact tool or return a safe error.
- Document how to use `requestId`, Worker logs, and debug log settings.

## Implementation Notes

- Add `src/worker/logger.ts` for JSON logs written through `console.*`.
- Add `LOG_LEVEL` and `AI_LOG_RESPONSE_SNIPPET_CHARS` Worker vars for runtime
  observability controls.
- Keep log context sanitized and avoid logging secrets or raw authorization
  headers.
- Generate a `requestId` for each Worker request with `crypto.randomUUID()`.
- Continue using the existing Workers AI tool loop and artifact validation.
- Regenerate Worker environment types and verify the Worker TypeScript build.
