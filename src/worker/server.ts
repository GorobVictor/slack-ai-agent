import { Agent } from "agents";

import type {
  SlackAnswerPayload,
  SlackGeneratedFile,
  SlackInputAttachment,
} from "../shared/slackAttachments";
import {
  isSlackGeneratedFile,
  isSlackInputAttachment,
} from "../shared/slackAttachments";
import {
  executeMcpToolCall,
  loadMcpToolDefinitions,
} from "./mcp";
import {
  createLogger,
  logValueSnippet,
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
const maxRequestBytes = 1024 * 1024;
const maxGeneratedFiles = 5;
const maxGeneratedFileBytes = 1024 * 1024;
const maxArtifactToolRounds = 50;
const artifactToolName = "create_artifact";

type SlackAnswerRequest = {
  requestId?: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  user: string;
  text: string;
  isMention: boolean;
  attachments: SlackInputAttachment[];
};

type SlackThreadMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  slackMessageTs?: string;
  slackUser?: string;
};

type SlackThreadState = {
  messages: SlackThreadMessage[];
  updatedAt: string | null;
};

type AiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type AiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: AiToolCall[];
  tool_call_id?: string;
};

type ArtifactToolResult =
  | { ok: true; filename: string }
  | { ok: false; error: string };

type PlainTextArtifactToolCallResult =
  | { ok: true; toolCall: AiToolCall }
  | { ok: false; error: string; snippet: string };

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

    this.setState({
      messages: messagesWithQuestion,
      updatedAt: now,
    });

    const response = await this.generateAnswer(messagesWithQuestion, input, logger);
    const answeredAt = new Date().toISOString();

    this.setState({
      messages: trimMessages(
        [
          ...messagesWithQuestion,
          {
            role: "assistant",
            content: formatAssistantMessage(response),
            createdAt: answeredAt,
          },
        ],
        maxThreadMessages,
      ),
      updatedAt: answeredAt,
    });

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
          extractAiResponsePayload(response, roundLogger),
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

function isSlackAnswerRequest(value: unknown): value is SlackAnswerRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    isNonEmptyString(candidate.channel) &&
    isNonEmptyString(candidate.threadTs) &&
    isNonEmptyString(candidate.messageTs) &&
    isNonEmptyString(candidate.user) &&
    typeof candidate.text === "string" &&
    typeof candidate.isMention === "boolean" &&
    Array.isArray(candidate.attachments) &&
    candidate.attachments.every(isSlackInputAttachment) &&
    (candidate.text.trim().length > 0 || candidate.attachments.length > 0)
  );
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

function trimMessages(
  messages: SlackThreadMessage[],
  maxThreadMessages = defaultMaxThreadMessages,
): SlackThreadMessage[] {
  return messages.slice(-maxThreadMessages);
}

function buildSystemPrompt(basePrompt: string): string {
  return `${basePrompt}

Use available MCP tools when they can provide fresher or more precise context than the Slack thread alone. Prefer Context7 MCP tools for software library and framework documentation lookups before answering documentation-sensitive implementation questions.

When a downloadable artifact is useful, call the ${artifactToolName} tool instead of pasting large content into Slack. Use the actual function/tool calling interface only; never print literal tool-call markup such as <|tool_call>, call:${artifactToolName}, or JSON tool arguments in the Slack reply. Use the tool for complete artifacts such as code files, CSV data, JSON files, markdown documents, or spreadsheet-ready data. After the tool succeeds, reply with a short natural-language summary only. Do not print tool arguments, JSON payloads, or full file contents in the Slack reply.`;
}

function createArtifactToolDefinition(): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: artifactToolName,
      description:
        "Create a downloadable file attachment that the Slack bot will upload to the current thread.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description:
              "The file name including extension, for example HelloWorld.cs or results.csv.",
          },
          mimeType: {
            type: "string",
            description:
              "The MIME type, for example text/plain, text/x-csharp, text/csv, application/json, or text/markdown.",
          },
          content: {
            type: "string",
            description:
              "Plain text file contents. Use this for code, CSV, JSON, markdown, and other text artifacts.",
          },
          contentBase64: {
            type: "string",
            description:
              "Base64-encoded binary file contents. Only use when content is not plain text.",
          },
          title: {
            type: "string",
            description: "Optional display title for Slack.",
          },
          initialComment: {
            type: "string",
            description: "Optional comment shown with the uploaded file.",
          },
        },
        required: ["filename", "mimeType"],
      },
    },
  };
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

