import {
  maxWebRequestRedirects,
  maxWebRequestResponseBytes,
  webRequestTimeoutMs,
} from "../shared/limits";
import {
  isNonEmptyString,
  parseJsonObject,
} from "../shared/jsonGuards";
import type { AiToolCall } from "./aiTypes";
import type { Logger } from "./logger";

export const webRequestToolName = "web_request";

export type WebRequestToolResult =
  | {
      ok: true;
      url: string;
      status: number;
      statusText: string;
      contentType?: string;
      body?: string;
      truncated: boolean;
    }
  | { ok: false; error: string; url?: string };

type WebRequestMethod = "GET" | "HEAD";

type FetchFn = typeof fetch;

const defaultBrowserHeaders: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
};

export function createWebRequestToolDefinition(): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: webRequestToolName,
      description:
        "Fetch a public web URL when fresh web or API content is needed. This tool is read-only and cannot use authentication, cookies, private networks, or custom secrets.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The public http or https URL to fetch. Do not include usernames, passwords, tokens, or private/internal hostnames.",
          },
          method: {
            type: "string",
            enum: ["GET", "HEAD"],
            description:
              "Optional read-only HTTP method. Use GET unless only status and headers are needed.",
          },
        },
        required: ["url"],
      },
    },
  };
}

export async function executeWebRequestToolCall(
  toolCall: AiToolCall,
  options: { fetchFn?: FetchFn; logger?: Logger } = {},
): Promise<WebRequestToolResult> {
  if (toolCall.function.name !== webRequestToolName) {
    return { ok: false, error: `Unknown tool: ${toolCall.function.name}` };
  }

  const args = parseJsonObject(toolCall.function.arguments);
  if (!args) {
    return { ok: false, error: "Web request arguments must be a JSON object." };
  }

  if (hasUnsupportedRequestOptions(args)) {
    return {
      ok: false,
      error:
        "Web request only supports url and method arguments. Custom headers, cookies, request bodies, and credentials are not allowed.",
    };
  }

  const urlResult = parsePublicUrl(args?.url);
  if (!urlResult.ok) {
    return { ok: false, error: urlResult.error };
  }

  const method = normalizeMethod(args?.method);
  if (!method) {
    return {
      ok: false,
      error: "Web request method must be GET or HEAD.",
      url: urlResult.url.href,
    };
  }

  return fetchPublicUrl(urlResult.url, method, options);
}

async function fetchPublicUrl(
  initialUrl: URL,
  method: WebRequestMethod,
  options: { fetchFn?: FetchFn; logger?: Logger },
): Promise<WebRequestToolResult> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= maxWebRequestRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), webRequestTimeoutMs);

    try {
      options.logger?.info("web_request_started", {
        url: currentUrl.href,
        method,
        redirectCount,
      });
      const requestInit: RequestInit = {
        method,
        headers: defaultBrowserHeaders,
        redirect: "manual",
        signal: controller.signal,
      };
      const response = options.fetchFn
        ? await options.fetchFn(currentUrl.href, requestInit)
        : await fetch(currentUrl.href, requestInit);

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          return {
            ok: false,
            error: "Web request redirect did not include a Location header.",
            url: currentUrl.href,
          };
        }

        if (redirectCount >= maxWebRequestRedirects) {
          return {
            ok: false,
            error: `Web request exceeded ${maxWebRequestRedirects} redirects.`,
            url: currentUrl.href,
          };
        }

        const redirectedUrl = parsePublicUrl(new URL(location, currentUrl).href);
        if (!redirectedUrl.ok) {
          return {
            ok: false,
            error: `Web request redirect was blocked: ${redirectedUrl.error}`,
            url: currentUrl.href,
          };
        }

        currentUrl = redirectedUrl.url;
        continue;
      }

      const contentType = response.headers.get("content-type") ?? undefined;
      if (method === "HEAD") {
        return {
          ok: true,
          url: currentUrl.href,
          status: response.status,
          statusText: response.statusText,
          contentType,
          truncated: false,
        };
      }

      const body = await readBoundedResponseBody(response);

      return {
        ok: true,
        url: currentUrl.href,
        status: response.status,
        statusText: response.statusText,
        contentType,
        body: body.text,
        truncated: body.truncated,
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof DOMException && error.name === "AbortError"
            ? `Web request timed out after ${webRequestTimeoutMs} ms.`
            : error instanceof Error
              ? error.message
              : "Web request failed with an unknown error.",
        url: currentUrl.href,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    ok: false,
    error: `Web request exceeded ${maxWebRequestRedirects} redirects.`,
    url: currentUrl.href,
  };
}

async function readBoundedResponseBody(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: "", truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const remainingBytes = maxWebRequestResponseBytes - byteLength;
      if (value.byteLength > remainingBytes) {
        chunks.push(value.slice(0, Math.max(remainingBytes, 0)));
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    text: new TextDecoder().decode(combined),
    truncated,
  };
}

function normalizeMethod(value: unknown): WebRequestMethod | null {
  if (value === undefined) {
    return "GET";
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return normalized === "GET" || normalized === "HEAD" ? normalized : null;
}

function hasUnsupportedRequestOptions(args: Record<string, unknown>): boolean {
  return Object.keys(args).some((key) => key !== "url" && key !== "method");
}

function parsePublicUrl(value: unknown): { ok: true; url: URL } | { ok: false; error: string } {
  if (!isNonEmptyString(value)) {
    return { ok: false, error: "Web request URL must be a non-empty string." };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "Web request URL must be a valid absolute URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Web request URL must use http or https." };
  }

  if (url.username || url.password) {
    return { ok: false, error: "Web request URL must not include credentials." };
  }

  const hostValidation = validatePublicHost(url.hostname);
  if (!hostValidation.ok) {
    return hostValidation;
  }

  return { ok: true, url };
}

function validatePublicHost(hostname: string): { ok: true } | { ok: false; error: string } {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata" ||
    host === "metadata.google.internal"
  ) {
    return { ok: false, error: "Web request host must be public." };
  }

  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return { ok: false, error: "Web request host must not be a private IP address." };
  }

  if (!host.includes(".") && !host.includes(":")) {
    return { ok: false, error: "Web request host must be a public fully qualified name." };
  }

  return { ok: true };
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      return NaN;
    }

    return Number(part);
  });

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && octets[2] === 100))) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(":")) {
    return false;
  }

  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:") ||
    host.startsWith("ff") ||
    host.startsWith("2001:db8") ||
    host.startsWith("::ffff:10.") ||
    host.startsWith("::ffff:127.") ||
    host.startsWith("::ffff:169.254.") ||
    host.startsWith("::ffff:192.168.")
  );
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}
