import { App } from "@slack/bolt";

import type { AppConfig } from "./config.js";
import type { SlackConversationStore } from "./storage.js";

type SlackTextEvent = {
  bot_id?: string;
  channel?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
};

export function createSlackEchoBot(
  config: AppConfig,
  conversations: SlackConversationStore,
): App {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  app.event("app_mention", async ({ event, client, logger }) => {
    const mention = event as SlackTextEvent;

    if (!canReplyToTextEvent(mention) || !mention.ts) {
      logger.warn("Ignored app_mention event without a channel, timestamp, or text.");
      return;
    }

    const threadTs = mention.thread_ts ?? mention.ts;
    conversations.saveActiveThread(mention.channel, threadTs);

    if (!conversations.markMessageForReply(mention.channel, mention.ts)) {
      return;
    }

    await client.chat.postMessage({
      channel: mention.channel,
      text: mention.text,
      thread_ts: threadTs,
    });
  });

  app.event("message", async ({ event, client }) => {
    const message = event as SlackTextEvent;

    if (
      !canReplyToTextEvent(message) ||
      !message.ts ||
      !message.thread_ts ||
      isBotOrSlackSubtype(message)
    ) {
      return;
    }

    if (!conversations.hasActiveThread(message.channel, message.thread_ts)) {
      return;
    }

    if (!conversations.markMessageForReply(message.channel, message.ts)) {
      return;
    }

    await client.chat.postMessage({
      channel: message.channel,
      text: message.text,
      thread_ts: message.thread_ts,
    });
  });

  return app;
}

function canReplyToTextEvent(
  event: SlackTextEvent,
): event is SlackTextEvent & { channel: string; text: string } {
  return Boolean(event.channel && event.text);
}

function isBotOrSlackSubtype(event: SlackTextEvent): boolean {
  return Boolean(event.bot_id || event.subtype);
}