function extractAiResponsePayload(
  response: Record<string, unknown>,
  logger: Logger,
): SlackAnswerPayload {
  const text =
    response.response ??
    getFirstChatCompletionMessageContent(response);

  if (typeof text === "string" && text.trim()) {
    return parseStructuredAiResponse(text.trim()) ?? { answer: text.trim() };
  }

  logger.warn("ai_response_payload_missing_text", {
    fallbackReason: "missing_response_text",
    hasChoices: Array.isArray(response.choices),
    responseKeys: Object.keys(response),
    responseShape: summarizeAiResponse(response, defaultAiLogResponseSnippetChars),
  });

  return { answer: "I could not generate an answer for that message." };
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

function summarizeAiResponse(
  response: Record<string, unknown>,
  maxStringLength: number,
): unknown {
  const firstChoice = getFirstChatCompletionChoice(response);
  const message = getFirstChatCompletionMessage(response);
  const messageContent = message?.content;
  const legacyResponse = response.response;

  return logValueSnippet(
    {
      responseKeys: Object.keys(response),
      responseText:
        typeof legacyResponse === "string" ? legacyResponse : undefined,
      choiceCount: Array.isArray(response.choices) ? response.choices.length : 0,
      finishReason:
        firstChoice && typeof firstChoice.finish_reason === "string"
          ? firstChoice.finish_reason
          : undefined,
      messageKeys: message ? Object.keys(message) : [],
      messageContent:
        typeof messageContent === "string" ? messageContent : undefined,
      messageToolCallCount: Array.isArray(message?.tool_calls)
        ? message.tool_calls.length
        : 0,
      legacyToolCallCount: Array.isArray(response.tool_calls)
        ? response.tool_calls.length
        : 0,
    },
    maxStringLength,
  );
}

function extractPlainTextArtifactToolCall(
  text: string | null,
): PlainTextArtifactToolCallResult | null {
  if (!text || !hasPlainTextToolCallMarker(text)) {
    return null;
  }

  const callIndex = text.indexOf(`call:${artifactToolName}`);
  const toolNameIndex =
    callIndex === -1 ? text.indexOf(artifactToolName) : callIndex;
  if (toolNameIndex === -1) {
    return {
      ok: false,
      error: "Plain-text tool call marker did not target create_artifact.",
      snippet: text.slice(0, 500),
    };
  }

  const braceStart = text.indexOf("{", toolNameIndex);

  if (braceStart === -1) {
    return {
      ok: false,
      error: "Plain-text artifact tool call did not include JSON arguments.",
      snippet: text.slice(0, 500),
    };
  }

  const argumentsJson = extractBalancedJsonObject(text, braceStart);
  if (!argumentsJson) {
    const lenientArguments = parseLenientArtifactToolArguments(text, braceStart);
    if (lenientArguments) {
      return createPlainTextArtifactToolCall(lenientArguments);
    }

    return {
      ok: false,
      error: "Plain-text artifact tool call arguments were not balanced JSON.",
      snippet: text.slice(0, 500),
    };
  }

  const parsedJsonArguments = parseJsonObject(argumentsJson);
  const parsedArguments =
    (isPlainObject(parsedJsonArguments)
      ? parsedJsonArguments
      : null) ??
    parseLenientArtifactToolArguments(text, braceStart);
  if (!parsedArguments) {
    return {
      ok: false,
      error: "Plain-text artifact tool call arguments were not valid JSON.",
      snippet: argumentsJson.slice(0, 500),
    };
  }

  return createPlainTextArtifactToolCall(parsedArguments);
}

function createPlainTextArtifactToolCall(
  parsedArguments: Record<string, unknown>,
): PlainTextArtifactToolCallResult {
  return {
    ok: true,
    toolCall: {
      id: `plain_text_${artifactToolName}`,
      type: "function",
      function: {
        name: artifactToolName,
        arguments: JSON.stringify(parsedArguments),
      },
    },
  };
}

function parseLenientArtifactToolArguments(
  text: string,
  braceStart: number,
): Record<string, unknown> | null {
  const body = text.slice(braceStart + 1);
  if (!hasLenientArtifactTerminator(body)) {
    return null;
  }

  const fields = extractDelimitedArtifactFields(body);
  const content = normalizeOptionalString(fields.content);
  const contentBase64 = normalizeOptionalString(fields.contentBase64);

  if (!content && !contentBase64) {
    return null;
  }

  const filename =
    normalizeOptionalString(fields.filename) ??
    normalizeOptionalString(fields.fileName) ??
    inferArtifactFilename(content ?? "");
  const mimeType =
    normalizeOptionalString(fields.mimeType) ??
    normalizeOptionalString(fields.mime_type) ??
    inferArtifactMimeType(filename, content ?? "");
  const args: Record<string, unknown> = {
    filename,
    mimeType,
  };

  if (content) {
    args.content = content;
  }

  if (contentBase64) {
    args.contentBase64 = contentBase64;
  }

  const title = normalizeOptionalString(fields.title);
  if (title) {
    args.title = title;
  }

  const initialComment = normalizeOptionalString(fields.initialComment);
  if (initialComment) {
    args.initialComment = initialComment;
  }

  return args;
}

function hasLenientArtifactTerminator(body: string): boolean {
  return (
    body.includes("<|tool_end|>") ||
    body.includes("<|/tool_call|>") ||
    body.includes("</tool_call>") ||
    body.includes("<|end|>") ||
    /}\s*(?:$|\n)/.test(body)
  );
}

