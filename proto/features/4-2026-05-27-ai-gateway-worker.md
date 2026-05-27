# Connect Cloudflare AI Gateway To Worker

## Goal

Route all Workers AI calls made by the Slack Worker agent through Cloudflare AI Gateway so requests are visible in Gateway logs and analytics.

## Scope

- Add Worker configuration vars for the AI Gateway ID, cache behavior, and log collection.
- Route the main Slack answer generation call through AI Gateway.
- Route image description calls through AI Gateway.
- Attach lightweight tags and metadata to Gateway requests for dashboard filtering and debugging.
- Regenerate Worker environment types and run TypeScript checks.

## Implementation Notes

- Use the existing Workers AI binding at `env.AI`; no Slack bot or backend client changes are required.
- Use `AI_GATEWAY_ID` with `default` as the initial value, allowing Cloudflare to create the default gateway on first authenticated use.
- Keep `AI_GATEWAY_SKIP_CACHE` enabled by default to avoid caching responses across Slack thread contexts.
- Keep `AI_GATEWAY_COLLECT_LOGS` enabled by default so requests appear in AI Gateway logs.
