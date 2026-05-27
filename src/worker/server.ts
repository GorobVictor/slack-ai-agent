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

const answerPath = "/slack/answer";
const defaultModel = "@cf/meta/llama-3.1-8b-instruct-fp8";
const defaultImageToTextModel = "@cf/meta/llama-3.2-11b-vision-instruct";
const defaultSystemPrompt =
  "You are a helpful assistant inside Slack. Answer clearly and concisely. Use the Slack thread context when it is useful. Reply in the same language the user used in their latest message. If the language is ambiguous, match the dominant language in the current Slack thread.";
const defaultMaxTokens = 700;
const defaultTemperature = 0.4;
const defaultMaxThreadMessages = 20;
const maxRequestBytes = 1024 * 1024;
const maxGeneratedFiles = 5;
const maxGeneratedFileBytes = 1024 * 1024;
const maxArtifactToolRounds = 3;
const artifactToolName = "create_artifact";

type SlackAnswerRequest = {
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

export class SlackThreadAgent extends Agent<Env, SlackThreadState> {
  initialState: SlackThreadState = {
    messages: [],
    updatedAt: null,
  };

  async answer(input: SlackAnswerRequest): Promise<SlackAnswerPayload> {
    const maxThreadMessages = readPositiveInteger(
      this.env.AI_MAX_THREAD_MESSAGES,
      defaultMaxThreadMessages,
    );
    const now = new Date().toISOString();
    const attachments = await this.describeImageAttachments(input.attachments);
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

    const response = await this.generateAnswer(messagesWithQuestion);
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

    return response;
  }

  private async describeImageAttachments(
    attachments: SlackInputAttachment[],
  ): Promise<SlackInputAttachment[]> {
    return Promise.all(
      attachments.map(async (attachment) => {
        if (attachment.contentKind !== "image" || !attachment.dataBase64) {
          return attachment;
        }

        try {
          const response = await this.env.AI.run(defaultImageToTextModel, {
            prompt:
              "Describe this Slack image for an assistant that will answer a user message. Include visible text, objects, and any relevant context.",
            image: attachment.dataBase64,
            max_tokens: 300,
          });
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
        } catch {
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
  ): Promise<SlackAnswerPayload> {
    const model = readNonEmptyString(this.env.WORKERS_AI_MODEL, defaultModel);
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
    const maxTokens = readPositiveInteger(this.env.AI_MAX_TOKENS, defaultMaxTokens);
    const temperature = readNumber(this.env.AI_TEMPERATURE, defaultTemperature);

    for (let round = 0; round < maxArtifactToolRounds; round += 1) {
      const response = await this.env.AI.run(model, {
        messages,
        tools: [createArtifactToolDefinition()],
        tool_choice: "auto",
        parallel_tool_calls: false,
        max_tokens: maxTokens,
        temperature,
      });
      const toolCalls = getToolCalls(response);

      if (toolCalls.length === 0) {
        return mergeAnswerWithGeneratedFiles(
          extractAiResponsePayload(response),
          files,
        );
      }

      messages.push({
        role: "assistant",
        content: getFirstChatCompletionMessageText(response),
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const result = executeArtifactToolCall(toolCall, files);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }

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
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method !== "POST" || url.pathname !== answerPath) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const authResult = await authenticate(request, env);
    if (!authResult.ok) {
      return Response.json({ error: authResult.error }, { status: authResult.status });
    }

    const body = await readAnswerRequest(request);
    if (!body.ok) {
      return Response.json({ error: body.error }, { status: body.status });
    }

    const threadKey = `${body.value.channel}:${body.value.threadTs}`;
    const answer = await env.SLACK_THREAD_AGENT.getByName(threadKey).answer(body.value);

    return Response.json(answer);
  },
} satisfies ExportedHandler<Env>;

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

When a downloadable artifact is useful, call the ${artifactToolName} tool instead of pasting large content into Slack. Use the tool for complete artifacts such as code files, CSV data, JSON files, markdown documents, or spreadsheet-ready data. After the tool succeeds, reply with a short natural-language summary only. Do not print tool arguments, JSON payloads, or full file contents in the Slack reply.`;
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

function extractAiResponsePayload(response: Record<string, unknown>): SlackAnswerPayload {
  const text =
    response.response ??
    getFirstChatCompletionMessageContent(response);

  if (typeof text === "string" && text.trim()) {
    return parseStructuredAiResponse(text.trim()) ?? { answer: text.trim() };
  }

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
  const choices = response.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const [firstChoice] = choices;

  if (!firstChoice || typeof firstChoice !== "object") {
    return null;
  }

  const message = (firstChoice as Record<string, unknown>).message;

  if (!message || typeof message !== "object") {
    return null;
  }

  return message as Record<string, unknown>;
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
