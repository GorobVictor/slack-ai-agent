import { mcpServers, type McpServerConfig } from "./mcp.config";
import type { Logger } from "./logger";
import { isPlainObject, parseJsonObject } from "../shared/jsonGuards";

const defaultMcpConnectionTimeoutMs = 5_000;
const maxMcpToolResultCharacters = 12_000;

type McpAgentClient = {
  addMcpServer(
    name: string,
    url: string,
    options?: {
      transport?: {
        headers?: HeadersInit;
        type?: "streamable-http" | "sse" | "auto";
      };
    },
  ): Promise<{ id: string; state: string; authUrl?: string }>;
  mcp: {
    waitForConnections(options?: { timeout?: number }): Promise<void>;
    listTools(): unknown[];
    callTool(params: {
      serverId: string;
      name: string;
      arguments?: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

type McpListedTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  serverId: string;
};

export type McpToolDefinition = {
  aiToolName: string;
  mcpToolName: string;
  serverId: string;
  definition: Record<string, unknown>;
};

export type McpToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

const toolDefinitionsCache = new WeakMap<
  McpAgentClient,
  Promise<McpToolDefinition[]>
>();

export async function loadMcpToolDefinitions(
  agent: McpAgentClient,
  env: unknown,
  options: { connectionTimeoutMs?: number } = {},
  logger?: Logger,
): Promise<McpToolDefinition[]> {
  const cachedTools = toolDefinitionsCache.get(agent);
  if (cachedTools) {
    logger?.debug("mcp_tools_cache_hit");
    return cachedTools;
  }

  const toolsPromise = discoverMcpToolDefinitions(agent, env, options, logger);
  toolDefinitionsCache.set(agent, toolsPromise);

  try {
    return await toolsPromise;
  } catch (error) {
    toolDefinitionsCache.delete(agent);
    throw error;
  }
}

async function discoverMcpToolDefinitions(
  agent: McpAgentClient,
  env: unknown,
  options: { connectionTimeoutMs?: number },
  logger?: Logger,
): Promise<McpToolDefinition[]> {
  await registerConfiguredMcpServers(agent, env, logger);
  await agent.mcp.waitForConnections({
    timeout: options.connectionTimeoutMs ?? defaultMcpConnectionTimeoutMs,
  });

  const usedNames = new Set<string>();
  const listedTools = agent.mcp
    .listTools()
    .map(toMcpListedTool)
    .filter((tool): tool is McpListedTool => Boolean(tool));

  logger?.info("mcp_tools_discovered", {
    mcpToolCount: listedTools.length,
    mcpToolNames: listedTools.map((tool) => tool.name),
  });

  return listedTools.map((tool) => {
    const aiToolName = createUniqueAiToolName(tool, usedNames);

    return {
      aiToolName,
      mcpToolName: tool.name,
      serverId: tool.serverId,
      definition: {
        type: "function",
        function: {
          name: aiToolName,
          description:
            tool.description ??
            `Call the ${tool.name} tool from MCP server ${tool.serverId}.`,
          parameters: normalizeMcpInputSchema(tool.inputSchema),
        },
      },
    };
  });
}

export async function executeMcpToolCall(
  agent: McpAgentClient,
  toolName: string,
  rawArguments: string,
  tools: McpToolDefinition[],
  logger?: Logger,
): Promise<McpToolResult | null> {
  const tool = tools.find((candidate) => candidate.aiToolName === toolName);

  if (!tool) {
    return null;
  }

  const parsedArguments = parseJsonObject(rawArguments);
  if (!parsedArguments) {
    logger?.warn("mcp_tool_call_invalid_arguments", {
      toolName,
      argumentCharacters: rawArguments.length,
    });
    return { ok: false, error: "MCP tool arguments must be a JSON object." };
  }

  try {
    logger?.info("mcp_tool_call_started", {
      toolName,
      mcpToolName: tool.mcpToolName,
      serverId: tool.serverId,
    });
    const result = await agent.mcp.callTool({
      serverId: tool.serverId,
      name: tool.mcpToolName,
      arguments: parsedArguments,
    });

    logger?.info("mcp_tool_call_completed", {
      toolName,
      mcpToolName: tool.mcpToolName,
      serverId: tool.serverId,
    });

    return { ok: true, result: compactMcpToolResult(result) };
  } catch (error) {
    logger?.error("mcp_tool_call_failed", {
      error,
      toolName,
      mcpToolName: tool.mcpToolName,
      serverId: tool.serverId,
    });

    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The MCP tool call failed with an unknown error.",
    };
  }
}

async function registerConfiguredMcpServers(
  agent: McpAgentClient,
  env: unknown,
  logger?: Logger,
): Promise<void> {
  await Promise.all(
    mcpServers
      .filter((server) => server.enabled !== false)
      .map(async (server) => {
        const headers = resolveHeaders(server, env);
        if (headers === null) {
          logger?.warn("mcp_server_skipped_missing_env", {
            serverName: server.name,
            serverUrl: server.url,
          });
          return;
        }

        try {
          const result = await agent.addMcpServer(server.name, server.url, {
            transport: {
              type: server.transport ?? "auto",
              headers,
            },
          });
          logger?.info("mcp_server_registered", {
            serverName: server.name,
            serverUrl: server.url,
            serverId: result.id,
            state: result.state,
            needsAuth: result.state === "authenticating",
          });
        } catch (error) {
          logger?.error("mcp_server_registration_failed", {
            error,
            serverName: server.name,
            serverUrl: server.url,
          });
        }
      }),
  );
}

function resolveHeaders(
  server: McpServerConfig,
  env: unknown,
): Record<string, string> | undefined | null {
  if (!server.headers) {
    return undefined;
  }

  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(server.headers)) {
    const resolved = resolveEnvPlaceholders(value, env);
    if (resolved === null) {
      return null;
    }

    headers[name] = resolved;
  }

  return headers;
}

function resolveEnvPlaceholders(value: string, env: unknown): string | null {
  const envRecord = isRecord(env) ? env : {};
  let missingValue = false;
  const resolved = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, envName) => {
    const envValue = envRecord[envName];
    if (typeof envValue !== "string" || envValue.trim().length === 0) {
      missingValue = true;
      return "";
    }

    return envValue;
  });

  return missingValue ? null : resolved;
}

