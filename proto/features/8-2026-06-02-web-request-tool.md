# Web Request Tool

## Goal

Add a controlled local Worker AI tool that lets the Slack assistant fetch fresh
public web content when a Slack answer needs current page, API, or HTTP status
context.

## Decision

Implement this as a first-party Worker tool instead of adding a generic web MCP
server. The repository already uses local tools for Worker-owned capabilities
such as generated artifacts, while MCP remains better suited for external
specialized services such as Context7. Generic web access needs in-repository
security controls, redirect handling, runtime limits, logging, and focused unit
tests.

## Scope

- Add a `web_request` AI tool under `src/worker/`.
- Support read-only `GET` and `HEAD` requests to public `http` and `https` URLs.
- Send browser-compatible default request headers without cookies,
  authorization, credentials, request bodies, proxies, or access-control bypass
  behavior.
- Block localhost, private IPs, link-local addresses, URL credentials, unsafe
  schemes, unsupported arguments, and redirects to blocked destinations.
- Bound request timeout, redirect count, and response body size before returning
  content to the AI loop.
- Keep Context7 MCP as the preferred tool for library and framework
  documentation lookups.

## Implementation

- Add web request limits in `src/shared/limits.ts`.
- Add `src/worker/webRequestTool.ts` with the tool definition, argument
  validation, public URL checks, bounded fetch execution, redirect handling, and
  structured tool result shape.
- Wire `web_request` into `SlackThreadAgent.generateAnswer()` in
  `src/worker/server.ts` alongside `create_artifact`, before MCP fallback.
- Update the Worker system prompt so the model chooses Context7 for
  documentation and `web_request` only for public web/API/status content.
- Update repository documentation to describe the new Worker tool.
- Add focused Vitest coverage in `src/worker/webRequestTool.test.ts`.

## Completion Criteria

- The AI tool loop exposes `web_request` in addition to `create_artifact` and
  configured MCP tools.
- Public `GET` and `HEAD` requests can succeed from the Worker runtime without
  losing Cloudflare's `fetch` invocation context.
- The tool returns bounded structured results and safe error objects.
- Security and regression tests cover valid requests, truncation, rejected
  methods, rejected custom request options, blocked private/local destinations,
  unsafe redirects, and the default global `fetch` path.
- Local checks pass with `npm test`, `npm run worker:check`, and
  `npm run check`.
