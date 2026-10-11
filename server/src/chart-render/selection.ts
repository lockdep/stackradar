/**
 * Which candidate chart versions are worth rendering.
 *
 * Rendering everything is waste; rendering per-org is a leak vector. The
 * selection is the **union over all orgs** of, per `(repoUrl, chartName)` some
 * release trails:
 *
 * - the newest version the repository's index lists, and
 * - the newest version within that release's current major — the conservative
 *   move a maintainer actually takes first.
 *
 * The selection *input* is tenant data (which charts orgs run, at which
 * versions); the resulting job params and observation rows carry none of it —
 * only the public chart identity and its public tarball URL.
 *
 * Only publicly fetchable repositories qualify: http(s), and at least one
 * enabled, credential-free `chart_repositories` row for the URL. A repo an
 * org reads with credentials may be private, and a private chart must never
 * reach the platform pipeline.
 *
 * Bounded by `CHART_RENDER_MAX_PER_RUN`; versions with an existing
 * `chart_renders` row — rendered or failed — are never selected again, so the
 * queue drains across nightly runs instead of retrying deterministic
 * failures.
 */

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { chartObservationRepository } from "../repositories/chart-observation.repository.js";
import { jobRepository } from "../repositories/job.repository.js";
import { ensurePlatform } from "../services/platform.service.js";
import { bestNewerTag, parseTag } from "../lib/image-tags.js";
import { createLogger } from "../lib/logger.js";
import { config } from "./config.js";
import type { ChartRepoVersion } from "../db/schema/chart-repositories.js";
import type { ArtifactHubVersion } from "../db/schema/artifact-hub.js";

const log = createLogger("chart-render");

export interface RenderCandidate {
    repoUrl: string;
    chartName: string;
    chartVersion: string;
    tarballUrl: string;
    /** The mirror's kubeVersion range for this version, for `--kube-version`. */
    kubeRange: string | null;
}

const key = (repoUrl: string, chartName: string) => `${repoUrl}\u0000${chartName}`;

