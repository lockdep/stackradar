/**
 * Runs once when the Next.js server starts (`register`), in the Node runtime
 * only — the edge runtime gets its own call and has no database.
 *
 * Seeds the bootstrap admin for local sign-in (`lib/bootstrap-admin.ts`).
 * Postgres may not be accepting connections yet when the pod starts (Compose
 * starts both at once; a chart install races the StatefulSet), so a failure
 * is retried in the background rather than failing the boot: the server
 * still comes up, readiness still reflects the database, and the row lands
 * on the first attempt that finds the database awake.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;

    const { ensureBootstrapAdmin } = await import("./lib/bootstrap-admin");
    const { createLogger } = await import("./lib/logger");
    const log = createLogger("instrumentation");

    const attempt = async (left: number): Promise<void> => {
        try {
            const outcome = await ensureBootstrapAdmin();
            if (outcome !== "disabled") log.info({ outcome }, "bootstrap admin check");
        } catch (err) {
            if (left <= 0) {
                log.error({ err }, "bootstrap admin check failed; giving up — sign-in needs a local account, see `pnpm admin:reset-password`");
                return;
            }
            log.warn({ err, retriesLeft: left }, "bootstrap admin check failed; retrying in 5s");
            setTimeout(() => void attempt(left - 1), 5_000).unref();
        }
    };
    await attempt(12);
}
