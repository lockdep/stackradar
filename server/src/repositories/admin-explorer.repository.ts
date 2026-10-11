/**
 * The admin SBOM explorer: an org's images, each image's SBOM, the SBOM's
 * components and one component's matched advisories, as the operator sees
 * them. The deepest tenant-data read in the admin surface, which is why it
 * is a repository of its own and never served past `requireAdmin`.
 */

import { count, desc, asc, eq, and, or, ilike, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { isCurrentGeneration } from "../db/generation.js";
import { deployedImages } from "../db/findings.js";
import type { OsvRange, OsvReference } from "../db/schema/vulnerabilities.js";

import {
    EMPTY_SEVERITY,
    addSeverity,
    componentCountsBySbom,
    deploymentCountsByImage,
    severityCountsBySbom,
    type SeverityCounts,
} from "./admin-helpers.js";

export interface ExplorerImage {
    imageId: string;
    digest: string;
    registry: string | null;
    repository: string | null;
    sbomId: string;
    format: string;
    generatedAt: Date | null;
    createdAt: Date;
    /** How many `workload_containers` reference this image, across the org. */
    deploymentCount: number;
    componentCount: number;
    vulnCounts: SeverityCounts;
}

export interface ExplorerSbom {
    id: string;
    format: string;
    specVersion: string;
    sourceName: string | null;
    digest: string;
    toolName: string | null;
    toolVersion: string | null;
    generatedAt: Date | null;
    createdAt: Date;
    componentCount: number;
    vulnCounts: SeverityCounts;
}

export interface ExplorerComponent {
    id: string;
    name: string;
    version: string | null;
    type: string;
    purl: string | null;
    groupName: string | null;
    isDirect: boolean | null;
    scope: string | null;
    vulnCounts: SeverityCounts;
}

export interface ExplorerComponentsPage {
    components: ExplorerComponent[];
    total: number;
    limit: number;
    offset: number;
}

export interface ExplorerAffectedPackage {
    ecosystem: string | null;
    packageName: string;
    purl: string | null;
    versions: string[];
    ranges: OsvRange[];
    fixedVersion: string | null;
}

export interface ExplorerComponentVulnerability {
    id: string;
    vulnId: string;
    summary: string | null;
    details: string | null;
    severityLevel: string | null;
    cvssScore: number | null;
    aliases: string[];
    references: OsvReference[];
    publishedAt: Date | null;
    modifiedAt: Date | null;
    matchedBy: string | null;
    matchConfidence: string | null;
    // Recorded by the matcher at match time. `affectedPackages` below lists every
    // affected[] entry of the advisory; these say which one actually won and why,
    // which is the whole question this view exists to answer.
    matchType: string | null;
    matchedEcosystem: string | null;
    matchedFixedVersion: string | null;
    upstreamName: string | null;
    upstreamVersion: string | null;
    affectedPackages: ExplorerAffectedPackage[];
}

export interface ExplorerComponentDetail {
    component: {
        id: string;
        name: string;
        version: string | null;
        type: string;
        purl: string | null;
        cpe: string | null;
        groupName: string | null;
        isDirect: boolean | null;
        scope: string | null;
    };
    vulnerabilities: ExplorerComponentVulnerability[];
}

export const adminExplorerRepository = {
    /**
     * Images the org is running that have an SBOM, with component + vuln counts.
     *
     * The explorer's first level used to be projects, which meant the same base
     * image appeared once per workload that ran it. One row per image is both
     * shorter and the level a remediation acts on.
     */
    async listExplorerImages(orgId: string): Promise<ExplorerImage[]> {
        const sbomRows = await db
            .select({
                imageId: schema.images.id,
                digest: schema.images.digest,
                registry: schema.images.registry,
                repository: schema.images.repository,
                sbomId: schema.sboms.id,
                format: schema.sboms.format,
                generatedAt: schema.sboms.generatedAt,
                createdAt: schema.sboms.createdAt,
            })
            .from(schema.sboms)
            .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
            .where(deployedImages(orgId))
            .orderBy(asc(schema.images.repository), asc(schema.images.digest));

        if (sbomRows.length === 0) return [];

        // Counts via grouped queries (correlated subqueries render the outer column
        // unqualified and silently match the wrong table — see grouped helpers).
        const [componentCounts, deploymentCounts, bySbom] = await Promise.all([
            componentCountsBySbom(sbomRows.map((r) => r.sbomId)),
            deploymentCountsByImage(sbomRows.map((r) => r.imageId)),
            severityCountsBySbom(sbomRows.map((r) => r.sbomId)),
        ]);

        return sbomRows.map((r) => ({
            imageId: r.imageId,
            digest: r.digest,
            registry: r.registry,
            repository: r.repository,
            sbomId: r.sbomId,
            format: r.format,
            generatedAt: r.generatedAt,
            createdAt: r.createdAt,
            deploymentCount: deploymentCounts.get(r.imageId) ?? 0,
            componentCount: componentCounts.get(r.sbomId) ?? 0,
            vulnCounts: bySbom.get(r.sbomId) ?? EMPTY_SEVERITY(),
        }));
    },

    /**
     * The SBOM for an image, with component + vuln counts.
     *
     * Returns an array of at most one element: `sboms_image_id_unique` makes an
     * image's SBOM singular. Kept as a list because the explorer renders it as a
     * drill-down level and an empty result is a meaningful state — an image
     * discovered but not yet scanned.
     */
    async listExplorerSboms(imageId: string): Promise<ExplorerSbom[]> {
        const sbomRows = await db
            .select({
                id: schema.sboms.id,
                format: schema.sboms.format,
                specVersion: schema.sboms.specVersion,
                sourceName: schema.sboms.sourceName,
                digest: schema.images.digest,
                toolName: schema.sboms.toolName,
                toolVersion: schema.sboms.toolVersion,
                generatedAt: schema.sboms.generatedAt,
                createdAt: schema.sboms.createdAt,
            })
            .from(schema.sboms)
            .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
            .where(eq(schema.sboms.imageId, imageId))
            .orderBy(desc(schema.sboms.createdAt));

        if (sbomRows.length === 0) return [];

        const sbomIds = sbomRows.map((r) => r.id);
        const [componentCounts, bySbom] = await Promise.all([
            componentCountsBySbom(sbomIds),
            severityCountsBySbom(sbomIds),
        ]);

        return sbomRows.map((r) => ({
            id: r.id,
            format: r.format,
            specVersion: r.specVersion,
            sourceName: r.sourceName,
            digest: r.digest,
            toolName: r.toolName,
            toolVersion: r.toolVersion,
            generatedAt: r.generatedAt,
            createdAt: r.createdAt,
            componentCount: componentCounts.get(r.id) ?? 0,
            vulnCounts: bySbom.get(r.id) ?? EMPTY_SEVERITY(),
        }));
    },

    /** Paginated components of an SBOM, each with its vulnerability severity counts. */
    async listExplorerComponents(
        sbomId: string,
        options: { search?: string; limit?: number; offset?: number } = {},
    ): Promise<ExplorerComponentsPage> {
        const limit = Math.min(options.limit ?? 50, 200);
        const offset = options.offset ?? 0;

        const search = options.search?.trim();
        const where = search
            ? and(
                  eq(schema.components.sbomId, sbomId),
                  or(ilike(schema.components.name, `%${search}%`), ilike(schema.components.purl, `%${search}%`)),
              )
            : eq(schema.components.sbomId, sbomId);

        const [rows, totalRow] = await Promise.all([
            db
                .select({
                    id: schema.components.id,
                    name: schema.components.name,
                    version: schema.components.version,
                    type: schema.components.type,
                    purl: schema.components.purl,
                    groupName: schema.components.groupName,
                    isDirect: schema.components.isDirect,
                    scope: schema.components.scope,
                })
                .from(schema.components)
                .where(where)
                .orderBy(asc(schema.components.name), asc(schema.components.version))
                .limit(limit)
                .offset(offset),
            db.select({ total: count() }).from(schema.components).where(where),
        ]);

        const byComponent = new Map<string, SeverityCounts>();
        if (rows.length > 0) {
            const componentIds = rows.map((r) => r.id);
            const severityRows = await db
                .select({
                    componentId: schema.componentVulnerabilities.componentId,
                    level: schema.vulnerabilities.severityLevel,
                    total: count(),
                })
                .from(schema.componentVulnerabilities)
                .innerJoin(
                    schema.vulnerabilities,
                    eq(schema.componentVulnerabilities.vulnerabilityId, schema.vulnerabilities.id),
                )
                .where(inArray(schema.componentVulnerabilities.componentId, componentIds))
                .groupBy(schema.componentVulnerabilities.componentId, schema.vulnerabilities.severityLevel);

            for (const row of severityRows) {
                let counts = byComponent.get(row.componentId);
                if (!counts) {
                    counts = EMPTY_SEVERITY();
                    byComponent.set(row.componentId, counts);
                }
                addSeverity(counts, row.level, Number(row.total));
            }
        }

        return {
            components: rows.map((r) => ({
                ...r,
                vulnCounts: byComponent.get(r.id) ?? EMPTY_SEVERITY(),
            })),
            total: Number(totalRow[0]?.total ?? 0),
            limit,
            offset,
        };
    },

    /** A single component with its matched vulnerabilities and their affected packages. */
    async getExplorerComponentDetail(componentId: string): Promise<ExplorerComponentDetail | null> {
        const [component] = await db
            .select({
                id: schema.components.id,
                name: schema.components.name,
                version: schema.components.version,
                type: schema.components.type,
                purl: schema.components.purl,
                cpe: schema.components.cpe,
                groupName: schema.components.groupName,
                isDirect: schema.components.isDirect,
                scope: schema.components.scope,
            })
            .from(schema.components)
            .where(eq(schema.components.id, componentId));

        if (!component) return null;

        const vulnRows = await db
            .select({
                id: schema.vulnerabilities.id,
                vulnId: schema.vulnerabilities.vulnId,
                summary: schema.vulnerabilities.summary,
                details: schema.vulnerabilities.details,
                severityLevel: schema.vulnerabilities.severityLevel,
                cvssScore: schema.vulnerabilities.cvssScore,
                aliases: schema.vulnerabilities.aliases,
                references: schema.vulnerabilities.references,
                publishedAt: schema.vulnerabilities.publishedAt,
                modifiedAt: schema.vulnerabilities.modifiedAt,
                matchedBy: schema.componentVulnerabilities.matchedBy,
                matchConfidence: schema.componentVulnerabilities.matchConfidence,
                matchType: schema.componentVulnerabilities.matchType,
                matchedEcosystem: schema.componentVulnerabilities.matchedEcosystem,
                matchedFixedVersion: schema.componentVulnerabilities.fixedVersion,
                upstreamName: schema.componentVulnerabilities.upstreamName,
                upstreamVersion: schema.componentVulnerabilities.upstreamVersion,
            })
            .from(schema.componentVulnerabilities)
            .innerJoin(
                schema.vulnerabilities,
                eq(schema.componentVulnerabilities.vulnerabilityId, schema.vulnerabilities.id),
            )
            .where(eq(schema.componentVulnerabilities.componentId, componentId))
            .orderBy(desc(schema.vulnerabilities.cvssScore));

        const byVuln = new Map<string, ExplorerAffectedPackage[]>();
        if (vulnRows.length > 0) {
            const vulnIds = vulnRows.map((v) => v.id);
            const affectedRows = await db
                .select({
                    vulnerabilityId: schema.vulnerabilityAffectedPackages.vulnerabilityId,
                    ecosystem: schema.vulnerabilityAffectedPackages.ecosystem,
                    packageName: schema.vulnerabilityAffectedPackages.packageName,
                    purl: schema.vulnerabilityAffectedPackages.purl,
                    versions: schema.vulnerabilityAffectedPackages.versions,
                    ranges: schema.vulnerabilityAffectedPackages.ranges,
                    fixedVersion: schema.vulnerabilityAffectedPackages.fixedVersion,
                })
                .from(schema.vulnerabilityAffectedPackages)
                .where(
                    and(inArray(schema.vulnerabilityAffectedPackages.vulnerabilityId, vulnIds), isCurrentGeneration()),
                );

            for (const row of affectedRows) {
                let list = byVuln.get(row.vulnerabilityId);
                if (!list) {
                    list = [];
                    byVuln.set(row.vulnerabilityId, list);
                }
                list.push({
                    ecosystem: row.ecosystem,
                    packageName: row.packageName,
                    purl: row.purl,
                    versions: row.versions ?? [],
                    ranges: row.ranges ?? [],
                    fixedVersion: row.fixedVersion,
                });
            }
        }

        return {
            component,
            vulnerabilities: vulnRows.map((v) => ({
                id: v.id,
                vulnId: v.vulnId,
                summary: v.summary,
                details: v.details,
                severityLevel: v.severityLevel,
                cvssScore: v.cvssScore,
                aliases: v.aliases ?? [],
                references: v.references ?? [],
                publishedAt: v.publishedAt,
                modifiedAt: v.modifiedAt,
                matchedBy: v.matchedBy,
                matchConfidence: v.matchConfidence,
                matchType: v.matchType,
                matchedEcosystem: v.matchedEcosystem,
                matchedFixedVersion: v.matchedFixedVersion,
                upstreamName: v.upstreamName,
                upstreamVersion: v.upstreamVersion,
                affectedPackages: byVuln.get(v.id) ?? [],
            })),
        };
    },
};
