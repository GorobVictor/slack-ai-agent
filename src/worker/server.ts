import { Agent } from "agents";

const answerPath = "/slack/answer";
const defaultModel = "@cf/meta/llama-3.1-8b-instruct-fp8";
const defaultSystemPrompt =
  "You are a helpful assistant inside Slack. Answer clearly and concisely. Use the Slack thread context when it is useful. Reply in the same language the user used in their latest message. If the language is ambiguous, match the dominant language in the current Slack thread.";
const defaultMaxTokens = 700;
const defaultTemperature = 0.4;
const defaultMaxThreadMessages = 20;
const maxRequestBytes = 64 * 1024;

type SlackAnswerRequest = {
  channel: string;
  threadTs: string;
  messageTs: string;
  user: string;
  text: string;
  isMention: boolean;
};

type SlackAnswerResponse = {
  answer: string;
};

type SlackThreadMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  slackMessageTs?: string;
  slackUser?: string;
};

type SlackThreadState = {
  messages: SlackThreadMessage[];
  updatedAt: string | null;
};

export class SlackThreadAgent extends Agent<Env, SlackThreadState> {
  initialState: SlackThreadState = {
    messages: [],
    updatedAt: null,
  };

  async answer(input: SlackAnswerRequest): Promise<SlackAnswerResponse> {
    const maxThreadMessages = readPositiveInteger(
      this.env.AI_MAX_THREAD_MESSAGES,
      defaultMaxThreadMessages,
    );
    const now = new Date().toISOString();
    const userMessage: SlackThreadMessage = {
      role: "user",
      content: formatUserMessage(input),
      createdAt: now,
      slackMessageTs: input.messageTs,
      slackUser: input.user,
    };

    const messagesWithQuestion = trimMessages([
      ...this.state.messages,
      userMessage,
    ], maxThreadMessages);

    this.setState({
      messages: messagesWithQuestion,
      updatedAt: now,
    });

    const answer = await this.generateAnswer(messagesWithQuestion);
    const answeredAt = new Date().toISOString();

    this.setState({
      messages: trimMessages(
        [
          ...messagesWithQuestion,
          {
            role: "assistant",
            content: answer,
            createdAt: answeredAt,
          },
        ],
        maxThreadMessages,
      ),
      updatedAt: answeredAt,
    });

    return { answer };
  }

  private async generateAnswer(
    threadMessages: SlackThreadMessage[],
  ): Promise<string> {
    const model = readNonEmptyString(this.env.WORKERS_AI_MODEL, defaultModel);
    const response = await this.env.AI.run(model, {
      messages: [
        {
          role: "system",
          content: readNonEmptyString(this.env.AI_SYSTEM_PROMPT, defaultSystemPrompt),
        },
        ...threadMessages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
      max_tokens: readPositiveInteger(this.env.AI_MAX_TOKENS, defaultMaxTokens),
      temperature: readNumber(this.env.AI_TEMPERATURE, defaultTemperature),
    });

    return extractAiResponse(response);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method !== "POST" || url.pathname !== answerPath) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const authResult = await authenticate(request, env);
    if (!authResult.ok) {
      return Response.json({ error: authResult.error }, { status: authResult.status });
    }

    const body = await readAnswerRequest(request);
    if (!body.ok) {
      return Response.json({ error: body.error }, { status: body.status });
    }

    const threadKey = `${body.value.channel}:${body.value.threadTs}`;
    const answer = await env.SLACK_THREAD_AGENT.getByName(threadKey).answer(body.value);

    return Response.json(answer);
  },
} satisfies ExportedHandler<Env>;

async function authenticate(
  request: Request,
  env: Env & { AGENT_AUTH_TOKEN?: string },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const expectedToken = env.AGENT_AUTH_TOKEN;

  if (!expectedToken) {
    return { ok: false, status: 500, error: "Agent auth token is not configured" };
  }

  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  if (!constantTimeEqual(token, expectedToken)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true };
}

async function readAnswerRequest(
  request: Request,
): Promise<
  | { ok: true; value: SlackAnswerRequest }
  | { ok: false; status: number; error: string }
> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxRequestBytes) {
    return { ok: false, status: 413, error: "Request body is too large" };
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return { ok: false, status: 400, error: "Request body must be valid JSON" };
  }

  if (!isSlackAnswerRequest(rawBody)) {
    return { ok: false, status: 400, error: "Invalid Slack answer request" };
  }

  return {
    ok: true,
    value: {
      ...rawBody,
      text: cleanSlackText(rawBody.text),
    },
  };
}

function isSlackAnswerRequest(value: unknown): value is SlackAnswerRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    isNonEmptyString(candidate.channel) &&
    isNonEmptyString(candidate.threadTs) &&
    isNonEmptyString(candidate.messageTs) &&
    isNonEmptyString(candidate.user) &&
    isNonEmptyString(candidate.text) &&
    typeof candidate.isMention === "boolean"
  );
}

function formatUserMessage(input: SlackAnswerRequest): string {
  const mentionPrefix = input.isMention ? "Mention" : "Thread reply";

  return `${mentionPrefix} from Slack user ${input.user}: ${input.text}`;
}

function cleanSlackText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();
}

function trimMessages(
  messages: SlackThreadMessage[],
  maxThreadMessages = defaultMaxThreadMessages,
): SlackThreadMessage[] {
  return messages.slice(-maxThreadMessages);
}

function extractAiResponse(response: Record<string, unknown>): string {
  const text = response.response;

  if (typeof text === "string" && text.trim()) {
    return text.trim();
  }

  return "I could not generate an answer for that message.";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readNonEmptyString(value: unknown, defaultValue: string): string {
  return isNonEmptyString(value) ? value : defaultValue;
}

function readPositiveInteger(value: unknown, defaultValue: number): number {
  const numberValue = readNumber(value, defaultValue);

  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return defaultValue;
  }

  return numberValue;
}

function readNumber(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const numberValue = Number(value);

    if (Number.isFinite(numberValue)) {
      return numberValue;
    }
  }

  return defaultValue;
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}