function extractDelimitedArtifactFields(body: string): Record<string, string> {
  const fieldPattern = /(?:^|[,{]\s*)([A-Za-z][A-Za-z0-9_]*)\s*:\s*<\|"\|>/g;
  const matches = [...body.matchAll(fieldPattern)];
  const fields: Record<string, string> = {};

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const fieldName = match[1];
    if (!fieldName || match.index === undefined) {
      continue;
    }

    const valueStart = match.index + match[0].length;
    const nextMatch = matches[index + 1];
    const valueEnd = nextMatch?.index ?? body.length;
    fields[fieldName] = cleanDelimitedArtifactValue(
      body.slice(valueStart, valueEnd),
    );
  }

  return fields;
}

function cleanDelimitedArtifactValue(value: string): string {
  const endMarkers = [
    "<|tool_end|>",
    "<|/tool_call|>",
    "</tool_call>",
    "<|end|>",
  ];
  let cleaned = value;

  for (const marker of endMarkers) {
    const markerIndex = cleaned.indexOf(marker);
    if (markerIndex !== -1) {
      cleaned = cleaned.slice(0, markerIndex);
    }
  }

  return cleaned
    .replace(/<\|"\|>\s*[,}]?\s*$/g, "")
    .replace(/}\s*$/g, "")
    .trim();
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inferArtifactFilename(content: string): string {
  if (/\busing\s+Telegram\.Bot\b|\bnamespace\b|\bclass\s+\w+/.test(content)) {
    return "TelegramBot.cs";
  }

  return "artifact.txt";
}

function inferArtifactMimeType(filename: string, content: string): string {
  if (filename.endsWith(".cs") || /\busing\s+System\b/.test(content)) {
    return "text/x-csharp";
  }

  if (filename.endsWith(".md")) {
    return "text/markdown";
  }

  if (filename.endsWith(".json")) {
    return "application/json";
  }

  return "text/plain";
}

function hasPlainTextToolCallMarker(text: string): boolean {
  return (
    text.includes("<|tool_call>") ||
    text.includes(`call:${artifactToolName}`) ||
    text.includes(`<tool_call>${artifactToolName}`)
  );
}

function extractBalancedJsonObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function getToolCalls(response: Record<string, unknown>): AiToolCall[] {
  const chatCompletionToolCalls = getFirstChatCompletionMessageToolCalls(response);
  if (chatCompletionToolCalls.length > 0) {
    return chatCompletionToolCalls;
  }

  const legacyToolCalls = response.tool_calls;
  if (!Array.isArray(legacyToolCalls)) {
    return [];
  }

  return legacyToolCalls
    .map((toolCall, index) => normalizeToolCall(toolCall, `legacy_tool_${index}`))
    .filter((toolCall): toolCall is AiToolCall => Boolean(toolCall));
}

function getFirstChatCompletionMessageToolCalls(
  response: Record<string, unknown>,
): AiToolCall[] {
  const message = getFirstChatCompletionMessage(response);
  if (!message) {
    return [];
  }

  const toolCalls = message.tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall, index) => normalizeToolCall(toolCall, `tool_${index}`))
    .filter((toolCall): toolCall is AiToolCall => Boolean(toolCall));
}

