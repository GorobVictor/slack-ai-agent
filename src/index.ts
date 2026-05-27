#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { createSlackEchoBot } from "./slackBot.js";
import { SlackConversationStore } from "./storage.js";

const config = loadConfig();
const conversations = new SlackConversationStore(config.databasePath);
const app = createSlackEchoBot(config, conversations);

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

await app.start();

console.log("Slack echo bot is running in Socket Mode.");

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`Received ${signal}. Shutting down Slack echo bot.`);

  try {
    await app.stop();
  } finally {
    conversations.close();
  }
}
