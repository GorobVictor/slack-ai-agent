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
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

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
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    isNonEmptyString(candidate.filename) &&
    isNonEmptyString(candidate.mimeType) &&
    isNonEmptyString(candidate.contentBase64) &&
    isOptionalString(candidate.title) &&
    isOptionalString(candidate.initialComment)
  );
}

export function isSlackAnswerPayload(value: unknown): value is SlackAnswerPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    isNonEmptyString(candidate.answer) &&
    (candidate.files === undefined ||
      (Array.isArray(candidate.files) && candidate.files.every(isSlackGeneratedFile)))
  );
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isAttachmentContentKind(
  value: unknown,
): value is SlackInputAttachment["contentKind"] {
  return value === "text" || value === "image" || value === "unsupported";
}
