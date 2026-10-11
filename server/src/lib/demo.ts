/**
 * The read-only demo contract.
 *
 * A demo context is either a request scoped to an organisation with
 * `organizations.demo = true` or a request from a user with
 * `users.demo = true`. In either case the whole permitted surface is
 * **reads**: `requireOrg` and `requireAuth` (`middleware/auth.ts`) refuse
 * every other method with `403` and the code below, which the client banner
 * matches on to say "this is a read-only demo" instead of "Forbidden".
 *
 * The method list is the guard's definition of a read, so it lives next to
 * the code the client matches — the two are one contract.
 */

import { AppError } from "../middleware/error-handler.js";

/** The `code` a demo-context mutation is refused with. The client matches on it. */
export const READ_ONLY_DEMO_CODE = "read_only_demo";

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Safe methods per RFC 9110 § 9.2.1 — the only ones a demo context may use. */
export function isReadMethod(method: string | undefined): boolean {
    // A request without a method cannot happen under Express; if one ever
    // does, it is not a read.
    return method !== undefined && READ_METHODS.has(method.toUpperCase());
}

export function readOnlyDemoError(): AppError {
    return new AppError(
        403,
        "This is a read-only demo. Sign up to make changes to your own clusters.",
        true,
        READ_ONLY_DEMO_CODE,
    );
}
