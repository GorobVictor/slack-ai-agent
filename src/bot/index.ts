#!/usr/bin/env node

import { CloudflareSlackAnswerClient } from "./cloudflareAgentClient.js";
import { loadConfig } from "./config.js";
import { createSlackAiBot } from "./slackBot.js";
import { SlackConversationStore } from "./storage.js";

const config = loadConfig();
const conversations = new SlackConversationStore(config.databasePath);
const answerClient = new CloudflareSlackAnswerClient(
  config.cloudflareAgentUrl,
  config.cloudflareAgentToken,
  config.cloudflareAgentTimeoutMs,
);
const app = createSlackAiBot(config, conversations, answerClient);

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

await app.start();

console.log("Slack AI bot is running in Socket Mode.");

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`Received ${signal}. Shutting down Slack AI bot.`);

  try {
    await app.stop();
  } finally {
    conversations.close();
  }
}