function normalizeToolCall(value: unknown, fallbackId: string): AiToolCall | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const fn = candidate.function;
  if (!fn || typeof fn !== "object") {
    return null;
  }

  const functionCandidate = fn as Record<string, unknown>;
  if (!isNonEmptyString(functionCandidate.name)) {
    return null;
  }

  const toolArguments = stringifyToolArguments(functionCandidate.arguments);
  if (!toolArguments) {
    return null;
  }

  return {
    id: isNonEmptyString(candidate.id) ? candidate.id : fallbackId,
    type: "function",
    function: {
      name: functionCandidate.name,
      arguments: toolArguments,
    },
  };
}

function stringifyToolArguments(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }

  return null;
}

function executeArtifactToolCall(
  toolCall: AiToolCall,
  files: SlackGeneratedFile[],
): ArtifactToolResult {
  if (toolCall.function.name !== artifactToolName) {
    return { ok: false, error: `Unknown tool: ${toolCall.function.name}` };
  }

  if (files.length >= maxGeneratedFiles) {
    return {
      ok: false,
      error: `Cannot create more than ${maxGeneratedFiles} files in one response.`,
    };
  }

  const args = parseJsonObject(toolCall.function.arguments);
  const file = normalizeGeneratedFile(args);

  if (!file) {
    return {
      ok: false,
      error:
        "Invalid artifact arguments. Provide filename, mimeType, and either content or contentBase64 within size limits.",
    };
  }

  files.push(file);

  return { ok: true, filename: file.filename };
}

function parseStructuredAiResponse(text: string): SlackAnswerPayload | null {
  const parsed = getJsonCandidates(text)
    .map(parseJsonObject)
    .find((candidate) => candidate !== null);

  if (!parsed) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  if (!isNonEmptyString(candidate.answer)) {
    return null;
  }

  const files = normalizeGeneratedFiles(candidate.files);

  return files.length > 0
    ? { answer: candidate.answer.trim(), files }
    : { answer: candidate.answer.trim() };
}

function normalizeGeneratedFiles(value: unknown): SlackGeneratedFile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, maxGeneratedFiles)
    .map(normalizeGeneratedFile)
    .filter((file): file is SlackGeneratedFile => Boolean(file));
}

function normalizeGeneratedFile(value: unknown): SlackGeneratedFile | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const contentBase64 = isNonEmptyString(candidate.contentBase64)
    ? candidate.contentBase64
    : isNonEmptyString(candidate.content)
      ? stringToBase64(candidate.content)
      : undefined;

  const normalized = {
    filename: candidate.filename,
    mimeType: candidate.mimeType,
    contentBase64,
    title: candidate.title,
    initialComment: candidate.initialComment,
  };

  if (!isSlackGeneratedFile(normalized)) {
    return null;
  }

  if (base64DecodedByteLength(normalized.contentBase64) > maxGeneratedFileBytes) {
    return null;
  }

  return normalized;
}

function parseJsonObject(text: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(text);

    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getJsonCandidates(text: string): string[] {
  const candidates = [text.trim()];
  const fencedJson = extractFencedJson(text);
  const embeddedJson = extractEmbeddedJsonObject(text);

  if (fencedJson) {
    candidates.push(fencedJson);
  }

  if (embeddedJson) {
    candidates.push(embeddedJson);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function extractFencedJson(text: string): string | null {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);

  return fenceMatch?.[1]?.trim() || null;
}

function extractEmbeddedJsonObject(text: string): string | null {
  const startIndex = text.indexOf("{");
  const endIndex = text.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  return text.slice(startIndex, endIndex + 1).trim();
}

function stringToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64DecodedByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;

  return Math.floor((value.length * 3) / 4) - padding;
}

function getFirstChatCompletionMessageContent(
  response: Record<string, unknown>,
): unknown {
  const message = getFirstChatCompletionMessage(response);

  return message?.content;
}

function getFirstChatCompletionMessageText(
  response: Record<string, unknown>,
): string | null {
  const content = getFirstChatCompletionMessageContent(response);

  return typeof content === "string" ? content : null;
}

function getFirstChatCompletionMessage(
  response: Record<string, unknown>,
): Record<string, unknown> | null {
  const firstChoice = getFirstChatCompletionChoice(response);
  if (!firstChoice) {
    return null;
  }

  const message = firstChoice.message;

  if (!message || typeof message !== "object") {
    return null;
  }

  return message as Record<string, unknown>;
}

function getFirstChatCompletionChoice(
  response: Record<string, unknown>,
): Record<string, unknown> | null {
  const choices = response.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const [firstChoice] = choices;

  if (!firstChoice || typeof firstChoice !== "object") {
    return null;
  }

  return firstChoice as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
