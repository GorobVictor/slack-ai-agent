import { Agent } from "agents";

import type {
  SlackAnswerPayload,
  SlackGeneratedFile,
  SlackInputAttachment,
} from "../shared/slackAttachments";
import type { SlackAnswerRequest } from "../shared/slackAnswer";
import { isSlackAnswerRequest } from "../shared/slackAnswer";
import {
  maxGeneratedFiles,
  maxRequestBytes,
} from "../shared/limits";
import { isNonEmptyString } from "../shared/jsonGuards";
import type { AiMessage } from "./aiTypes";
import {
  extractAiResponsePayload,
  getFirstChatCompletionMessageContent,
  getFirstChatCompletionMessageText,
  getToolCalls,
  summarizeAiResponse,
} from "./aiResponseParsing";
import {
  artifactToolName,
  createArtifactToolDefinition,
  executeArtifactToolCall,
  extractPlainTextArtifactToolCall,
} from "./artifactTool";
import {
  buildAnsweredThreadState,
  trimMessages,
  type SlackThreadMessage,
  type SlackThreadState,
} from "./threadState";
import {
  executeMcpToolCall,
  loadMcpToolDefinitions,
} from "./mcp";
import {
  createLogger,
  type Logger,
} from "./logger";

const answerPath = "/slack/answer";
const defaultModel = "@cf/meta/llama-3.1-8b-instruct-fp8";
const defaultImageToTextModel = "@cf/meta/llama-3.2-11b-vision-instruct";
const defaultSystemPrompt =
  "You are a helpful assistant inside Slack. Answer clearly and concisely. Use the Slack thread context when it is useful. Reply in the same language the user used in their latest message. If the language is ambiguous, match the dominant language in the current Slack thread.";
const defaultMaxTokens = 150_000;
const defaultTemperature = 0.4;
const defaultMaxThreadMessages = 20;
const defaultAiGatewayId = "default";
const defaultAiGatewaySkipCache = true;
const defaultAiGatewayCollectLogs = true;
const defaultMcpConnectionTimeoutMs = 5_000;
const defaultAiLogResponseSnippetChars = 2_000;
const maxArtifactToolRounds = 50;

type AiGatewayRequestKind = "answer" | "image_description";

type AiGatewayMetadata = Record<
  string,
  string | number | boolean | null | bigint
>;

export class SlackThreadAgent extends Agent<Env, SlackThreadState> {
  initialState: SlackThreadState = {
    messages: [],
    updatedAt: null,
  };

  async answer(input: SlackAnswerRequest): Promise<SlackAnswerPayload> {
    const logger = createWorkerLogger(this.env, {
      requestId: input.requestId ?? crypto.randomUUID(),
      channel: input.channel,
      threadTs: input.threadTs,
      messageTs: input.messageTs,
      slackUser: input.user,
    });
    const maxThreadMessages = readPositiveInteger(
      this.env.AI_MAX_THREAD_MESSAGES,
      defaultMaxThreadMessages,
    );
    const now = new Date().toISOString();
    logger.info("slack_answer_started", {
      isMention: input.isMention,
      attachmentCount: input.attachments.length,
      previousThreadMessages: this.state.messages.length,
    });
    const attachments = await this.describeImageAttachments(input, logger);
    const userMessage: SlackThreadMessage = {
      role: "user",
      content: formatUserMessage({ ...input, attachments }),
      createdAt: now,
      slackMessageTs: input.messageTs,
      slackUser: input.user,
    };

    const messagesWithQuestion = trimMessages([
      ...this.state.messages,
      userMessage,
    ], maxThreadMessages);

    const response = await this.generateAnswer(messagesWithQuestion, input, logger);
    const answeredAt = new Date().toISOString();

    this.setState(
      buildAnsweredThreadState({
        messagesWithQuestion,
        assistantContent: formatAssistantMessage(response),
        answeredAt,
        maxThreadMessages,
      }),
    );

    logger.info("slack_answer_completed", {
      generatedFileCount: response.files?.length ?? 0,
      answerCharacters: response.answer.length,
    });

    return response;
  }

