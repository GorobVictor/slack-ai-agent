export type SlackAnswerInput = {
  channel: string;
  threadTs: string;
  messageTs: string;
  user: string;
  text: string;
  isMention: boolean;
};

export interface SlackAnswerClient {
  generateAnswer(input: SlackAnswerInput): Promise<string>;
}

export class CloudflareSlackAnswerClient implements SlackAnswerClient {
  constructor(
    private readonly endpointUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  async generateAnswer(input: SlackAnswerInput): Promise<string> {
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

      if (!isAnswerResponse(body)) {
        throw new Error("Cloudflare agent returned an invalid response.");
      }

      return body.answer.trim();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isAnswerResponse(value: unknown): value is { answer: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return typeof candidate.answer === "string" && candidate.answer.trim().length > 0;
}
