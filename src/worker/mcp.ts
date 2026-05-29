import { mcpServers, type McpServerConfig } from "./mcp.config";

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

export async function loadMcpToolDefinitions(
  agent: McpAgentClient,
  env: unknown,
  options: { connectionTimeoutMs?: number } = {},
): Promise<McpToolDefinition[]> {
  await registerConfiguredMcpServers(agent, env);
  await agent.mcp.waitForConnections({
    timeout: options.connectionTimeoutMs ?? defaultMcpConnectionTimeoutMs,
  });

  const usedNames = new Set<string>();

  return agent.mcp
    .listTools()
    .map(toMcpListedTool)
    .filter((tool): tool is McpListedTool => Boolean(tool))
    .map((tool) => {
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
): Promise<McpToolResult | null> {
  const tool = tools.find((candidate) => candidate.aiToolName === toolName);

  if (!tool) {
    return null;
  }

  const parsedArguments = parseJsonObject(rawArguments);
  if (!parsedArguments) {
    return { ok: false, error: "MCP tool arguments must be a JSON object." };
  }

  try {
    const result = await agent.mcp.callTool({
      serverId: tool.serverId,
      name: tool.mcpToolName,
      arguments: parsedArguments,
    });

    return { ok: true, result: compactMcpToolResult(result) };
  } catch (error) {
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
): Promise<void> {
  await Promise.all(
    mcpServers
      .filter((server) => server.enabled !== false)
      .map(async (server) => {
        const headers = resolveHeaders(server, env);
        if (headers === null) {
          console.warn(
            `Skipping MCP server ${server.name}: required header environment value is missing.`,
          );
          return;
        }

        try {
          await agent.addMcpServer(server.name, server.url, {
            transport: {
              type: server.transport ?? "auto",
              headers,
            },
          });
        } catch (error) {
          console.warn(
            `Could not register MCP server ${server.name}: ${getErrorMessage(error)}`,
          );
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
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
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

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