  private async describeImageAttachments(
    input: SlackAnswerRequest,
    logger: Logger,
  ): Promise<SlackInputAttachment[]> {
    return Promise.all(
      input.attachments.map(async (attachment) => {
        if (attachment.contentKind !== "image" || !attachment.dataBase64) {
          return attachment;
        }

        try {
          const response = await this.env.AI.run(
            defaultImageToTextModel,
            {
              prompt:
                "Describe this Slack image for an assistant that will answer a user message. Include visible text, objects, and any relevant context.",
              image: attachment.dataBase64,
              max_tokens: 300,
            },
            buildAiGatewayOptions(this.env, {
              requestKind: "image_description",
              model: defaultImageToTextModel,
              channel: input.channel,
              threadTs: input.threadTs,
              messageTs: input.messageTs,
            }),
          );
          const description = extractImageDescription(response);

          if (!description) {
            return {
              ...attachment,
              note: "Image was received, but no description could be generated.",
            };
          }

          return {
            ...attachment,
            contentKind: "text",
            text: `Image description:\n${description}`,
            note: "Image was described by Workers AI vision processing.",
          };
        } catch (error) {
          logger.warn("image_description_failed", {
            error,
            attachmentName: attachment.name,
            attachmentMimeType: attachment.mimeType,
            attachmentSize: attachment.size,
          });
          return {
            ...attachment,
            note: "Image was received, but Workers AI vision processing failed.",
          };
        }
      }),
    );
  }

