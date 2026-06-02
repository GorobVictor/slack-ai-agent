export type SlackThreadMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  slackMessageTs?: string;
  slackUser?: string;
};

export type SlackThreadState = {
  messages: SlackThreadMessage[];
  updatedAt: string | null;
};

export function trimMessages(
  messages: SlackThreadMessage[],
  maxThreadMessages: number,
): SlackThreadMessage[] {
  return messages.slice(-maxThreadMessages);
}

export function buildAnsweredThreadState(input: {
  messagesWithQuestion: SlackThreadMessage[];
  assistantContent: string;
  answeredAt: string;
  maxThreadMessages: number;
}): SlackThreadState {
  return {
    messages: trimMessages(
      [
        ...input.messagesWithQuestion,
        {
          role: "assistant",
          content: input.assistantContent,
          createdAt: input.answeredAt,
        },
      ],
      input.maxThreadMessages,
    ),
    updatedAt: input.answeredAt,
  };
}
