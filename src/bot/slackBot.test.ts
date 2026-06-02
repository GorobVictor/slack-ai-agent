import { describe, expect, it } from "vitest";

import { formatSlackMrkdwnMessage } from "./slackBot.js";

describe("formatSlackMrkdwnMessage", () => {
  it("formats a short answer as a Slack mrkdwn section block", () => {
    const message = formatSlackMrkdwnMessage("*Hello* with `code`");

    expect(message).toEqual({
      text: "*Hello* with `code`",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Hello* with `code`",
          },
        },
      ],
    });
  });

  it("splits long answers into multiple mrkdwn section blocks", () => {
    const answer = `${"a".repeat(2_500)}\n${"b".repeat(2_500)}`;
    const message = formatSlackMrkdwnMessage(answer);

    expect(message.text).toBe(answer);
    expect(message.blocks).toHaveLength(2);
    expect(message.blocks.every((block) => block.text.text.length <= 3_000)).toBe(
      true,
    );
    expect(message.blocks.map((block) => block.text.type)).toEqual([
      "mrkdwn",
      "mrkdwn",
    ]);
    expect(message.blocks.map((block) => block.text.text).join("")).toBe(answer);
  });

  it("splits long words at the Slack section text limit", () => {
    const answer = "x".repeat(3_100);
    const message = formatSlackMrkdwnMessage(answer);

    expect(message.blocks).toHaveLength(2);
    expect(message.blocks[0]?.text.text).toHaveLength(3_000);
    expect(message.blocks[1]?.text.text).toHaveLength(100);
  });

  it("leaves answer text unchanged for the model-provided mrkdwn", () => {
    const answer = "**Important** update";
    const message = formatSlackMrkdwnMessage(answer);

    expect(message.text).toBe(answer);
    expect(message.blocks[0]?.text.text).toBe(answer);
  });
});
