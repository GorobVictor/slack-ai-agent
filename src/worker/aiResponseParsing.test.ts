import { describe, expect, it, vi } from "vitest";

import {
  extractAiResponsePayload,
  getFirstChatCompletionMessageText,
  getToolCalls,
  parseStructuredAiResponse,
} from "./aiResponseParsing";

describe("parseStructuredAiResponse", () => {
  it("parses a fenced JSON answer", () => {
    expect(
      parseStructuredAiResponse(
        '```json\n{"answer":"Done","files":[{"filename":"a.txt","mimeType":"text/plain","contentBase64":"YQ=="}]}\n```',
      ),
    ).toEqual({
      answer: "Done",
      files: [
        {
          filename: "a.txt",
          mimeType: "text/plain",
          contentBase64: "YQ==",
        },
      ],
    });
  });

  it("returns null for text without a structured answer", () => {
    expect(parseStructuredAiResponse("plain answer")).toBeNull();
  });
});

describe("extractAiResponsePayload", () => {
  it("returns legacy response text as an answer", () => {
    const logger = { warn: vi.fn() };

    expect(
      extractAiResponsePayload({ response: "hello" }, logger as never, 200),
    ).toEqual({ answer: "hello" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns a fallback and logs missing text", () => {
    const logger = { warn: vi.fn() };

    expect(extractAiResponsePayload({}, logger as never, 200)).toEqual({
      answer: "I could not generate an answer for that message.",
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe("Workers AI response helpers", () => {
  it("reads chat completion text", () => {
    expect(
      getFirstChatCompletionMessageText({
        choices: [{ message: { content: "chat text" } }],
      }),
    ).toBe("chat text");
  });

  it("normalizes chat completion tool calls", () => {
    expect(
      getToolCalls({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "abc",
                  function: {
                    name: "create_artifact",
                    arguments: { filename: "a.txt" },
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      {
        id: "abc",
        type: "function",
        function: {
          name: "create_artifact",
          arguments: '{"filename":"a.txt"}',
        },
      },
    ]);
  });
});
