export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type LogContext = Record<string, unknown>;

export type Logger = {
  level: LogLevel;
  child(context: LogContext): Logger;
  debug(event: string, context?: LogContext): void;
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
};

const defaultLogLevel: LogLevel = "info";
const defaultMaxStringLength = 2_000;
const logLevelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

export function createLogger(input: {
  level?: unknown;
  context?: LogContext;
  maxStringLength?: number;
} = {}): Logger {
  const level = readLogLevel(input.level);
  const maxStringLength = readPositiveInteger(
    input.maxStringLength,
    defaultMaxStringLength,
  );
  const baseContext = sanitizeContext(input.context ?? {}, {
    includeStack: level === "debug",
    maxStringLength,
  });

  return createLoggerInstance(level, baseContext, maxStringLength);
}

export function logValueSnippet(value: unknown, maxStringLength: number): unknown {
  return sanitizeValue(value, {
    includeStack: false,
    maxStringLength: readPositiveInteger(maxStringLength, defaultMaxStringLength),
  });
}

function createLoggerInstance(
  level: LogLevel,
  baseContext: LogContext,
  maxStringLength: number,
): Logger {
  const logger: Logger = {
    level,
    child(context) {
      return createLoggerInstance(
        level,
        {
          ...baseContext,
          ...sanitizeContext(context, {
            includeStack: level === "debug",
            maxStringLength,
          }),
        },
        maxStringLength,
      );
    },
    debug(event, context) {
      writeLog(level, "debug", event, baseContext, context, maxStringLength);
    },
    info(event, context) {
      writeLog(level, "info", event, baseContext, context, maxStringLength);
    },
    warn(event, context) {
      writeLog(level, "warn", event, baseContext, context, maxStringLength);
    },
    error(event, context) {
      writeLog(level, "error", event, baseContext, context, maxStringLength);
    },
  };

  return logger;
}

function writeLog(
  configuredLevel: LogLevel,
  messageLevel: Exclude<LogLevel, "silent">,
  event: string,
  baseContext: LogContext,
  context: LogContext | undefined,
  maxStringLength: number,
): void {
  if (logLevelRank[messageLevel] < logLevelRank[configuredLevel]) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level: messageLevel,
    event,
    ...baseContext,
    ...sanitizeContext(context ?? {}, {
      includeStack: configuredLevel === "debug",
      maxStringLength,
    }),
  };

  const line = JSON.stringify(entry);
  if (messageLevel === "debug") {
    console.debug(line);
    return;
  }

  if (messageLevel === "info") {
    console.info(line);
    return;
  }

  if (messageLevel === "warn") {
    console.warn(line);
    return;
  }

  console.error(line);
}

function sanitizeContext(
  context: LogContext,
  options: { includeStack: boolean; maxStringLength: number },
): LogContext {
  const sanitized: LogContext = {};

  for (const [key, value] of Object.entries(context)) {
    sanitized[key] = sanitizeValue(value, options);
  }

  return sanitized;
}

function sanitizeValue(
  value: unknown,
  options: { includeStack: boolean; maxStringLength: number },
): unknown {
  if (value instanceof Error) {
    return serializeError(value, options);
  }

  if (typeof value === "string") {
    return truncateString(value, options.maxStringLength);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, options));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sanitized: LogContext = {};

    for (const [key, item] of Object.entries(record).slice(0, 50)) {
      sanitized[key] = sanitizeValue(item, options);
    }

    return sanitized;
  }

  return String(value);
}

function serializeError(
  error: Error,
  options: { includeStack: boolean; maxStringLength: number },
): LogContext {
  const serialized: LogContext = {
    name: error.name,
    message: truncateString(error.message, options.maxStringLength),
  };

  if (options.includeStack && error.stack) {
    serialized.stack = truncateString(error.stack, options.maxStringLength);
  }

  if (error.cause) {
    serialized.cause = sanitizeValue(error.cause, options);
  }

  return serialized;
}

function truncateString(value: string, maxStringLength: number): string {
  if (value.length <= maxStringLength) {
    return value;
  }

  return `${value.slice(0, maxStringLength)}...[truncated ${value.length - maxStringLength} chars]`;
}

function readLogLevel(value: unknown): LogLevel {
  if (typeof value !== "string") {
    return defaultLogLevel;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error" ||
    normalized === "silent"
  ) {
    return normalized;
  }

  return defaultLogLevel;
}

function readPositiveInteger(value: unknown, defaultValue: number): number {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;

  return Number.isInteger(numberValue) && numberValue > 0
    ? numberValue
    : defaultValue;
}