  private async generateAnswer(
    threadMessages: SlackThreadMessage[],
    input: SlackAnswerRequest,
    logger: Logger,
  ): Promise<SlackAnswerPayload> {
    const model = readNonEmptyString(this.env.WORKERS_AI_MODEL, defaultModel);
    const generationLogger = logger.child({ model });
    const files: SlackGeneratedFile[] = [];
    const messages: AiMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(
          readNonEmptyString(this.env.AI_SYSTEM_PROMPT, defaultSystemPrompt),
        ),
      },
      ...threadMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ];
    const maxTokens = readPositiveInteger(
      this.env.AI_MAX_TOKENS,
      defaultMaxTokens,
    );
    const temperature = readNumber(this.env.AI_TEMPERATURE, defaultTemperature);
    const mcpTools = await loadMcpToolDefinitions(
      this,
      this.env,
      {
        connectionTimeoutMs: readPositiveInteger(
          this.env.MCP_CONNECTION_TIMEOUT_MS,
          defaultMcpConnectionTimeoutMs,
        ),
      },
      generationLogger,
    );
    generationLogger.debug("mcp_tools_loaded", {
      mcpToolCount: mcpTools.length,
      mcpToolNames: mcpTools.map((tool) => tool.aiToolName),
    });
    const latestUserMessage = getLatestUserMessage(threadMessages);

    for (let round = 0; round < maxArtifactToolRounds; round += 1) {
      const roundLogger = generationLogger.child({ round });
      roundLogger.info("ai_generation_round_started", {
        messageCount: messages.length,
        mcpToolCount: mcpTools.length,
      });
      let response: Record<string, unknown>;
      try {
        response = await this.env.AI.run(
          model,
          {
            messages,
            tools: [
              createArtifactToolDefinition(),
              ...mcpTools.map((tool) => tool.definition),
            ],
            tool_choice: "auto",
            parallel_tool_calls: false,
            max_tokens: maxTokens,
            temperature,
          },
          buildAiGatewayOptions(this.env, {
            requestKind: "answer",
            model,
            channel: input.channel,
            threadTs: input.threadTs,
            messageTs: latestUserMessage?.slackMessageTs,
            slackUser: latestUserMessage?.slackUser,
            round,
          }),
        );
      } catch (error) {
        roundLogger.error("ai_generation_round_failed", { error });
        throw error;
      }
      const toolCalls = getToolCalls(response);
      const responseText = getFirstChatCompletionMessageText(response);
      roundLogger.debug("ai_generation_round_response", {
        hasToolCalls: toolCalls.length > 0,
        toolCallCount: toolCalls.length,
        responseShape: summarizeAiResponse(
          response,
          readPositiveInteger(
            this.env.AI_LOG_RESPONSE_SNIPPET_CHARS,
            defaultAiLogResponseSnippetChars,
          ),
        ),
      });

      if (toolCalls.length === 0) {
        const plainTextArtifactToolCall = extractPlainTextArtifactToolCall(
          responseText,
        );

        if (plainTextArtifactToolCall?.ok) {
          roundLogger.warn("plain_text_artifact_tool_call_detected", {
            toolName: artifactToolName,
          });
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [plainTextArtifactToolCall.toolCall],
          });

          const result = executeArtifactToolCall(
            plainTextArtifactToolCall.toolCall,
            files,
          );
          roundLogger.info("artifact_tool_call_completed", {
            source: "plain_text_marker",
            ok: result.ok,
            generatedFileCount: files.length,
            error: result.ok ? undefined : result.error,
          });

          messages.push({
            role: "tool",
            tool_call_id: plainTextArtifactToolCall.toolCall.id,
            content: JSON.stringify(result),
          });
          continue;
        }

        if (plainTextArtifactToolCall && !plainTextArtifactToolCall.ok) {
          roundLogger.warn("plain_text_artifact_tool_call_invalid", {
            error: plainTextArtifactToolCall.error,
            snippet: plainTextArtifactToolCall.snippet,
          });

          messages.push({
            role: "user",
            content:
              "Your previous response attempted to call create_artifact as plain text, but the arguments were malformed. Retry now using the actual create_artifact function/tool call with valid JSON arguments including filename, mimeType, and content or contentBase64. Do not write <|tool_call>, call:create_artifact, or JSON tool arguments as plain text in the Slack reply.",
          });
          continue;
        }

        if (!responseText?.trim()) {
          roundLogger.warn("ai_generation_empty_response", {
            fallbackReason: "no_response_text_or_tool_calls",
            responseShape: summarizeAiResponse(
              response,
              readPositiveInteger(
                this.env.AI_LOG_RESPONSE_SNIPPET_CHARS,
                defaultAiLogResponseSnippetChars,
              ),
            ),
          });
        }

        return mergeAnswerWithGeneratedFiles(
          extractAiResponsePayload(
            response,
            roundLogger,
            defaultAiLogResponseSnippetChars,
          ),
          files,
        );
      }

      messages.push({
        role: "assistant",
        content: getFirstChatCompletionMessageText(response),
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const result =
          toolCall.function.name === artifactToolName
            ? executeArtifactToolCall(toolCall, files)
            : ((await executeMcpToolCall(
                this,
                toolCall.function.name,
                toolCall.function.arguments,
                mcpTools,
                roundLogger,
              )) ?? {
                ok: false,
                error: `Unknown tool: ${toolCall.function.name}`,
              });
        roundLogger.info("tool_call_completed", {
          toolName: toolCall.function.name,
          ok: result.ok,
          generatedFileCount: files.length,
          error: result.ok ? undefined : result.error,
        });

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }

    generationLogger.warn("ai_generation_tool_rounds_exhausted", {
      generatedFileCount: files.length,
      maxToolRounds: maxArtifactToolRounds,
    });

    return {
      answer:
        files.length > 0
          ? "I created the requested file attachment."
          : "I could not complete the requested tool workflow.",
      files: files.length > 0 ? files : undefined,
    };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const requestLogger = createWorkerLogger(env, {
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
    });
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method !== "POST" || url.pathname !== answerPath) {
      requestLogger.warn("worker_route_not_found");
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const authResult = await authenticate(request, env);
    if (!authResult.ok) {
      requestLogger.warn("worker_auth_failed", {
        status: authResult.status,
        error: authResult.error,
      });
      return Response.json({ error: authResult.error }, { status: authResult.status });
    }

    const body = await readAnswerRequest(request);
    if (!body.ok) {
      requestLogger.warn("worker_invalid_answer_request", {
        status: body.status,
        error: body.error,
      });
      return Response.json({ error: body.error }, { status: body.status });
    }

    const threadKey = `${body.value.channel}:${body.value.threadTs}`;
    const slackLogger = requestLogger.child({
      channel: body.value.channel,
      threadTs: body.value.threadTs,
      messageTs: body.value.messageTs,
      slackUser: body.value.user,
    });
    slackLogger.info("worker_slack_answer_request_started", {
      isMention: body.value.isMention,
      attachmentCount: body.value.attachments.length,
    });

    try {
      const answer = await env.SLACK_THREAD_AGENT.getByName(threadKey).answer({
        ...body.value,
        requestId,
      });
      slackLogger.info("worker_slack_answer_request_completed", {
        generatedFileCount: answer.files?.length ?? 0,
        answerCharacters: answer.answer.length,
      });

      return Response.json(answer);
    } catch (error) {
      slackLogger.error("worker_slack_answer_request_failed", { error });

      return Response.json(
        {
          error: "Slack answer generation failed",
          requestId,
        },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;

function buildAiGatewayOptions(
  env: Env,
  input: {
    requestKind: AiGatewayRequestKind;
    model: string;
    channel?: string;
    threadTs?: string;
    messageTs?: string;
    slackUser?: string;
    round?: number;
  },
): AiOptions {
  return {
    tags: [
      "slack-ai-agent",
      input.requestKind === "answer"
        ? "slack-answer"
        : "slack-image-description",
    ],
    gateway: {
      id: readNonEmptyString(env.AI_GATEWAY_ID, defaultAiGatewayId),
      skipCache: readBoolean(
        env.AI_GATEWAY_SKIP_CACHE,
        defaultAiGatewaySkipCache,
      ),
      collectLog: readBoolean(
        env.AI_GATEWAY_COLLECT_LOGS,
        defaultAiGatewayCollectLogs,
      ),
      metadata: buildAiGatewayMetadata(input),
    },
  };
}

function createWorkerLogger(env: Env, context: Record<string, unknown>): Logger {
  return createLogger({
    level: env.LOG_LEVEL,
    maxStringLength: readPositiveInteger(
      env.AI_LOG_RESPONSE_SNIPPET_CHARS,
      defaultAiLogResponseSnippetChars,
    ),
    context: {
      service: "slack-ai-agent-worker",
      ...context,
    },
  });
}

function buildAiGatewayMetadata(input: {
  requestKind: AiGatewayRequestKind;
  model: string;
  channel?: string;
  threadTs?: string;
  messageTs?: string;
  slackUser?: string;
  round?: number;
}): AiGatewayMetadata {
  const metadata: AiGatewayMetadata = {
    request_kind: input.requestKind,
    model: input.model,
  };

  if (isNonEmptyString(input.channel)) {
    metadata.slack_channel = input.channel;
  }

  if (isNonEmptyString(input.threadTs)) {
    metadata.slack_thread_ts = input.threadTs;
  }

  if (isNonEmptyString(input.messageTs)) {
    metadata.slack_message_ts = input.messageTs;
  }

  if (isNonEmptyString(input.slackUser)) {
    metadata.slack_user = input.slackUser;
  }

  if (typeof input.round === "number") {
    metadata.tool_round = input.round;
  }

  return metadata;
}

function getLatestUserMessage(
  threadMessages: SlackThreadMessage[],
): SlackThreadMessage | undefined {
  return [...threadMessages]
    .reverse()
    .find((message) => message.role === "user");
}

async function authenticate(
  request: Request,
  env: Env & { AGENT_AUTH_TOKEN?: string },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const expectedToken = env.AGENT_AUTH_TOKEN;

  if (!expectedToken) {
    return { ok: false, status: 500, error: "Agent auth token is not configured" };
  }

  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  if (!constantTimeEqual(token, expectedToken)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true };
}

async function readAnswerRequest(
  request: Request,
): Promise<
  | { ok: true; value: SlackAnswerRequest }
  | { ok: false; status: number; error: string }
> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxRequestBytes) {
    return { ok: false, status: 413, error: "Request body is too large" };
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return { ok: false, status: 400, error: "Request body must be valid JSON" };
  }

  if (!isSlackAnswerRequest(rawBody)) {
    return { ok: false, status: 400, error: "Invalid Slack answer request" };
  }

  return {
    ok: true,
    value: {
      ...rawBody,
      text: cleanSlackText(rawBody.text),
      attachments: rawBody.attachments,
    },
  };
}

function formatUserMessage(input: SlackAnswerRequest): string {
  const mentionPrefix = input.isMention ? "Mention" : "Thread reply";
  const text = input.text || "[No text]";
  const attachments = formatAttachments(input.attachments);

  return `${mentionPrefix} from Slack user ${input.user}: ${text}${attachments}`;
}

function cleanSlackText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();
}

