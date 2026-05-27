import { App } from "@slack/bolt";

import type { SlackAnswerClient, SlackAnswerInput } from "./cloudflareAgentClient.js";
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

const fallbackAnswer =
  "I could not generate an answer right now. Please try again later.";

export function createSlackAiBot(
  config: AppConfig,
  conversations: SlackConversationStore,
  answerClient: SlackAnswerClient,
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

    const text = await generateAnswer(
      answerClient,
      {
        channel: mention.channel,
        threadTs,
        messageTs: mention.ts,
        user: mention.user ?? "unknown",
        text: mention.text,
        isMention: true,
      },
      logger,
    );

    await client.chat.postMessage({
      channel: mention.channel,
      text,
      thread_ts: threadTs,
    });
  });

  app.event("message", async ({ event, client, logger }) => {
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

    const text = await generateAnswer(
      answerClient,
      {
        channel: message.channel,
        threadTs: message.thread_ts,
        messageTs: message.ts,
        user: message.user ?? "unknown",
        text: message.text,
        isMention: false,
      },
      logger,
    );

    await client.chat.postMessage({
      channel: message.channel,
      text,
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

async function generateAnswer(
  answerClient: SlackAnswerClient,
  input: SlackAnswerInput,
  logger: { error(message: string, error?: unknown): void },
): Promise<string> {
  try {
    return await answerClient.generateAnswer(input);
  } catch (error) {
    logger.error("Failed to generate Cloudflare agent answer.", error);
    return fallbackAnswer;
  }
}
