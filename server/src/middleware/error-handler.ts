import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { createLogger } from "../lib/logger.js";

const log = createLogger("error-handler");

export class AppError extends Error {
    constructor(
        public statusCode: number,
        public message: string,
        public isOperational = true,
        /**
         * Machine-readable cause, returned to the client alongside the
         * message. Only for errors a client must branch on (e.g.
         * "PLAN_LIMIT_EXCEEDED" → render an upgrade prompt); the status code
         * alone is ambiguous — a 403 can be a role check or a plan limit.
         */
        public code?: string
    ) {
        super(message);
        Object.setPrototypeOf(this, AppError.prototype);
    }
}

export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction
): void {
    // Get request ID from pino-http if available
    const reqId = (req as { id?: string }).id;

    if (err instanceof ZodError) {
        const message = err.issues[0]?.message ?? "Validation failed";
        log.warn({ reqId, statusCode: 400, issues: err.issues }, `Validation error: ${message}`);
        res.status(400).json({ error: message });
        return;
    }

    if (err instanceof AppError) {
        // Operational errors are expected and logged at warn level
        if (err.statusCode >= 500) {
            log.error(
                { err, reqId, statusCode: err.statusCode },
                `Operational error: ${err.message}`
            );
        } else {
            log.warn(
                { reqId, statusCode: err.statusCode, message: err.message },
                `Client error: ${err.message}`
            );
        }

        res.status(err.statusCode).json({
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
        });
        return;
    }

    // Unexpected errors - log full stack trace
    log.error(
        { err, reqId, stack: err.stack },
        `Unexpected error: ${err.message}`
    );

    // Unexpected errors never leak their message to the client
    res.status(500).json({ error: "Internal server error" });
}
