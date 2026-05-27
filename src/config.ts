import { resolve } from "node:path";

export type AppConfig = {
  slackAppToken: string;
  slackBotToken: string;
  databasePath: string;
};

const defaultDatabasePath = resolve(process.cwd(), "data", "slack-ai-agent.sqlite");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    slackAppToken: readRequiredEnv(env, "SLACK_APP_TOKEN"),
    slackBotToken: readRequiredEnv(env, "SLACK_BOT_TOKEN"),
    databasePath: env.SLACK_AGENT_DB_PATH?.trim() || defaultDatabasePath,
  };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
