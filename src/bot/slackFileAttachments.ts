import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { PDFParse } from "pdf-parse";
import readXlsxFile from "read-excel-file/node";

import type { SlackInputAttachment } from "../shared/slackAttachments.js";

export type SlackEventFile = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

type AttachmentLogger = {
  warn(message: string, metadata?: unknown): void;
};

const maxAttachmentCount = 5;
const maxDownloadBytes = 5 * 1024 * 1024;
const maxImageBytes = 512 * 1024;
const maxExtractedTextChars = 20_000;

export async function normalizeSlackFiles(
  files: SlackEventFile[] | undefined,
  slackBotToken: string,
  logger: AttachmentLogger,
): Promise<SlackInputAttachment[]> {
  if (!files?.length) {
    return [];
  }

  const selectedFiles = files.slice(0, maxAttachmentCount);
  const attachments = await Promise.all(
    selectedFiles.map((file) => normalizeSlackFile(file, slackBotToken, logger)),
  );

  if (files.length > maxAttachmentCount) {
    attachments.push({
      id: "attachment-limit",
      name: "additional-files",
      mimeType: "application/octet-stream",
      size: 0,
      contentKind: "unsupported",
      note: `Only the first ${maxAttachmentCount} files were processed.`,
    });
  }

  return attachments;
}

async function normalizeSlackFile(
  file: SlackEventFile,
  slackBotToken: string,
  logger: AttachmentLogger,
): Promise<SlackInputAttachment> {
  const id = file.id?.trim() || randomUUID();
  const name = file.name?.trim() || file.title?.trim() || id;
  const mimeType = file.mimetype?.trim() || "application/octet-stream";
  const size = Number.isFinite(file.size) ? Number(file.size) : 0;
  const downloadUrl = file.url_private_download ?? file.url_private;

  if (!downloadUrl) {
    return unsupportedAttachment(id, name, mimeType, size, "Slack did not provide a private download URL.");
  }

  if (size > maxDownloadBytes) {
    return unsupportedAttachment(
      id,
      name,
      mimeType,
      size,
      `File is larger than the ${formatBytes(maxDownloadBytes)} processing limit.`,
    );
  }

  try {
    const buffer = await downloadSlackFile(downloadUrl, slackBotToken);

    if (buffer.byteLength > maxDownloadBytes) {
      return unsupportedAttachment(
        id,
        name,
        mimeType,
        buffer.byteLength,
        `Downloaded file is larger than the ${formatBytes(maxDownloadBytes)} processing limit.`,
      );
    }

    return await parseAttachment({ id, name, mimeType, size: buffer.byteLength, buffer });
  } catch (error) {
    logger.warn("Failed to normalize Slack file attachment.", { fileId: id, error });

    return unsupportedAttachment(id, name, mimeType, size, "The bot could not download or parse this file.");
  }
}

async function downloadSlackFile(url: string, slackBotToken: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${slackBotToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Slack file download failed with status ${response.status}.`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxDownloadBytes) {
    throw new Error(`Slack file download is larger than ${maxDownloadBytes} bytes.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function parseAttachment(input: {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
}): Promise<SlackInputAttachment> {
  const { id, name, mimeType, size, buffer } = input;

  if (isPdf(mimeType, name)) {
    return {
      id,
      name,
      mimeType,
      size,
      contentKind: "text",
      text: truncateText(await extractPdfText(buffer)),
    };
  }

  if (isSpreadsheet(mimeType, name)) {
    return {
      id,
      name,
      mimeType,
      size,
      contentKind: "text",
      text: truncateText(await extractSpreadsheetText(buffer)),
    };
  }

  if (isTextLike(mimeType, name)) {
    return {
      id,
      name,
      mimeType,
      size,
      contentKind: "text",
      text: truncateText(buffer.toString("utf8")),
    };
  }

  if (mimeType.startsWith("image/")) {
    if (buffer.byteLength > maxImageBytes) {
      return unsupportedAttachment(
        id,
        name,
        mimeType,
        size,
        `Image is larger than the ${formatBytes(maxImageBytes)} inline image limit.`,
      );
    }

    return {
      id,
      name,
      mimeType,
      size,
      contentKind: "image",
      dataBase64: buffer.toString("base64"),
      note: "Image bytes are included for compatible multimodal processing.",
    };
  }

  return unsupportedAttachment(id, name, mimeType, size, "Unsupported file type.");
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    const result = await parser.getText();

    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function extractSpreadsheetText(buffer: Buffer): Promise<string> {
  const workbook = await readXlsxFile(buffer);

  return workbook
    .map((sheet) => {
      const csv = sheet.data.map(formatSpreadsheetRow).join("\n");

      return `Sheet: ${sheet.sheet}\n${csv}`.trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

function formatSpreadsheetRow(row: unknown[]): string {
  return row.map(formatSpreadsheetCell).join(",");
}

function formatSpreadsheetCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = value instanceof Date ? value.toISOString() : String(value);

  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function unsupportedAttachment(
  id: string,
  name: string,
  mimeType: string,
  size: number,
  note: string,
): SlackInputAttachment {
  return {
    id,
    name,
    mimeType,
    size,
    contentKind: "unsupported",
    note,
  };
}

function isPdf(mimeType: string, name: string): boolean {
  return mimeType === "application/pdf" || hasExtension(name, ".pdf");
}

function isSpreadsheet(mimeType: string, name: string): boolean {
  return (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    hasExtension(name, ".xlsx")
  );
}

function isTextLike(mimeType: string, name: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    [
      "application/csv",
      "application/json",
      "application/javascript",
      "application/typescript",
      "application/xml",
      "application/x-yaml",
    ].includes(mimeType) ||
    [".csv", ".json", ".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".py", ".html", ".css"].some(
      (extension) => hasExtension(name, extension),
    )
  );
}

function hasExtension(name: string, extension: string): boolean {
  return name.toLowerCase().endsWith(extension);
}

function truncateText(text: string): string {
  const normalizedText = text.replace(/\u0000/g, "").trim();

  if (normalizedText.length <= maxExtractedTextChars) {
    return normalizedText;
  }

  return `${normalizedText.slice(0, maxExtractedTextChars)}\n\n[Truncated to ${maxExtractedTextChars} characters.]`;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024)} KiB`;
}
