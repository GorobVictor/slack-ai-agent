import { resolve } from "node:path";

export type AppConfig = {
  slackAppToken: string;
  slackBotToken: string;
  databasePath: string;
  cloudflareAgentUrl: string;
  cloudflareAgentToken: string;
  cloudflareAgentTimeoutMs: number;
};

const defaultDatabasePath = resolve(process.cwd(), "data", "slack-ai-agent.sqlite");
const defaultCloudflareAgentTimeoutMs = 30_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    slackAppToken: readRequiredEnv(env, "SLACK_APP_TOKEN"),
    slackBotToken: readRequiredEnv(env, "SLACK_BOT_TOKEN"),
    databasePath: env.SLACK_AGENT_DB_PATH?.trim() || defaultDatabasePath,
    cloudflareAgentUrl: readRequiredEnv(env, "CLOUDFLARE_AGENT_URL"),
    cloudflareAgentToken: readRequiredEnv(env, "CLOUDFLARE_AGENT_TOKEN"),
    cloudflareAgentTimeoutMs: readOptionalPositiveInteger(
      env,
      "CLOUDFLARE_AGENT_TIMEOUT_MS",
      defaultCloudflareAgentTimeoutMs,
    ),
  };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readOptionalPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const rawValue = env[name]?.trim();

  if (!rawValue) {
    return defaultValue;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }

  return value;
}