function buildSystemPrompt(basePrompt: string): string {
  return `${basePrompt}

Use available MCP tools when they can provide fresher or more precise context than the Slack thread alone. Prefer Context7 MCP tools for software library and framework documentation lookups before answering documentation-sensitive implementation questions.

When a downloadable artifact is useful, call the ${artifactToolName} tool instead of pasting large content into Slack. Use the actual function/tool calling interface only; never print literal tool-call markup such as <|tool_call>, call:${artifactToolName}, or JSON tool arguments in the Slack reply. Use the tool for complete artifacts such as code files, CSV data, JSON files, markdown documents, or spreadsheet-ready data. After the tool succeeds, reply with a short natural-language summary only. Do not print tool arguments, JSON payloads, or full file contents in the Slack reply.`;
}

function formatAttachments(attachments: SlackInputAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  const formattedAttachments = attachments
    .map((attachment, index) => formatAttachment(attachment, index + 1))
    .join("\n\n");

  return `\n\nSlack attachments:\n${formattedAttachments}`;
}

function formatAttachment(attachment: SlackInputAttachment, index: number): string {
  const metadata = `Attachment ${index}: ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`;

  if (attachment.contentKind === "text" && attachment.text) {
    return `${metadata}\nExtracted text:\n${attachment.text}`;
  }

  if (attachment.contentKind === "image") {
    return `${metadata}\nImage data was received, but this prompt path includes image metadata only. ${attachment.note ?? ""}`.trim();
  }

  return `${metadata}\nCould not process file: ${attachment.note ?? "Unsupported file."}`;
}

