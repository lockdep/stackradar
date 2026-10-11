import pino, { type Logger, type LoggerOptions } from "pino";
import { config } from "../config/index.js";
import { envString } from "./env.js";

/**
 * Redact sensitive fields from log output
 * Add field paths here that should never appear in logs
 */
export const redactedPaths = [
    // Common sensitive fields
    "password",
    "secret",
    "apiKey",
    "token",
    "accessToken",
    "refreshToken",

    // Request headers with secrets
    "req.headers.authorization",
    "req.headers.cookie",
    "req.headers.x-api-key",
    "req.headers.x-internal-key",
    "req.headers.x-match-key",

    // Also catch these at any nesting level
    "*.password",
    "*.secret",
    "*.apiKey",
    "*.token",
];

const loggerOptions: LoggerOptions = {
    level: envString("LOG_LEVEL", config.isProduction ? "info" : "debug"),
    base: {
        service: "stack-radar-server",
        env: config.nodeEnv,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level: (label) => ({ level: label }),
    },
    redact: redactedPaths,
    // In development, use pino-pretty for human-readable output
    // In production, output raw JSON for log aggregation systems
    ...(config.isProduction
        ? {}
        : {
              transport: {
                  target: "pino-pretty",
                  options: {
                      colorize: true,
                      translateTime: "HH:MM:ss.l",
                      ignore: "pid,hostname,service,env",
                  },
              },
          }),
};

export const logger: Logger = pino(loggerOptions);

/**
 * Create a child logger with a specific module context
 * Use this to create loggers for different parts of the application
 *
 * @example
 * const log = createLogger("stack-radar.service");
 * log.info({ projectId: "123" }, "Processing SBOM");
 */
export function createLogger(module: string): Logger {
    return logger.child({ module });
}

const SLOW_QUERY_THRESHOLD_MS = 50;

/**
 * Creates a query timer function that logs execution time for repository calls.
 *
 * Fast queries log at `debug` — with ~124 call sites a single list request
 * would otherwise emit several `info` lines that say nothing (the same reason
 * app.ts suppresses health-check logs). A query slower than
 * SLOW_QUERY_THRESHOLD_MS is the signal worth keeping at `info` in production.
 *
 * @param log - Logger instance to write timing info to
 * @param context - Additional fields to include in each log entry (e.g. { projectId })
 *
 * @example
 * const time = createQueryTimer(log, { projectId: id });
 * const [users] = await Promise.all([
 *   time("findAll", userRepository.findAll()),
 * ]);
 */
export function createQueryTimer(log: Logger, context?: Record<string, unknown>) {
    return async <T>(label: string, p: Promise<T>): Promise<T> => {
        const s = performance.now();
        const r = await p;
        const ms = Math.round(performance.now() - s);
        log[ms > SLOW_QUERY_THRESHOLD_MS ? "info" : "debug"]({ ...context, ms, label }, "query");
        return r;
    };
}
