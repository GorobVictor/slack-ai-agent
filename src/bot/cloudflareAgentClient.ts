import type {
  SlackAnswerPayload,
} from "../shared/slackAttachments.js";
import { isSlackAnswerPayload } from "../shared/slackAttachments.js";
import type { SlackAnswerInput } from "../shared/slackAnswer.js";
export type { SlackAnswerInput } from "../shared/slackAnswer.js";

export interface SlackAnswerClient {
  generateAnswer(input: SlackAnswerInput): Promise<SlackAnswerPayload>;
}

export type SlackAnswerClientErrorKind =
  | "timeout"
  | "http"
  | "invalid-response";

export class SlackAnswerClientError extends Error {
  constructor(
    readonly kind: SlackAnswerClientErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SlackAnswerClientError";
  }
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
        throw new SlackAnswerClientError(
          "http",
          `Cloudflare agent request failed with status ${response.status}: ${await response.text()}`,
          response.status,
        );
      }

      const body: unknown = await response.json();

      if (!isSlackAnswerPayload(body)) {
        throw new SlackAnswerClientError(
          "invalid-response",
          "Cloudflare agent returned an invalid response.",
        );
      }

      return {
        ...body,
        answer: body.answer.trim(),
      };
    } catch (error) {
      if (error instanceof SlackAnswerClientError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new SlackAnswerClientError(
          "timeout",
          `Cloudflare agent request timed out after ${this.timeoutMs} ms.`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
