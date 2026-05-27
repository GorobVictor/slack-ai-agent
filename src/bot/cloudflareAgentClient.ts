import type {
  SlackAnswerPayload,
  SlackInputAttachment,
} from "../shared/slackAttachments.js";
import { isSlackAnswerPayload } from "../shared/slackAttachments.js";

export type SlackAnswerInput = {
  channel: string;
  threadTs: string;
  messageTs: string;
  user: string;
  text: string;
  isMention: boolean;
  attachments: SlackInputAttachment[];
};

export interface SlackAnswerClient {
  generateAnswer(input: SlackAnswerInput): Promise<SlackAnswerPayload>;
}

export class CloudflareSlackAnswerClient implements SlackAnswerClient {
  constructor(
    private readonly endpointUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  async generateAnswer(input: SlackAnswerInput): Promise<SlackAnswerPayload> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.endpointUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Cloudflare agent request failed with status ${response.status}: ${await response.text()}`,
        );
      }

      const body: unknown = await response.json();

      if (!isSlackAnswerPayload(body)) {
        throw new Error("Cloudflare agent returned an invalid response.");
      }

      return {
        ...body,
        answer: body.answer.trim(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
