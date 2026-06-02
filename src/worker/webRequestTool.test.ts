import { describe, expect, it, vi } from "vitest";

import { maxWebRequestResponseBytes } from "../shared/limits";
import type { AiToolCall } from "./aiTypes";
import {
  executeWebRequestToolCall,
  webRequestToolName,
} from "./webRequestTool";

describe("executeWebRequestToolCall", () => {
  it("fetches a public URL with browser-compatible headers", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("hello", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await executeWebRequestToolCall(
      toolCall({ url: "https://example.com/page" }),
      { fetchFn: fetchFn as typeof fetch },
    );

    expect(result).toEqual({
      ok: true,
      url: "https://example.com/page",
      status: 200,
      statusText: "OK",
      contentType: "text/plain",
      body: "hello",
      truncated: false,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("Mozilla/5.0"),
          Accept: expect.stringContaining("text/html"),
          "Accept-Language": "en-US,en;q=0.9",
        }),
      }),
    );
    const requestInit = fetchFn.mock.calls[0]?.[1];
    expect(requestInit?.headers).not.toHaveProperty("Accept-Encoding");
  });

  it("uses the global fetch path when no test fetch is injected", async () => {
    const fetchFn = vi.fn(async () => new Response("global"));
    vi.stubGlobal("fetch", fetchFn);

    try {
      const result = await executeWebRequestToolCall(
        toolCall({ url: "https://example.com/global" }),
      );

      expect(result).toMatchObject({
        ok: true,
        url: "https://example.com/global",
        body: "global",
      });
      expect(fetchFn).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("supports HEAD without returning a body", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(null, {
        status: 204,
        statusText: "No Content",
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await executeWebRequestToolCall(
      toolCall({ url: "https://example.com/status", method: "HEAD" }),
      { fetchFn: fetchFn as typeof fetch },
    );

    expect(result).toEqual({
      ok: true,
      url: "https://example.com/status",
      status: 204,
      statusText: "No Content",
      contentType: "text/plain",
      truncated: false,
    });
  });

  it("truncates oversized response bodies", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("a".repeat(maxWebRequestResponseBytes + 1)),
    );

    const result = await executeWebRequestToolCall(
      toolCall({ url: "https://example.com/large" }),
      { fetchFn: fetchFn as typeof fetch },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toHaveLength(maxWebRequestResponseBytes);
      expect(result.truncated).toBe(true);
    }
  });

  it("follows safe redirects", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://example.org/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("final"));

    const result = await executeWebRequestToolCall(
      toolCall({ url: "https://example.com/start" }),
      { fetchFn: fetchFn as typeof fetch },
    );

    expect(result).toMatchObject({
      ok: true,
      url: "https://example.org/final",
      body: "final",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported methods", async () => {
    const result = await executeWebRequestToolCall(
      toolCall({ url: "https://example.com", method: "POST" }),
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("rejects custom headers and request bodies", async () => {
    await expect(
      executeWebRequestToolCall(
        toolCall({
          url: "https://example.com",
          headers: { Authorization: "Bearer token" },
        }),
      ),
    ).resolves.toMatchObject({ ok: false });

    await expect(
      executeWebRequestToolCall(
        toolCall({
          url: "https://example.com",
          body: "not allowed",
        }),
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects credentials and private hosts", async () => {
    await expect(
      executeWebRequestToolCall(
        toolCall({ url: "https://user:pass@example.com" }),
      ),
    ).resolves.toMatchObject({ ok: false });

    await expect(
      executeWebRequestToolCall(toolCall({ url: "http://127.0.0.1" })),
    ).resolves.toMatchObject({ ok: false });

    await expect(
      executeWebRequestToolCall(toolCall({ url: "http://localhost" })),
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects redirects to blocked hosts", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://localhost/private" },
      }),
    );

    const result = await executeWebRequestToolCall(
      toolCall({ url: "https://example.com/start" }),
      { fetchFn: fetchFn as typeof fetch },
    );

    expect(result).toMatchObject({
      ok: false,
      url: "https://example.com/start",
    });
  });

  it("returns network errors as tool errors", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await executeWebRequestToolCall(
      toolCall({ url: "https://example.com" }),
      { fetchFn: fetchFn as typeof fetch },
    );

    expect(result).toEqual({
      ok: false,
      error: "network down",
      url: "https://example.com/",
    });
  });
});

function toolCall(argumentsValue: Record<string, unknown>): AiToolCall {
  return {
    id: "tool-1",
    type: "function",
    function: {
      name: webRequestToolName,
      arguments: JSON.stringify(argumentsValue),
    },
  };
}