export async function selectRenderCandidates(limit: number): Promise<RenderCandidate[]> {
    const [releases, entries, attributions] = await Promise.all([
        db
            .selectDistinct({
                orgId: schema.helmReleases.orgId,
                chartName: schema.helmReleases.chartName,
                chartVersion: schema.helmReleases.chartVersion,
                repoUrl: schema.helmReleases.repoUrl,
            })
            .from(schema.helmReleases)
            .where(and(isNotNull(schema.helmReleases.chartName), isNotNull(schema.helmReleases.chartVersion))),
        db
            .select({
                repoUrl: schema.chartRepositories.url,
                chartName: schema.chartRepoEntries.chartName,
                versions: schema.chartRepoEntries.versions,
            })
            .from(schema.chartRepoEntries)
            .innerJoin(schema.chartRepositories, eq(schema.chartRepoEntries.repositoryId, schema.chartRepositories.id))
            .where(
                and(
                    eq(schema.chartRepositories.enabled, true),
                    isNull(schema.chartRepositories.username),
                    isNull(schema.chartRepositories.password),
                ),
            ),
        db
            .select({
                orgId: schema.chartAttributions.orgId,
                chartName: schema.chartAttributions.chartName,
                repoUrl: schema.chartAttributions.repoUrl,
                versions: schema.artifactHubPackages.versions,
            })
            .from(schema.chartAttributions)
            .innerJoin(
                schema.artifactHubPackages,
                eq(schema.chartAttributions.packageId, schema.artifactHubPackages.id),
            ),
    ]);

    // Versions per public (repoUrl, chartName). Several orgs cache the same
    // index as separate rows; merge, preferring the first sighting of each
    // version that carries a tarball URL.
    const versionsByChart = new Map<string, Map<string, ChartRepoVersion>>();
    for (const entry of entries) {
        let byVersion = versionsByChart.get(key(entry.repoUrl, entry.chartName));
        if (!byVersion) {
            byVersion = new Map();
            versionsByChart.set(key(entry.repoUrl, entry.chartName), byVersion);
        }
        for (const version of entry.versions) {
            const existing = byVersion.get(version.version);
            if (!existing || (existing.tarballUrl == null && version.tarballUrl != null)) {
                byVersion.set(version.version, version);
            }
        }
    }

    // The attribution stands in for an unobserved repo (same rule as
    // `recommendForRelease`), and its mirror versions carry the kube ranges.
    const attributionByOrgChart = new Map<string, { repoUrl: string }>();
    const mirrorVersions = new Map<string, ArtifactHubVersion[]>();
    for (const a of attributions) {
        attributionByOrgChart.set(`${a.orgId}\u0000${a.chartName}`, { repoUrl: a.repoUrl });
        if (!mirrorVersions.has(key(a.repoUrl, a.chartName))) {
            mirrorVersions.set(key(a.repoUrl, a.chartName), a.versions);
        }
    }

    const selected = new Map<string, RenderCandidate>();
    for (const release of releases) {
        const chartName = release.chartName!;
        const current = release.chartVersion!;
        const repoUrl =
            release.repoUrl ?? attributionByOrgChart.get(`${release.orgId}\u0000${chartName}`)?.repoUrl ?? null;
        if (!repoUrl) continue;

        const byVersion = versionsByChart.get(key(repoUrl, chartName));
        if (!byVersion || byVersion.size === 0) continue;
        const versionStrings = [...byVersion.keys()];

        const candidates = new Set<string>();
        const { newer } = bestNewerTag(current, versionStrings);
        if (newer[0]) candidates.add(newer[0]);

        const currentMajor = parseTag(current).version?.[0];
        if (currentMajor !== undefined) {
            const sameMajor = versionStrings.filter((v) => parseTag(v).version?.[0] === currentMajor);
            const inMajor = bestNewerTag(current, sameMajor).newer[0];
            if (inMajor) candidates.add(inMajor);
        }

        for (const chartVersion of candidates) {
            const tarballUrl = byVersion.get(chartVersion)?.tarballUrl;
            if (!tarballUrl) continue;
            const candidateKey = `${key(repoUrl, chartName)}\u0000${chartVersion}`;
            if (selected.has(candidateKey)) continue;
            const kubeRange =
                mirrorVersions.get(key(repoUrl, chartName))?.find((v) => v.pkg === chartVersion)?.kube ?? null;
            selected.set(candidateKey, { repoUrl, chartName, chartVersion, tarballUrl, kubeRange });
        }
    }

    // Drop anything already attempted — rendered or failed alike.
    const out: RenderCandidate[] = [];
    const attempted = new Map<string, Set<string>>();
    for (const candidate of selected.values()) {
        const chartKey = key(candidate.repoUrl, candidate.chartName);
        let versions = attempted.get(chartKey);
        if (!versions) {
            const renders = await chartObservationRepository.rendersForChart(candidate.repoUrl, candidate.chartName);
            versions = new Set(renders.map((r) => r.chartVersion));
            attempted.set(chartKey, versions);
        }
        if (versions.has(candidate.chartVersion)) continue;
        out.push(candidate);
        if (out.length >= limit) break;
    }
    return out;
}

export interface RenderEnqueueStats {
    selected: number;
    enqueued: number;
    alreadyQueued: number;
}

/** The nightly pass: select and enqueue `chart_render` jobs under the platform org. */
export async function enqueueCandidateRenders(): Promise<RenderEnqueueStats> {
    const candidates = await selectRenderCandidates(config.maxRendersPerRun);
    const stats: RenderEnqueueStats = { selected: candidates.length, enqueued: 0, alreadyQueued: 0 };
    if (candidates.length === 0) return stats;

    const { orgId } = await ensurePlatform();

    const openKeys = await jobRepository.openParamKeys(
        "chart_render",
        (p) => `${p["repoUrl"]}\u0000${p["chartName"]}\u0000${p["chartVersion"]}`,
    );

    for (const candidate of candidates) {
        const candidateKey = `${candidate.repoUrl}\u0000${candidate.chartName}\u0000${candidate.chartVersion}`;
        if (openKeys.has(candidateKey)) {
            stats.alreadyQueued += 1;
            continue;
        }
        await jobRepository.create({
            orgId,
            type: "chart_render",
            title: `${candidate.chartName} ${candidate.chartVersion}: Chart Render`,
            triggeredBy: "system",
            priority: 1,
            params: { ...candidate },
        });
        stats.enqueued += 1;
    }

    log.info(stats, "Selected candidate chart renders");
    return stats;
}
