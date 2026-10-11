/**
 * The public OSV API (api.osv.dev) — the *live* upstream, as opposed to the
 * local mirror `osv-sync/` maintains. Used only where the mirror by
 * definition cannot answer: inspecting the raw upstream record behind a
 * parse failure.
 *
 * Every call carries a timeout — an admin request must not hang on a stalled
 * upstream socket forever just because api.osv.dev stopped answering.
 */

const OSV_API_BASE = "https://api.osv.dev/v1";
const OSV_API_TIMEOUT_MS = 10_000;

/**
 * Fetch one vulnerability record by OSV id. Returns the raw `Response` so the
 * caller keeps its own status mapping; rejects with a `TimeoutError` when the
 * upstream does not answer within the timeout.
 */
export async function fetchOsvRecord(osvId: string): Promise<Response> {
    return fetch(`${OSV_API_BASE}/vulns/${encodeURIComponent(osvId)}`, {
        signal: AbortSignal.timeout(OSV_API_TIMEOUT_MS),
    });
}