function formatAssistantMessage(response: SlackAnswerPayload): string {
  if (!response.files?.length) {
    return response.answer;
  }

  const fileNames = response.files.map((file) => file.filename).join(", ");

  return `${response.answer}\n\nGenerated files: ${fileNames}`;
}

function extractImageDescription(response: Record<string, unknown>): string | null {
  const description =
    response.description ??
    response.response ??
    getFirstChatCompletionMessageContent(response);

  return typeof description === "string" && description.trim()
    ? description.trim()
    : null;
}

function mergeAnswerWithGeneratedFiles(
  response: SlackAnswerPayload,
  files: SlackGeneratedFile[],
): SlackAnswerPayload {
  const mergedFiles = [...files, ...(response.files ?? [])].slice(0, maxGeneratedFiles);

  return mergedFiles.length > 0
    ? { answer: response.answer, files: mergedFiles }
    : { answer: response.answer };
}

function readNonEmptyString(value: unknown, defaultValue: string): string {
  return isNonEmptyString(value) ? value : defaultValue;
}

function readPositiveInteger(value: unknown, defaultValue: number): number {
  const numberValue = readNumber(value, defaultValue);

  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return defaultValue;
  }

  return numberValue;
}

function readNumber(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const numberValue = Number(value);

    if (Number.isFinite(numberValue)) {
      return numberValue;
    }
  }

  return defaultValue;
}

function readBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  return defaultValue;
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}
