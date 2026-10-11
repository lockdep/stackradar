/**
 * The attribution pass: map every installed chart onto the mirror.
 *
 * Runs from the sync worker directly after the mirror refresh (or its
 * fresh-skip), inside the same advisory lock — the mirror prune cascades
 * `chart_attributions` mid-cron, and this pass rebuilding them immediately
 * after is what makes that safe. See README.md.
 *
 * The write is stamp-and-prune on `matched_at`: a chart that stops matching,
 * or is no longer installed, loses its attribution nightly. Auto-add then
 * registers matched http(s) repositories (`registerMatched`) so the chart
 * repo sync at 04:45 fetches their `index.yaml` the same night; OCI matches
 * keep their attribution row only — the mirror itself is their version
 * source.
 */

import { orgsWithImages, resolveImageControlQuietly } from "../services/image-control.service.js";
import { inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { chartRepositoryRepository } from "../repositories/chart-repository.repository.js";
import { isIndexableRepoUrl } from "../lib/chart-repo.js";
import { attributeChart, type AttributionCandidate, type InstalledChartVersion } from "../lib/chart-attribution.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("artifacthub-sync:attribution");

export interface AttributionPassStats {
    chartsExamined: number;
    attributionsWritten: number;
    attributionsRefused: number;
    reposAutoAdded: number;
}

const CANDIDATE_QUERY_CHUNK = 500;
const UPSERT_BATCH = 500;

export async function runAttributionPass(): Promise<AttributionPassStats> {
    const stamp = new Date();

    // Worklist: every distinct (org, chart, chartVersion, appVersion) the
    // inventory reports. `chart_name` is indexed; the set is small (one row
    // per distinct installed version, not per release).
    const installs = await db
        .selectDistinct({
            orgId: schema.helmReleases.orgId,
            chartName: schema.helmReleases.chartName,
            chartVersion: schema.helmReleases.chartVersion,
            appVersion: schema.helmReleases.appVersion,
        })
        .from(schema.helmReleases)
        .where(isNotNull(schema.helmReleases.chartName));

    const groups = new Map<string, { orgId: string; chartName: string; installs: InstalledChartVersion[] }>();
    for (const row of installs) {
        const chartName = row.chartName!;
        const key = `${row.orgId} ${chartName}`;
        const group = groups.get(key) ?? { orgId: row.orgId, chartName, installs: [] };
        group.installs.push({ chartVersion: row.chartVersion, appVersion: row.appVersion });
        groups.set(key, group);
    }

    // Mirror candidates for every distinct chart name, batched.
    const names = [...new Set([...groups.values()].map((g) => g.chartName))];
    const candidatesByName = new Map<string, AttributionCandidate[]>();
    for (let i = 0; i < names.length; i += CANDIDATE_QUERY_CHUNK) {
        const chunk = names.slice(i, i + CANDIDATE_QUERY_CHUNK);
        const rows = await db
            .select({
                packageId: schema.artifactHubPackages.id,
                name: schema.artifactHubPackages.name,
                repoName: schema.artifactHubPackages.repoName,
                repoUrl: schema.artifactHubPackages.repoUrl,
                stars: schema.artifactHubPackages.stars,
                repoVerified: schema.artifactHubPackages.repoVerified,
                repoOfficial: schema.artifactHubPackages.repoOfficial,
                versions: schema.artifactHubPackages.versions,
            })
            .from(schema.artifactHubPackages)
            .where(inArray(schema.artifactHubPackages.name, chunk));
        for (const { name, ...candidate } of rows) {
            const list = candidatesByName.get(name) ?? [];
            list.push(candidate);
            candidatesByName.set(name, list);
        }
    }

    // Run the matcher per group.
    const matched: Array<typeof schema.chartAttributions.$inferInsert> = [];
    const matchedUrlsByOrg = new Map<string, Set<string>>();
    let refused = 0;

    for (const group of groups.values()) {
        const decision = attributeChart(group.installs, candidatesByName.get(group.chartName) ?? []);

        if (decision.outcome === "refused") {
            refused++;
            log.info(
                { orgId: group.orgId, chartName: group.chartName, reason: decision.reason },
                "Chart attribution refused",
            );
            continue;
        }

        log.debug({ orgId: group.orgId, chartName: group.chartName, evidence: decision.evidence }, "Chart attributed");
        matched.push({
            orgId: group.orgId,
            chartName: group.chartName,
            packageId: decision.candidate.packageId,
            repoUrl: decision.candidate.repoUrl,
            evidence: decision.evidence,
            matchedAt: stamp,
        });
        const urls = matchedUrlsByOrg.get(group.orgId) ?? new Set();
        urls.add(decision.candidate.repoUrl);
        matchedUrlsByOrg.set(group.orgId, urls);
    }

    // Stamp-and-prune. The pass covers every org each night, so the prune is
    // global: anything not stamped this run is stale by definition.
    await db.transaction(async (tx) => {
        for (let i = 0; i < matched.length; i += UPSERT_BATCH) {
            const batch = matched.slice(i, i + UPSERT_BATCH);
            await tx
                .insert(schema.chartAttributions)
                .values(batch)
                .onConflictDoUpdate({
                    target: [schema.chartAttributions.orgId, schema.chartAttributions.chartName],
                    set: {
                        packageId: sql`excluded.package_id`,
                        repoUrl: sql`excluded.repo_url`,
                        evidence: sql`excluded.evidence`,
                        matchedAt: stamp,
                        updatedAt: stamp,
                    },
                });
        }
        await tx.delete(schema.chartAttributions).where(lt(schema.chartAttributions.matchedAt, stamp));
    });

    // Auto-add matched http(s) repositories. `registerMatched` never
    // resurrects a deleted or disabled row; OCI URLs are skipped — nothing
    // could refresh an index for them, and the attribution row is what the
    // read path and the mirror fallback use.
    let reposAutoAdded = 0;
    for (const [orgId, urls] of matchedUrlsByOrg) {
        const indexable = [...urls].filter(isIndexableRepoUrl);
        reposAutoAdded += await chartRepositoryRepository.registerMatched(orgId, indexable);
    }

    // A release that gained (or lost) a public chart changes who controls its
    // images. The pass is nightly and covers every org, so this is where the
    // verdicts that the 5-minute inventory path leaves alone are refreshed.
    for (const orgId of await orgsWithImages()) {
        await resolveImageControlQuietly(orgId);
    }

    const stats: AttributionPassStats = {
        chartsExamined: groups.size,
        attributionsWritten: matched.length,
        attributionsRefused: refused,
        reposAutoAdded,
    };
    log.info(stats, "Attribution pass complete");
    return stats;
}
