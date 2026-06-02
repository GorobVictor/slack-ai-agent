import type { SlackAnswerPayload } from "../shared/slackAttachments";
import { isNonEmptyString, parseJsonObject } from "../shared/jsonGuards";
import { normalizeGeneratedFiles } from "./artifactTool";
import type { AiToolCall } from "./aiTypes";
import { logValueSnippet, type Logger } from "./logger";

export function extractAiResponsePayload(
  response: Record<string, unknown>,
  logger: Logger,
  maxSnippetCharacters: number,
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
    responseShape: summarizeAiResponse(response, maxSnippetCharacters),
  });

  return { answer: "I could not generate an answer for that message." };
}

export function parseStructuredAiResponse(text: string): SlackAnswerPayload | null {
  const parsed = getJsonCandidates(text)
    .map(parseJsonObject)
    .find((candidate) => candidate !== null);

  if (!parsed || !isNonEmptyString(parsed.answer)) {
    return null;
  }

  const files = normalizeGeneratedFiles(parsed.files);

  return files.length > 0
    ? { answer: parsed.answer.trim(), files }
    : { answer: parsed.answer.trim() };
}

export function summarizeAiResponse(
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

export function getToolCalls(response: Record<string, unknown>): AiToolCall[] {
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

export function getFirstChatCompletionMessageContent(
  response: Record<string, unknown>,
): unknown {
  const message = getFirstChatCompletionMessage(response);

  return message?.content;
}

export function getFirstChatCompletionMessageText(
  response: Record<string, unknown>,
): string | null {
  const content = getFirstChatCompletionMessageContent(response);

  return typeof content === "string" ? content : null;
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
