export type McpServerTransport = "streamable-http" | "sse" | "auto";

export type McpServerConfig = {
  name: string;
  url: string;
  transport?: McpServerTransport;
  headers?: Record<string, string>;
  enabled?: boolean;
};

export const mcpServers: McpServerConfig[] = [
  {
    name: "context7",
    url: "https://mcp.context7.com/mcp",
    transport: "streamable-http",
    headers: {
      CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}",
    },
    enabled: true,
  },
];
