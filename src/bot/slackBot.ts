import { Buffer } from "node:buffer";

import { App } from "@slack/bolt";

import {
  SlackAnswerClientError,
  type SlackAnswerClient,
  type SlackAnswerInput,
} from "./cloudflareAgentClient.js";
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

type SlackEventClient = {
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
};

type SlackEventLogger = {
  warn(message: string, metadata?: unknown): void;
  error(message: string, error?: unknown): void;
};

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
    await handleSlackThreadEvent({
      event: event as SlackTextEvent,
      isMention: true,
      client,
      logger,
      config,
      conversations,
      answerClient,
    });
  });

  app.event("message", async ({ event, client, logger }) => {
    await handleSlackThreadEvent({
      event: event as SlackTextEvent,
      isMention: false,
      client,
      logger,
      config,
      conversations,
      answerClient,
    });
  });

  return app;
}

async function handleSlackThreadEvent(input: {
  event: SlackTextEvent;
  isMention: boolean;
  client: SlackEventClient;
  logger: SlackEventLogger;
  config: AppConfig;
  conversations: SlackConversationStore;
  answerClient: SlackAnswerClient;
}): Promise<void> {
  const { event, isMention, client, logger, config, conversations, answerClient } =
    input;

  if (!canReplyToMessageEvent(event) || !event.ts) {
    if (isMention) {
      logger.warn(
        "Ignored app_mention event without a channel, timestamp, or processable content.",
      );
    }
    return;
  }

  if (!isMention && (!event.thread_ts || isBotOrSlackSubtype(event))) {
    return;
  }

  const threadTs = isMention ? event.thread_ts ?? event.ts : event.thread_ts;
  if (!threadTs) {
    return;
  }

  if (isMention) {
    conversations.saveActiveThread(event.channel, threadTs);
  } else if (!conversations.hasActiveThread(event.channel, threadTs)) {
    return;
  }

  if (!conversations.markMessageForReply(event.channel, event.ts)) {
    return;
  }

  const response = await generateAnswer(
    answerClient,
    {
      channel: event.channel,
      threadTs,
      messageTs: event.ts,
      user: event.user ?? "unknown",
      text: event.text ?? "",
      isMention,
      attachments: await normalizeSlackFiles(
        event.files,
        config.slackBotToken,
        logger,
      ),
    },
    logger,
  );

  await postAnswerAndFiles(client, event.channel, threadTs, response, logger);
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
  logger: SlackEventLogger,
): Promise<SlackAnswerPayload> {
  try {
    return await answerClient.generateAnswer(input);
  } catch (error) {
    logger.error("Failed to generate Cloudflare agent answer.", error);
    return { answer: fallbackAnswerForError(error) };
  }
}

function fallbackAnswerForError(error: unknown): string {
  if (error instanceof SlackAnswerClientError) {
    if (error.kind === "timeout") {
      return "The Cloudflare agent timed out while generating an answer. Please try again.";
    }

    if (error.kind === "http" && error.status === 401) {
      return "The Cloudflare agent rejected the bot request. Please check the worker auth configuration.";
    }

    if (error.kind === "http") {
      return "The Cloudflare agent failed while generating an answer. Please try again later.";
    }

    return "The Cloudflare agent returned an invalid response. Please try again later.";
  }

  return "I could not generate an answer right now. Please try again later.";
}

async function postAnswerAndFiles(
  client: SlackEventClient,
  channel: string,
  threadTs: string,
  response: SlackAnswerPayload,
  logger: SlackEventLogger,
): Promise<void> {
  await client.chat.postMessage({
    channel,
    text: response.answer,
    thread_ts: threadTs,
  });
  await uploadGeneratedFiles(client, channel, threadTs, response.files, logger);
}

async function uploadGeneratedFiles(
  client: SlackEventClient,
  channel: string,
  threadTs: string,
  files: SlackGeneratedFile[] | undefined,
  logger: SlackEventLogger,
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
