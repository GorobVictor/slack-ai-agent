# Configurable MCP Servers

## Goal

Add MCP client support to the Cloudflare Worker Slack agent, starting with
Context7, while keeping future MCP servers configurable through a repository
configuration file.

## Scope

- Keep MCP integration inside the Worker agent because the Node.js Slack bot
  only forwards Slack messages and uploads generated files.
- Add a typed Worker MCP config file with Context7 enabled over Streamable HTTP.
- Support header values that reference Worker secrets or vars with `${ENV_VAR}`
  placeholders.
- Register configured MCP servers from the `SlackThreadAgent` and wait briefly
  for restored connections after Durable Object hibernation.
- Convert discovered MCP tools into Workers AI function tool definitions.
- Route model-selected MCP tool calls back through the Agents SDK MCP client.
- Keep the existing `create_artifact` tool available in the same tool loop.
- Document local and deployed Context7 secret setup.

## Implementation Notes

- Add `src/worker/mcp.config.ts` with an initial `context7` entry using
  `https://mcp.context7.com/mcp`.
- Add `src/worker/mcp.ts` for server registration, environment placeholder
  resolution, tool schema conversion, tool call dispatch, and compact MCP tool
  result formatting.
- Update `src/worker/server.ts` so `SlackThreadAgent.generateAnswer()` passes
  both `create_artifact` and configured MCP tools to `env.AI.run(...)`.
- Update the system prompt so the assistant uses MCP tools, especially Context7,
  when documentation lookup would improve an answer.
- Add `MCP_CONNECTION_TIMEOUT_MS` to Worker vars, and keep `CONTEXT7_API_KEY`
  in Worker secrets or local `.dev.vars`.
- Regenerate Worker environment types and verify the Worker TypeScript build.
