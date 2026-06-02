import {
  isNonEmptyString,
  isNonNegativeFiniteNumber,
  isOptionalString,
  isPlainObject,
} from "./jsonGuards.js";

export type SlackInputAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  contentKind: "text" | "image" | "unsupported";
  text?: string;
  dataBase64?: string;
  note?: string;
};

export type SlackGeneratedFile = {
  filename: string;
  mimeType: string;
  contentBase64: string;
  title?: string;
  initialComment?: string;
};

export type SlackAnswerPayload = {
  answer: string;
  files?: SlackGeneratedFile[];
};

export function isSlackInputAttachment(value: unknown): value is SlackInputAttachment {
  if (!isPlainObject(value)) {
    return false;
  }

  const candidate = value;

  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.name) &&
    isNonEmptyString(candidate.mimeType) &&
    isNonNegativeFiniteNumber(candidate.size) &&
    isAttachmentContentKind(candidate.contentKind) &&
    isOptionalString(candidate.text) &&
    isOptionalString(candidate.dataBase64) &&
    isOptionalString(candidate.note)
  );
}

export function isSlackGeneratedFile(value: unknown): value is SlackGeneratedFile {
  if (!isPlainObject(value)) {
    return false;
  }

  const candidate = value;

  return (
    isNonEmptyString(candidate.filename) &&
    isNonEmptyString(candidate.mimeType) &&
    isNonEmptyString(candidate.contentBase64) &&
    isOptionalString(candidate.title) &&
    isOptionalString(candidate.initialComment)
  );
}

export function isSlackAnswerPayload(value: unknown): value is SlackAnswerPayload {
  if (!isPlainObject(value)) {
    return false;
  }

  const candidate = value;

  return (
    isNonEmptyString(candidate.answer) &&
    (candidate.files === undefined ||
      (Array.isArray(candidate.files) && candidate.files.every(isSlackGeneratedFile)))
  );
}

function isAttachmentContentKind(
  value: unknown,
): value is SlackInputAttachment["contentKind"] {
  return value === "text" || value === "image" || value === "unsupported";
}