function toMcpListedTool(value: unknown): McpListedTool | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.name !== "string" ||
    candidate.name.trim().length === 0 ||
    typeof candidate.serverId !== "string" ||
    candidate.serverId.trim().length === 0
  ) {
    return null;
  }

  return {
    name: candidate.name,
    description:
      typeof candidate.description === "string"
        ? candidate.description
        : undefined,
    inputSchema: candidate.inputSchema,
    serverId: candidate.serverId,
  };
}

function normalizeMcpInputSchema(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) {
    return value;
  }

  return {
    type: "object",
    additionalProperties: true,
  };
}

function createUniqueAiToolName(
  tool: McpListedTool,
  usedNames: Set<string>,
): string {
  const baseName = `mcp_${sanitizeToolName(tool.serverId)}_${sanitizeToolName(tool.name)}`;
  let candidate = baseName.slice(0, 64);
  let suffix = 2;

  while (usedNames.has(candidate)) {
    const suffixText = `_${suffix}`;
    candidate = `${baseName.slice(0, 64 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }

  usedNames.add(candidate);

  return candidate;
}

function sanitizeToolName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");

  return sanitized.replace(/^[-_]+/, "") || "tool";
}

function compactMcpToolResult(value: unknown): unknown {
  const normalized = normalizeMcpToolResult(value);
  const serialized = JSON.stringify(normalized);

  if (serialized.length <= maxMcpToolResultCharacters) {
    return normalized;
  }

  return {
    truncated: true,
    text: serialized.slice(0, maxMcpToolResultCharacters),
  };
}

function normalizeMcpToolResult(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const result = value as Record<string, unknown>;

  return {
    isError: result.isError === true,
    structuredContent: result.structuredContent,
    content: Array.isArray(result.content)
      ? result.content.map(normalizeMcpContent)
      : result.content,
  };
}

function normalizeMcpContent(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const content = value as Record<string, unknown>;

  if (content.type === "text") {
    return {
      type: "text",
      text:
        typeof content.text === "string"
          ? content.text
          : JSON.stringify(content.text),
    };
  }

  if (content.type === "resource" && isRecord(content.resource)) {
    const resource = content.resource;

    return {
      type: "resource",
      uri: resource.uri,
      mimeType: resource.mimeType,
      text: typeof resource.text === "string" ? resource.text : undefined,
      blob:
        typeof resource.blob === "string"
          ? `[base64 blob, ${resource.blob.length} characters]`
          : undefined,
    };
  }

  if (content.type === "image" || content.type === "audio") {
    return {
      type: content.type,
      mimeType: content.mimeType,
      data:
        typeof content.data === "string"
          ? `[base64 ${content.type}, ${content.data.length} characters]`
          : undefined,
    };
  }

  if (content.type === "resource_link") {
    return {
      type: "resource_link",
      uri: content.uri,
      name: content.name,
      description: content.description,
      mimeType: content.mimeType,
    };
  }

  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
