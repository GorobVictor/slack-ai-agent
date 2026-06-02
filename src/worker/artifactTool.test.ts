import { describe, expect, it } from "vitest";

import { maxGeneratedFileBytes, maxGeneratedFiles } from "../shared/limits";
import type { SlackGeneratedFile } from "../shared/slackAttachments";
import {
  artifactToolName,
  executeArtifactToolCall,
  extractPlainTextArtifactToolCall,
} from "./artifactTool";
import type { AiToolCall } from "./aiTypes";

describe("executeArtifactToolCall", () => {
  it("creates a generated file from text content", () => {
    const files: SlackGeneratedFile[] = [];
    const result = executeArtifactToolCall(
      toolCall({
        filename: "hello.txt",
        mimeType: "text/plain",
        content: "hello",
      }),
      files,
    );

    expect(result).toEqual({ ok: true, filename: "hello.txt" });
    expect(atob(files[0]?.contentBase64 ?? "")).toBe("hello");
  });

  it("rejects files beyond the configured count", () => {
    const files = Array.from({ length: maxGeneratedFiles }, (_, index) => ({
      filename: `file-${index}.txt`,
      mimeType: "text/plain",
      contentBase64: btoa("x"),
    }));

    const result = executeArtifactToolCall(
      toolCall({
        filename: "extra.txt",
        mimeType: "text/plain",
        content: "extra",
      }),
      files,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects oversized generated files", () => {
    const oversizedContent = btoa("a".repeat(maxGeneratedFileBytes + 1));
    const result = executeArtifactToolCall(
      toolCall({
        filename: "large.bin",
        mimeType: "application/octet-stream",
        contentBase64: oversizedContent,
      }),
      [],
    );

    expect(result.ok).toBe(false);
  });
});

describe("extractPlainTextArtifactToolCall", () => {
  it("converts plain text tool-call markup into a real tool call", () => {
    const result = extractPlainTextArtifactToolCall(
      `<|tool_call>call:${artifactToolName} {"filename":"hello.txt","mimeType":"text/plain","content":"hello"}<|tool_end|>`,
    );

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.toolCall.function.name).toBe(artifactToolName);
      expect(JSON.parse(result.toolCall.function.arguments)).toMatchObject({
        filename: "hello.txt",
        mimeType: "text/plain",
        content: "hello",
      });
    }
  });

  it("infers a generic C# filename for lenient artifact markup", () => {
    const result = extractPlainTextArtifactToolCall(
      `<|tool_call>call:${artifactToolName} {content: <|"|>using Telegram.Bot;\nclass Bot {}\n<|"|>}<|tool_end|>`,
    );

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(JSON.parse(result.toolCall.function.arguments)).toMatchObject({
        filename: "artifact.cs",
        mimeType: "text/x-csharp",
      });
    }
  });

  it("reports malformed plain text tool calls", () => {
    const result = extractPlainTextArtifactToolCall(
      `<|tool_call>call:${artifactToolName} missing-json<|tool_end|>`,
    );

    expect(result).toMatchObject({ ok: false });
  });
});

function toolCall(argumentsValue: Record<string, unknown>): AiToolCall {
  return {
    id: "tool-1",
    type: "function",
    function: {
      name: artifactToolName,
      arguments: JSON.stringify(argumentsValue),
    },
  };
}
