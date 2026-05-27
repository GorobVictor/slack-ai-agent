import { Buffer } from "node:buffer";

import { App } from "@slack/bolt";

import type { SlackAnswerClient, SlackAnswerInput } from "./cloudflareAgentClient.js";
import type { AppConfig } from "./config.js";
import {
  normalizeSlackFiles,
  type SlackEventFile,
} from "./slackFileAttachments.js";
import type { SlackConversationStore } from "./storage.js";
import type { SlackAnswerPayload, SlackGeneratedFile } from "../shared/slackAttachments.js";

type SlackTextEvent = {
  bot_id?: string;
  channel?: string;
  files?: SlackEventFile[];
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

    if (!canReplyToMessageEvent(mention) || !mention.ts) {
      logger.warn("Ignored app_mention event without a channel, timestamp, or processable content.");
      return;
    }

    const threadTs = mention.thread_ts ?? mention.ts;
    conversations.saveActiveThread(mention.channel, threadTs);

    if (!conversations.markMessageForReply(mention.channel, mention.ts)) {
      return;
    }

    const response = await generateAnswer(
      answerClient,
      {
        channel: mention.channel,
        threadTs,
        messageTs: mention.ts,
        user: mention.user ?? "unknown",
        text: mention.text ?? "",
        isMention: true,
        attachments: await normalizeSlackFiles(
          mention.files,
          config.slackBotToken,
          logger,
        ),
      },
      logger,
    );

    await client.chat.postMessage({
      channel: mention.channel,
      text: response.answer,
      thread_ts: threadTs,
    });
    await uploadGeneratedFiles(client, mention.channel, threadTs, response.files, logger);
  });

  app.event("message", async ({ event, client, logger }) => {
    const message = event as SlackTextEvent;

    if (
      !canReplyToMessageEvent(message) ||
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

    const response = await generateAnswer(
      answerClient,
      {
        channel: message.channel,
        threadTs: message.thread_ts,
        messageTs: message.ts,
        user: message.user ?? "unknown",
        text: message.text ?? "",
        isMention: false,
        attachments: await normalizeSlackFiles(
          message.files,
          config.slackBotToken,
          logger,
        ),
      },
      logger,
    );

    await client.chat.postMessage({
      channel: message.channel,
      text: response.answer,
      thread_ts: message.thread_ts,
    });
    await uploadGeneratedFiles(client, message.channel, message.thread_ts, response.files, logger);
  });

  return app;
}

function canReplyToMessageEvent(
  event: SlackTextEvent,
): event is SlackTextEvent & { channel: string } {
  return Boolean(event.channel && (event.text || event.files?.length));
}

function isBotOrSlackSubtype(event: SlackTextEvent): boolean {
  return Boolean(event.bot_id || (event.subtype && event.subtype !== "file_share"));
}

async function generateAnswer(
  answerClient: SlackAnswerClient,
  input: SlackAnswerInput,
  logger: { error(message: string, error?: unknown): void },
): Promise<SlackAnswerPayload> {
  try {
    return await answerClient.generateAnswer(input);
  } catch (error) {
    logger.error("Failed to generate Cloudflare agent answer.", error);
    return { answer: fallbackAnswer };
  }
}

async function uploadGeneratedFiles(
  client: {
    chat: {
      postMessage(options: {
        channel: string;
        text: string;
        thread_ts: string;
      }): Promise<unknown>;
    };
    filesUploadV2(options: {
      channel_id: string;
      thread_ts: string;
      file: Buffer;
      filename: string;
      title?: string;
      initial_comment?: string;
    }): Promise<unknown>;
  },
  channel: string,
  threadTs: string,
  files: SlackGeneratedFile[] | undefined,
  logger: { error(message: string, error?: unknown): void },
): Promise<void> {
  if (!files?.length) {
    return;
  }

  for (const file of files) {
    try {
      await client.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: Buffer.from(file.contentBase64, "base64"),
        filename: file.filename,
        title: file.title,
        initial_comment: file.initialComment,
      });
    } catch (error) {
      logger.error(`Failed to upload generated Slack file ${file.filename}.`, error);
      await client.chat.postMessage({
        channel,
        text: `I generated ${file.filename}, but could not upload it to Slack.`,
        thread_ts: threadTs,
      });
    }
  }
}
