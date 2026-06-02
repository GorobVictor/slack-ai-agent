import type { SlackInputAttachment } from "./slackAttachments.js";
import { isSlackInputAttachment } from "./slackAttachments.js";
import { isNonEmptyString, isPlainObject, isOptionalString } from "./jsonGuards.js";

export type SlackAnswerRequest = {
  requestId?: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  user: string;
  text: string;
  isMention: boolean;
  attachments: SlackInputAttachment[];
};

export type SlackAnswerInput = Omit<SlackAnswerRequest, "requestId">;

export function isSlackAnswerRequest(value: unknown): value is SlackAnswerRequest {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    isOptionalString(value.requestId) &&
    isNonEmptyString(value.channel) &&
    isNonEmptyString(value.threadTs) &&
    isNonEmptyString(value.messageTs) &&
    isNonEmptyString(value.user) &&
    typeof value.text === "string" &&
    typeof value.isMention === "boolean" &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isSlackInputAttachment) &&
    (value.text.trim().length > 0 || value.attachments.length > 0)
  );
}
