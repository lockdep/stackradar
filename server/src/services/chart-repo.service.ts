/**
 * Chart repository sync and discovery —
 * [fix-tab-suggestions.md](../../../docs/proposals/fix-tab-suggestions.md)
 * phase 2.
 *
 * Two jobs:
 *
 * - **Sync** (worker, daily): auto-register repositories observed on
 *   releases, then refresh every enabled repository's cached `index.yaml`
 *   slice. Off the request path by design — a Bitnami-scale index is never
 *   fetched while a user waits.
 * - **Discovery** (Artifact Hub, interactive): map a chart name with no known
 *   repository to its *likely* repository. A name-only search result is a
 *   guess — name collisions exist — so it is only ever proposed; storing it
 *   requires the user's explicit confirmation through the settings endpoint.
 *
 * The nightly attribution pass (`artifacthub-sync/attribution.ts`) auto-adds
 * repositories without confirmation, but on different footing: it requires
 * version-list identity evidence, not a name match — see
 * docs/proposals/artifact-hub-mirror.md. Artifact Hub's mirror is also the
 * fallback version source for attributed charts whose repository serves no
 * `index.yaml` (OCI); everything read from it stays in the unmeasured band.
 */

import { chartRepositoryRepository } from "../repositories/chart-repository.repository.js";
import { fetchIndex, isIndexableRepoUrl, parseIndexYaml } from "../lib/chart-repo.js";
import { createLogger } from "../lib/logger.js";
import type { ChartRepository } from "../db/schema/chart-repositories.js";

const log = createLogger("chart-repo");

export interface ChartRepoSyncStats {
    registered: number;
    fetched: number;
    unchanged: number;
    failed: number;
}

/** Refresh one repository's cached slice. Returns what settings shows. */
export async function refreshRepository(repo: ChartRepository): Promise<{
    status: "ok" | "not-modified" | "error";
    error: string | null;
}> {
    const keep = new Set(await chartRepositoryRepository.chartNamesForOrg(repo.orgId));
    const result = await fetchIndex({
        url: repo.url,
        etag: repo.etag,
        username: repo.username,
        password: repo.password,
    });

    if (result.status === "error") {
        await chartRepositoryRepository.recordFetch(repo.id, { lastFetchError: result.message });
        return { status: "error", error: result.message };
    }

    if (result.status === "not-modified") {
        await chartRepositoryRepository.recordFetch(repo.id, { lastFetchError: null });
        return { status: "not-modified", error: null };
    }

    let entries;
    try {
        // Trim to charts the org runs; a hub whose index names none of them
        // stores nothing, which is the correct cache for it.
        entries = parseIndexYaml(result.text, keep.size > 0 ? keep : null, repo.url);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await chartRepositoryRepository.recordFetch(repo.id, { lastFetchError: message });
        return { status: "error", error: message };
    }

    const fetchedAt = new Date();
    await chartRepositoryRepository.replaceEntries(repo.id, entries, fetchedAt);
    await chartRepositoryRepository.recordFetch(repo.id, {
        etag: result.etag,
        lastFetchError: null,
    });
    log.info(
        { repositoryId: repo.id, url: repo.url, charts: entries.length },
        "Refreshed chart repository index"
    );
    return { status: "ok", error: null };
}

/**
 * The `chart_repo_refresh` job body: the settings page's Refresh button,
 * executed by the worker. Org-scoped by the job row, not the params — a
 * repository id that is not the org's is a 404 here just as it is in the
 * controller. A fetch/parse failure is recorded on the row and is the
 * job's *result*, not its failure: the job did what was asked, and the
 * settings page shows `lastFetchError`.
 */
export async function runChartRepoRefreshJob(
    orgId: string,
    params: Record<string, unknown> | null
): Promise<Record<string, unknown>> {
    const repositoryId = params?.repositoryId;
    if (typeof repositoryId !== "string") {
        throw new Error("chart_repo_refresh requires params.repositoryId");
    }
    const repo = await chartRepositoryRepository.findById(repositoryId, orgId);
    if (!repo) throw new Error("Chart repository not found");
    const outcome = await refreshRepository(repo);
    return { repositoryId, ...outcome };
}

/**
 * The worker's daily pass. Sequential on purpose: this is background work
 * against other people's servers, and a fleet of parallel index downloads
 * is not a neighbourly failure mode.
 */
export async function syncChartRepositories(): Promise<ChartRepoSyncStats> {
    const stats: ChartRepoSyncStats = { registered: 0, fetched: 0, unchanged: 0, failed: 0 };

    const orgIds = new Set([
        ...(await chartRepositoryRepository.orgIdsWithReleases()),
        ...(await chartRepositoryRepository.orgIdsWithRepositories()),
    ]);
    for (const orgId of orgIds) {
        const observed = await chartRepositoryRepository.observedRepoUrls(orgId);
        stats.registered += await chartRepositoryRepository.registerObserved(
            orgId,
            observed.filter(isIndexableRepoUrl)
        );
    }

    for (const repo of await chartRepositoryRepository.listAllEnabled()) {
        const { status } = await refreshRepository(repo);
        if (status === "ok") stats.fetched += 1;
        else if (status === "not-modified") stats.unchanged += 1;
        else stats.failed += 1;
    }

    await chartRepositoryRepository.pruneEntriesForDisabled();
    return stats;
}

// ---------------------------------------------------------------------------
// Artifact Hub — discovery only
// ---------------------------------------------------------------------------

const ARTIFACT_HUB_SEARCH = "https://artifacthub.io/api/v1/packages/search";

export interface ArtifactHubCandidate {
    packageName: string;
    repoName: string;
    repoUrl: string;
    publisher: string | null;
    verifiedPublisher: boolean;
}

/**
 * Candidate repositories for a chart name. Proposals, never facts: the
 * caller renders them for the user to confirm, and only the confirmation
 * endpoint stores anything.
 */
export async function discoverChartRepositories(
    chartName: string
): Promise<ArtifactHubCandidate[]> {
    const url = new URL(ARTIFACT_HUB_SEARCH);
    url.searchParams.set("ts_query_web", chartName);
    url.searchParams.set("kind", "0"); // Helm charts
    url.searchParams.set("limit", "10");

    const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
        throw new Error(`Artifact Hub search failed (HTTP ${response.status})`);
    }

    const body = (await response.json()) as {
        packages?: Array<{
            name?: unknown;
            repository?: {
                name?: unknown;
                url?: unknown;
                verified_publisher?: unknown;
                organization_display_name?: unknown;
                organization_name?: unknown;
                user_alias?: unknown;
            };
        }>;
    };

    const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

    const out: ArtifactHubCandidate[] = [];
    for (const pkg of body.packages ?? []) {
        const packageName = str(pkg.name);
        const repoName = str(pkg.repository?.name);
        const repoUrl = str(pkg.repository?.url);
        // Exact-name packages only: `ts_query_web=nginx` also returns
        // `nginx-ingress`, and proposing those would invite the wrong click.
        if (!packageName || !repoName || !repoUrl || packageName !== chartName) continue;
        if (!isIndexableRepoUrl(repoUrl)) continue;
        out.push({
            packageName,
            repoName,
            repoUrl,
            publisher:
                str(pkg.repository?.organization_display_name) ??
                str(pkg.repository?.organization_name) ??
                str(pkg.repository?.user_alias),
            verifiedPublisher: pkg.repository?.verified_publisher === true,
        });
    }
    return out;
}
