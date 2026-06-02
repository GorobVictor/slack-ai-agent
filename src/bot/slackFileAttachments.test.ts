import { describe, expect, it, vi } from "vitest";

import { maxAttachmentCount, maxDownloadBytes } from "../shared/limits.js";
import { normalizeSlackFiles, type SlackEventFile } from "./slackFileAttachments.js";

describe("normalizeSlackFiles", () => {
  it("limits the number of processed files", async () => {
    const files: SlackEventFile[] = Array.from(
      { length: maxAttachmentCount + 1 },
      (_, index) => ({
        id: `F${index}`,
        name: `file-${index}.txt`,
        mimetype: "text/plain",
      }),
    );

    const attachments = await normalizeSlackFiles(files, "xoxb-token", {
      warn: vi.fn(),
    });

    expect(attachments).toHaveLength(maxAttachmentCount + 1);
    expect(attachments.at(-1)).toMatchObject({
      id: "attachment-limit",
      contentKind: "unsupported",
    });
  });

  it("rejects files that exceed the metadata size limit before download", async () => {
    const attachments = await normalizeSlackFiles(
      [
        {
          id: "F1",
          name: "large.txt",
          mimetype: "text/plain",
          size: maxDownloadBytes + 1,
          url_private_download: "https://files.slack.com/large.txt",
        },
      ],
      "xoxb-token",
      { warn: vi.fn() },
    );

    expect(attachments).toEqual([
      expect.objectContaining({
        id: "F1",
        contentKind: "unsupported",
      }),
    ]);
  });

  it("marks files without download URLs as unsupported", async () => {
    const attachments = await normalizeSlackFiles(
      [{ id: "F1", name: "missing.txt", mimetype: "text/plain" }],
      "xoxb-token",
      { warn: vi.fn() },
    );

    expect(attachments).toEqual([
      expect.objectContaining({
        id: "F1",
        contentKind: "unsupported",
        note: "Slack did not provide a private download URL.",
      }),
    ]);
  });
});
