import { describe, expect, it } from "vitest";

import {
  buildAnsweredThreadState,
  trimMessages,
  type SlackThreadMessage,
} from "./threadState";

describe("thread state helpers", () => {
  it("commits user and assistant turns together after a successful answer", () => {
    const messagesWithQuestion: SlackThreadMessage[] = [
      {
        role: "user",
        content: "question",
        createdAt: "2026-06-02T12:00:00.000Z",
        slackMessageTs: "1710000000.000001",
        slackUser: "U123",
      },
    ];

    expect(
      buildAnsweredThreadState({
        messagesWithQuestion,
        assistantContent: "answer",
        answeredAt: "2026-06-02T12:00:01.000Z",
        maxThreadMessages: 10,
      }),
    ).toEqual({
      messages: [
        messagesWithQuestion[0],
        {
          role: "assistant",
          content: "answer",
          createdAt: "2026-06-02T12:00:01.000Z",
        },
      ],
      updatedAt: "2026-06-02T12:00:01.000Z",
    });
  });

  it("trims older messages", () => {
    const messages = ["one", "two", "three"].map((content) => ({
      role: "user" as const,
      content,
      createdAt: "2026-06-02T12:00:00.000Z",
    }));

    expect(trimMessages(messages, 2).map((message) => message.content)).toEqual([
      "two",
      "three",
    ]);
  });
});
