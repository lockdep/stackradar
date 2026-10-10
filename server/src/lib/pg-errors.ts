/**
 * Helpers for introspecting errors thrown by the `postgres` driver.
 *
 * Drizzle wraps driver errors in a generic `Error` whose `.cause` is the
 * original `PostgresError` (see the `postgres` package). These helpers walk
 * the cause chain so callers can write `if (isUniqueViolation(err))` without
 * caring whether the error was produced by a raw driver call or by Drizzle.
 *
 * SQLSTATE codes come from Postgres itself — see
 * https://www.postgresql.org/docs/current/errcodes-appendix.html.
 */

/**
 * Postgres error object shape (subset) thrown by the `postgres` driver.
 */
interface PgError extends Error {
    code?: string;
    constraint_name?: string;
    detail?: string;
}

/**
 * Walk the `.cause` chain to find a Postgres driver error. Guards against
 * infinite loops by capping the traversal depth.
 */
function findPgError(err: unknown): PgError | null {
    let current: unknown = err;
    for (let i = 0; i < 5; i++) {
        if (current instanceof Error && typeof (current as PgError).code === "string") {
            return current as PgError;
        }
        if (current instanceof Error && current.cause !== undefined && current.cause !== current) {
            current = current.cause;
            continue;
        }
        return null;
    }
    return null;
}

/** SQLSTATE `23505` — unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
    return findPgError(err)?.code === "23505";
}

/**
 * Returns true when the error is a unique_violation for the given constraint
 * name. Useful when one INSERT can fail for multiple different unique indexes
 * and we want to map each to a different HTTP status.
 */
export function isUniqueViolationOn(err: unknown, constraint: string): boolean {
    const pg = findPgError(err);
    return pg?.code === "23505" && pg.constraint_name === constraint;
}
