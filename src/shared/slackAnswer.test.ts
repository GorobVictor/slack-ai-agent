import { describe, expect, it } from "vitest";

import { isSlackAnswerRequest } from "./slackAnswer.js";

const validRequest = {
  channel: "C123",
  threadTs: "1710000000.000001",
  messageTs: "1710000000.000002",
  user: "U123",
  text: "hello",
  isMention: true,
  attachments: [],
};

describe("isSlackAnswerRequest", () => {
  it("accepts a valid text request", () => {
    expect(isSlackAnswerRequest(validRequest)).toBe(true);
  });

  it("accepts an attachment-only request", () => {
    expect(
      isSlackAnswerRequest({
        ...validRequest,
        text: "",
        attachments: [
          {
            id: "F123",
            name: "notes.txt",
            mimeType: "text/plain",
            size: 12,
            contentKind: "text",
            text: "notes",
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects empty requests", () => {
    expect(
      isSlackAnswerRequest({
        ...validRequest,
        text: "   ",
        attachments: [],
      }),
    ).toBe(false);
  });

  it("rejects invalid attachments", () => {
    expect(
      isSlackAnswerRequest({
        ...validRequest,
        attachments: [{ id: "F123", contentKind: "text" }],
      }),
    ).toBe(false);
  });
});
