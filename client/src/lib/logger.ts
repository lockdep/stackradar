import pino, { type Logger, type LoggerOptions } from "pino";

const isProduction = process.env.NODE_ENV === "production";

const redactedPaths = [
  "password",
  "secret",
  "apiKey",
  "token",
  "accessToken",
  "refreshToken",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-api-key",
  "req.headers.x-internal-key",
  "*.password",
  "*.secret",
  "*.apiKey",
  "*.token",
];

/**
 * Logger configuration for the Stack Radar Next.js client
 *
 * Note: This logger is designed for server-side use only (API routes, SSR).
 * Client-side logging is disabled to avoid bundling issues and sensitive data leaks.
 *
 * For pretty output in development, pipe the output:
 *   pnpm dev | pnpm exec pino-pretty
 *
 * We don't use the `transport` option here because Next.js bundling doesn't
 * work well with pino's worker threads (causes MODULE_NOT_FOUND errors).
 */
const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  base: {
    service: "stack-radar-client",
    env: process.env.NODE_ENV || "development",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: redactedPaths,
  // Disable browser logging entirely
  browser: {
    disabled: true,
  },
};

/**
 * Root logger instance for the Next.js client
 */
export const logger: Logger = pino(loggerOptions);

/**
 * Create a child logger with a specific module context
 * 
 * @example
 * const log = createLogger("api.workloads");
 * log.info({ imageId: "123" }, "Fetching image");
 */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}



