/**
 * What the app shell says about the OSV mirror, from the server's
 * `GET /api/vulnerabilities/mirror` (the `osv_sync_state` row).
 *
 * A fresh self-hosted install bootstraps its mirror in the background after
 * the server is already answering (open-source plan steps 06–07): the
 * dashboard is reachable, uploads are accepted, and every image shows zero
 * findings until the bootstrap publishes its first generation. Saying so on
 * every page — the Chart Index's stale-data banner pattern — is what keeps
 * "no findings yet" from reading as "no vulnerabilities". Pure, so the
 * wording is unit-tested without a fetch.
 */

export interface MirrorStatus {
    initialized: boolean;
    syncStatus: "idle" | "full_refresh" | "incremental" | string;
    initCompletedAt: string | null;
    lastSuccessfulPollAt: string | null;
    lastError: string | null;
    ecosystems: string[] | null;
}

export type MirrorBannerState =
    /** The first bootstrap is running: findings will arrive on their own. */
    | { kind: "building" }
    /** No generation yet and nothing running — the scheduler has not started one, or it failed. */
    | { kind: "waiting"; lastError: string | null }
    /** Live mirror. Nothing to say. */
    | { kind: "ready" };

export function mirrorBannerState(status: MirrorStatus | null): MirrorBannerState {
    // Unknown (the request failed, or the shell has not fetched yet) reads as
    // ready: a banner about the mirror must never appear because of a network
    // blip on the banner's own request.
    if (!status || status.initialized) return { kind: "ready" };
    if (status.syncStatus === "full_refresh") return { kind: "building" };
    return { kind: "waiting", lastError: status.lastError };
}

/**
 * Whether the shell should keep polling: only while the state is expected
 * to change on its own (`usePollWhile`'s rule). A live mirror is the end
 * state and polls nothing.
 */
export function mirrorNeedsPolling(status: MirrorStatus | null): boolean {
    return status !== null && !status.initialized;
}
