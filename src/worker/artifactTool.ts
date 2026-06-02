import type { SlackGeneratedFile } from "../shared/slackAttachments";
import { isSlackGeneratedFile } from "../shared/slackAttachments";
import {
  maxGeneratedFileBytes,
  maxGeneratedFiles,
} from "../shared/limits";
import {
  isNonEmptyString,
  isPlainObject,
  parseJsonObject,
} from "../shared/jsonGuards";
import type { AiToolCall } from "./aiTypes";

export const artifactToolName = "create_artifact";

export type ArtifactToolResult =
  | { ok: true; filename: string }
  | { ok: false; error: string };

export type PlainTextArtifactToolCallResult =
  | { ok: true; toolCall: AiToolCall }
  | { ok: false; error: string; snippet: string };

export function createArtifactToolDefinition(): Record<string, unknown> {
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

export function executeArtifactToolCall(
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

export function normalizeGeneratedFiles(value: unknown): SlackGeneratedFile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, maxGeneratedFiles)
    .map(normalizeGeneratedFile)
    .filter((file): file is SlackGeneratedFile => Boolean(file));
}

export function normalizeGeneratedFile(value: unknown): SlackGeneratedFile | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const contentBase64 = isNonEmptyString(value.contentBase64)
    ? value.contentBase64
    : isNonEmptyString(value.content)
      ? stringToBase64(value.content)
      : undefined;

  const normalized = {
    filename: value.filename,
    mimeType: value.mimeType,
    contentBase64,
    title: value.title,
    initialComment: value.initialComment,
  };

  if (!isSlackGeneratedFile(normalized)) {
    return null;
  }

  if (base64DecodedByteLength(normalized.contentBase64) > maxGeneratedFileBytes) {
    return null;
  }

  return normalized;
}

export function extractPlainTextArtifactToolCall(
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

  const parsedArguments =
    parseJsonObject(argumentsJson) ??
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
  if (/\busing\s+(?:System|[A-Z][\w.]+)\b|\bnamespace\b|\bclass\s+\w+/.test(content)) {
    return "artifact.cs";
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
