/**
 * Read access to chart attributions.
 *
 * Serves the read side only: the suggestion feed, the upgrade recommendation
 * and the release page resolve a null `helm_releases.repo_url` through these
 * rows, always labelling the result as an inference (`matchKind:
 * "attributed"`). The write side is the nightly attribution pass in
 * `artifacthub-sync/attribution.ts`.
 *
 * Every read joins the attributed package, because the two consumers need the
 * same pair: the repo URL to resolve identity, and the mirror's version list
 * as the fallback version source for repositories that serve no `index.yaml`
 * (OCI, or an auto-added repo the nightly index sync has not reached yet).
 */

import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { ArtifactHubVersion } from "../db/schema/artifact-hub.js";

export interface ChartAttributionForOrg {
    chartName: string;
    packageId: string;
    /** The attributed repository — an inference, never written to `helm_releases`. */
    repoUrl: string;
    /** Artifact Hub's repository slug — what makes the package's own page linkable. */
    repoName: string;
    latestVersion: string | null;
    /** The mirror's version list for the attributed package. */
    versions: ArtifactHubVersion[];
}

const selection = {
    chartName: schema.chartAttributions.chartName,
    packageId: schema.chartAttributions.packageId,
    repoUrl: schema.chartAttributions.repoUrl,
    repoName: schema.artifactHubPackages.repoName,
    latestVersion: schema.artifactHubPackages.latestVersion,
    versions: schema.artifactHubPackages.versions,
};

export const chartAttributionRepository = {
    /** Every attribution in the org, with its package's versions. */
    async forOrg(orgId: string): Promise<ChartAttributionForOrg[]> {
        return db
            .select(selection)
            .from(schema.chartAttributions)
            .innerJoin(
                schema.artifactHubPackages,
                eq(schema.chartAttributions.packageId, schema.artifactHubPackages.id),
            )
            .where(eq(schema.chartAttributions.orgId, orgId));
    },

    async findForChart(orgId: string, chartName: string): Promise<ChartAttributionForOrg | undefined> {
        const [row] = await db
            .select(selection)
            .from(schema.chartAttributions)
            .innerJoin(
                schema.artifactHubPackages,
                eq(schema.chartAttributions.packageId, schema.artifactHubPackages.id),
            )
            .where(and(eq(schema.chartAttributions.orgId, orgId), eq(schema.chartAttributions.chartName, chartName)));
        return row;
    },
};
