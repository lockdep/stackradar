/**
 * The Packages page — one row per `name@version` across the images a scope
 * runs, with its finding counts, its ecosystems and the occurrences behind a
 * count cell. The scope is a cluster or an org; both resolve to the same
 * deployed-image predicate `db/findings.ts` counts by, so a Packages list
 * and the matching vulnerability counts describe the same population. Split
 * from `component.repository.ts`, which is the SBOM ingest's writer and the
 * per-SBOM readers.
 */

import {
    eq,
    ne,
    and,
    or,
    like,
    ilike,
    asc,
    desc,
    isNull,
    isNotNull,
    inArray,
    sql,
    count,
    countDistinct,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "../db/index.js";
import type { SQL } from "drizzle-orm";
import {
    collapsedFindings,
    deployedImages,
    deployedImagesInCluster,
    emptySeverityCounts,
    addSeverity,
    REPORTED_SEVERITIES,
    type SeverityCounts,
} from "../db/findings.js";

export type ClusterPackage = {
    name: string;
    version: string | null;
    purl: string | null;
    packageType: string | null;
    packageLanguage: string | null;
    license: string | null;
    imageCount: number;
    workloadCount: number;
    /** Distinct running containers on an image carrying this version. */
    containerCount: number;
    /** Clusters with at least one image carrying this version — always 1 under a cluster scope. */
    clusterCount: number;
    vulnCounts: SeverityCounts;
    /** Of those, the distinct ones on the CISA KEV catalogue — whatever their severity, unscored included. */
    kevCount: number;
};

/**
 * Where a package list looks: one cluster, or every cluster of an org.
 *
 * The same two scopes `VulnerabilityScope` spells, and for the same reason:
 * the cluster Packages tab and the org-wide Packages page are one
 * implementation each, and the Dashboard's Packages card links to the org
 * list exactly as a cluster Overview's links to its tab. Under ADR 0006 an
 * org's images are the disjoint union of its clusters', so a version running
 * in two clusters is one row here with a cluster spread of two.
 */
export type PackageScope = { clusterId: string } | { orgId: string };

/** `?control=` on the package lists. `yours` includes the images nothing has decided. */
export type PackageControlFilter = "yours" | "third-party";

/**
 * Whose images — the vulnerability lists' predicate, on the `images` row every
 * package query already joins, so the filter adds a comparison and no scan.
 */
function controlledBy(control: PackageControlFilter | undefined): SQL | undefined {
    if (!control) return undefined;
    return control === "third-party"
        ? eq(schema.images.control, "third-party")
        : ne(schema.images.control, "third-party");
}

/**
 * What a package list's Ecosystem menu filters by, read off the purl: its
 * type, plus the distro namespace where the type is an OS package manager —
 * `deb` alone would fold Ubuntu and Debian, which are patched by different
 * people. An expression, not a column: both users of it sit inside queries
 * that already read every library component of the scope to group them, so
 * it costs a string operation on rows in hand and no scan of its own —
 * `split_part`, because the one-regex spelling was five times slower over
 * the same rows.
 */
const packageEcosystem: SQL<string> = sql<string>`CASE
    WHEN ${schema.components.purl} LIKE ANY (ARRAY['pkg:deb/%', 'pkg:apk/%', 'pkg:rpm/%'])
        THEN split_part(substring(${schema.components.purl} from 5), '/', 1) || '/' || split_part(${schema.components.purl}, '/', 2)
    WHEN ${schema.components.purl} LIKE 'pkg:%/%'
        THEN split_part(substring(${schema.components.purl} from 5), '/', 1)
END`;

/**
 * The finding population of a scope — `db/findings.ts`'s predicate over
 * `images`, under the list's own control filter so a row's vulnerability
 * counts are of the images it was listed from.
 */
function scopedDeployedImages(scope: PackageScope, control?: PackageControlFilter): SQL {
    const images = "clusterId" in scope ? deployedImagesInCluster(scope.clusterId) : deployedImages(scope.orgId);
    return and(images, controlledBy(control))!;
}

export type ClusterPackagesPage = {
    packages: ClusterPackage[];
    total: number;
    limit: number;
    offset: number;
};

export type ClusterPackageOccurrences = {
    images: {
        id: string;
        registry: string | null;
        repository: string | null;
        digest: string;
    }[];
    workloads: {
        /** A container of the workload that runs the package — the link target. */
        containerId: string;
        workloadName: string;
        workloadKind: string | null;
        namespaceName: string;
    }[];
};

/**
 * The occurrences drill-down of a package row: the images and workloads one
 * version is in, each with its cluster. The org-wide list needs the cluster
 * to say where a hit is and to link a workload into its cluster; a cluster
 * tab gets the same shape and ignores it.
 */
export type PackageOccurrences = {
    images: (ClusterPackageOccurrences["images"][number] & { clusterId: string; clusterName: string })[];
    workloads: (ClusterPackageOccurrences["workloads"][number] & {
        clusterId: string;
        clusterName: string;
    })[];
};

/**
 * The population predicate of {@link componentRepository.findPackages}:
 * library components of the scope's images, optionally narrowed by a
 * name/purl search, to the images one side controls and to one ecosystem
 * (a purl prefix, so the same string `packageEcosystem` reads back). Scope is `images.clusterId` or `images.orgId` — the
 * column `deployedImagesInCluster` / `deployedImages` scope findings by, so a
 * Packages list and the matching vulnerability counts describe the same
 * population.
 */
export function packagesWhere(
    scope: PackageScope,
    search: string | undefined,
    control?: PackageControlFilter,
    ecosystem?: string,
) {
    return and(
        "clusterId" in scope ? eq(schema.images.clusterId, scope.clusterId) : eq(schema.images.orgId, scope.orgId),
        controlledBy(control),
        eq(schema.components.type, "library"),
        ecosystem ? like(schema.components.purl, `pkg:${ecosystem}/%`) : undefined,
        search
            ? or(ilike(schema.components.name, `%${search}%`), ilike(schema.components.purl, `%${search}%`))
            : undefined,
    );
}

/**
 * `?severity=` and `?kev=true` on a package list: the rows whose
 * Vulnerabilities cell has a non-zero count in one of these bands, a KEV
 * marker, or — both set — a single finding that is both ("a critical on
 * KEV", not "a critical and, elsewhere, something on KEV"). Asked of `collapsedFindings` under
 * the list's own image scope — the same rows, joined the same way, that
 * `fetchPackageDetails` counts — and not of `component_vulnerabilities`
 * directly: the collapse folds a distro's binaries into one surviving
 * component, so a raw EXISTS would list `libssl3` as critical beside a cell
 * of zeros. That makes this the one filter with a scan of its own (the
 * scope's collapse), paid only while one of the two is set.
 */
function hasMatchingFinding(
    scope: PackageScope,
    control: PackageControlFilter | undefined,
    severities: string[] | undefined,
    kev: boolean | undefined,
): SQL | undefined {
    const bands = severities?.filter((s) => (REPORTED_SEVERITIES as readonly string[]).includes(s)) ?? [];
    if (bands.length === 0 && !kev) return undefined;

    const findings = collapsedFindings(scopedDeployedImages(scope, control));
    const carrier = alias(schema.components, "finding_component");
    const affected = db
        .select({ name: carrier.name, version: sql`coalesce(${carrier.version}, '')` })
        .from(findings)
        .innerJoin(carrier, eq(findings.componentId, carrier.id))
        .where(
            and(
                bands.length > 0 ? inArray(sql`lower(${findings.severityLevel})`, bands) : undefined,
                kev ? isNotNull(findings.kevListedAt) : undefined,
            ),
        );
    // The row unit is (name, version) and a null version is part of it, so
    // the pair is compared with the null spelled — `IN` alone would drop it.
    return sql`(${schema.components.name}, coalesce(${schema.components.version}, '')) IN ${affected}`;
}

/** One page of `(name, version)` groups, with spread counts and a representative component. */
function fetchPackagePage(where: ReturnType<typeof packagesWhere>, limit: number, offset: number) {
    return db
        .select({
            name: schema.components.name,
            version: schema.components.version,
            purl: sql<string | null>`min(${schema.components.purl})`,
            representativeId: sql<string>`min(${schema.components.id}::text)`,
            imageCount: countDistinct(schema.images.id),
            // LEFT JOIN, not inner: an image can be uploaded before
            // any inventory references it. Its packages are real and
            // must list; count(DISTINCT) ignores the join's nulls, so
            // such a group reports zero workloads rather than
            // disappearing.
            workloadCount: countDistinct(schema.workloadContainers.workloadId),
            containerCount: countDistinct(schema.workloadContainers.id),
            clusterCount: countDistinct(schema.images.clusterId),
        })
        .from(schema.components)
        .innerJoin(schema.sboms, eq(schema.components.sbomId, schema.sboms.id))
        .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
        .leftJoin(schema.workloadContainers, eq(schema.workloadContainers.imageId, schema.images.id))
        .where(where)
        .groupBy(schema.components.name, schema.components.version)
        .orderBy(asc(schema.components.name), asc(schema.components.version))
        .limit(limit)
        .offset(offset);
}

/** How many `(name, version)` groups the predicate matches in total. */
async function countPackageGroups(where: ReturnType<typeof packagesWhere>): Promise<number> {
    const totalRow = await db
        .select({
            total: sql<number>`count(DISTINCT (${schema.components.name}, ${schema.components.version}))`,
        })
        .from(schema.components)
        .innerJoin(schema.sboms, eq(schema.components.sbomId, schema.sboms.id))
        .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
        .where(where);
    return Number(totalRow[0]?.total ?? 0);
}

/**
 * The page's per-row detail, fetched after the page is known: licenses and
 * syft properties of each group's representative component, plus finding
 * counts for the page's package names.
 */
function fetchPackageDetails(
    scope: PackageScope,
    control: PackageControlFilter | undefined,
    repIds: string[],
    pageNames: string[],
) {
    const findings = collapsedFindings(scopedDeployedImages(scope, control));

    return Promise.all([
        db
            .select({
                componentId: schema.componentLicenses.componentId,
                spdxId: schema.licenses.spdxId,
                name: schema.licenses.name,
                expression: schema.licenses.expression,
            })
            .from(schema.componentLicenses)
            .innerJoin(schema.licenses, eq(schema.componentLicenses.licenseId, schema.licenses.id))
            .where(inArray(schema.componentLicenses.componentId, repIds)),
        db
            .select({
                componentId: schema.componentProperties.componentId,
                name: schema.componentProperties.name,
                value: schema.componentProperties.value,
            })
            .from(schema.componentProperties)
            .where(
                and(
                    inArray(schema.componentProperties.componentId, repIds),
                    inArray(schema.componentProperties.name, ["syft:package:type", "syft:package:language"]),
                ),
            ),
        // Findings for the page's packages, counted per (name, version) by
        // *identity* — the same package version in ten images carries the
        // same advisory ten times, and it is one thing to fix. Filtered to
        // the page's names in SQL so the alias-collapse scan does not run
        // over the whole scope for a 50-row page.
        db
            .select({
                name: schema.components.name,
                version: schema.components.version,
                severityLevel: findings.severityLevel,
                total: countDistinct(findings.identity),
                kev: sql<number>`count(DISTINCT ${findings.identity}) FILTER (WHERE ${findings.kevListedAt} IS NOT NULL)`,
            })
            .from(findings)
            .innerJoin(schema.components, eq(findings.componentId, schema.components.id))
            .where(inArray(schema.components.name, pageNames))
            .groupBy(schema.components.name, schema.components.version, findings.severityLevel),
    ]);
}

/** Join the page rows with their detail rows into the response shape. */
function buildPackages(
    rows: Awaited<ReturnType<typeof fetchPackagePage>>,
    [licensesResult, propsResult, severityRows]: Awaited<ReturnType<typeof fetchPackageDetails>>,
): ClusterPackage[] {
    const licenseMap = new Map<string, string>();
    for (const lic of licensesResult) {
        if (!licenseMap.has(lic.componentId)) {
            licenseMap.set(lic.componentId, lic.spdxId ?? lic.expression ?? lic.name ?? "Unknown");
        }
    }

    const propsMap = new Map<string, { packageType: string | null; packageLanguage: string | null }>();
    for (const prop of propsResult) {
        if (!propsMap.has(prop.componentId)) {
            propsMap.set(prop.componentId, { packageType: null, packageLanguage: null });
        }
        const entry = propsMap.get(prop.componentId)!;
        if (prop.name === "syft:package:type") entry.packageType = prop.value;
        else if (prop.name === "syft:package:language") entry.packageLanguage = prop.value;
    }

    // NUL separator — cannot occur in a package name, so keys cannot collide.
    const groupKey = (name: string, version: string | null) => `${name}\u0000${version ?? ""}`;
    const vulnMap = new Map<string, SeverityCounts>();
    // Summed across the severity rows, unscored ones included: a KEV listing
    // counts whatever band the finding is in. An identity has one surviving
    // severity per image, so the bands of a group do not overlap in practice.
    const kevMap = new Map<string, number>();
    for (const row of severityRows) {
        const key = groupKey(row.name, row.version);
        kevMap.set(key, (kevMap.get(key) ?? 0) + Number(row.kev));
        let counts = vulnMap.get(key);
        if (!counts) {
            counts = emptySeverityCounts();
            vulnMap.set(key, counts);
        }
        addSeverity(counts, row.severityLevel, Number(row.total));
    }

    return rows.map((row) => {
        const props = propsMap.get(row.representativeId);
        return {
            name: row.name,
            version: row.version,
            purl: row.purl,
            packageType: props?.packageType ?? null,
            packageLanguage: props?.packageLanguage ?? null,
            license: licenseMap.get(row.representativeId) ?? null,
            imageCount: Number(row.imageCount),
            workloadCount: Number(row.workloadCount),
            containerCount: Number(row.containerCount),
            clusterCount: Number(row.clusterCount),
            vulnCounts: vulnMap.get(groupKey(row.name, row.version)) ?? emptySeverityCounts(),
            kevCount: kevMap.get(groupKey(row.name, row.version)) ?? 0,
        };
    });
}

export const packageRepository = {
    /**
     * The distinct packages running in scope — the cluster Packages tab, or
     * the org-wide Packages page.
     *
     * One row per `(name, version)`, not per component: the same
     * `lodash@4.17.21` inside thirty images is one thing to know about, and
     * the image/workload/cluster counts carry the "how widespread" answer
     * instead of thirty duplicate rows. Scope is `images.clusterId` or
     * `images.orgId` — the column `deployedImagesInCluster` / `deployedImages`
     * scope findings by, so this list and the matching vulnerability counts
     * describe the same population.
     *
     * Search and pagination are server-side on purpose: a cluster's component
     * rows number in the tens of thousands, which is past what the
     * client-side filtering the workload detail page does can carry.
     *
     * License, package type and language come from one *representative*
     * component per group rather than being aggregated across the group.
     * Duplicates of a pinned `name@version` carry identical metadata in
     * practice, and joining `component_properties` into the grouped scan
     * would drag its largest table through the aggregate for a value the
     * page only needs fifty of.
     */
    async findPackages(
        scope: PackageScope,
        options: {
            search?: string | undefined;
            control?: PackageControlFilter | undefined;
            ecosystem?: string | undefined;
            severities?: string[] | undefined;
            kev?: boolean | undefined;
            limit?: number | undefined;
            offset?: number | undefined;
        } = {},
    ): Promise<ClusterPackagesPage> {
        const limit = Math.min(options.limit ?? 50, 200);
        const offset = options.offset ?? 0;
        const search = options.search?.trim();
        const where = and(
            packagesWhere(scope, search, options.control, options.ecosystem),
            hasMatchingFinding(scope, options.control, options.severities, options.kev),
        );

        const [rows, total] = await Promise.all([fetchPackagePage(where, limit, offset), countPackageGroups(where)]);
        if (rows.length === 0) {
            return { packages: [], total, limit, offset };
        }

        const repIds = rows.map((r) => r.representativeId);
        const pageNames = [...new Set(rows.map((r) => r.name))];
        const details = await fetchPackageDetails(scope, options.control, repIds, pageNames);

        return { packages: buildPackages(rows, details), total, limit, offset };
    },

    /**
     * The ecosystems a scope's packages come from, most rows first — the
     * options of the list's Ecosystem menu, each a value `?ecosystem=`
     * accepts. Of the whole scope, not of the list's other filters: a menu
     * whose options come and go with the search box is harder to read than
     * one that sometimes lists nothing.
     */
    async findPackageEcosystems(scope: PackageScope): Promise<string[]> {
        const rows = await db
            .select({ ecosystem: packageEcosystem })
            .from(schema.components)
            .innerJoin(schema.sboms, eq(schema.components.sbomId, schema.sboms.id))
            .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
            .where(and(packagesWhere(scope, undefined), isNotNull(packageEcosystem)))
            .groupBy(packageEcosystem)
            .orderBy(desc(count()), asc(packageEcosystem));
        return rows.map((r) => r.ecosystem);
    },

    /**
     * Every place one package version occurs in scope — the drill-down
     * behind a package list's image and workload counts, each hit with its
     * cluster.
     *
     * Workloads are one row per *workload* so the list length matches the
     * `workloadCount` the user clicked; `containerId` is a representative
     * container (the detail page's unit) to link to. Version is part of the
     * package's identity, so `null` matches only versionless components —
     * it is not a wildcard.
     */
    async findPackageOccurrences(
        scope: PackageScope,
        options: { name: string; version: string | null; control?: PackageControlFilter | undefined },
    ): Promise<PackageOccurrences> {
        const where = and(
            "clusterId" in scope ? eq(schema.images.clusterId, scope.clusterId) : eq(schema.images.orgId, scope.orgId),
            // The list's filter, so a count opens to the things it counted.
            controlledBy(options.control),
            eq(schema.components.type, "library"),
            eq(schema.components.name, options.name),
            options.version === null
                ? isNull(schema.components.version)
                : eq(schema.components.version, options.version),
        );

        const [imageRows, workloadRows] = await Promise.all([
            db
                .selectDistinct({
                    id: schema.images.id,
                    registry: schema.images.registry,
                    repository: schema.images.repository,
                    digest: schema.images.digest,
                    clusterId: schema.clusters.id,
                    clusterName: schema.clusters.name,
                })
                .from(schema.components)
                .innerJoin(schema.sboms, eq(schema.components.sbomId, schema.sboms.id))
                .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
                .innerJoin(schema.clusters, eq(schema.clusters.id, schema.images.clusterId))
                .where(where)
                .orderBy(asc(schema.clusters.name), asc(schema.images.repository), asc(schema.images.digest)),
            /* The cluster comes through `images.cluster_id` on both sides: an
               image belongs to exactly one cluster (ADR 0006), and a container
               can only reference an image of its own cluster, so the
               workload's cluster and its image's are the same row. */
            db
                .select({
                    containerId: sql<string>`min(${schema.workloadContainers.id}::text)`,
                    workloadName: schema.workloads.name,
                    workloadKind: schema.workloads.kind,
                    namespaceName: schema.namespaces.name,
                    clusterId: schema.clusters.id,
                    clusterName: schema.clusters.name,
                })
                .from(schema.components)
                .innerJoin(schema.sboms, eq(schema.components.sbomId, schema.sboms.id))
                .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
                .innerJoin(schema.clusters, eq(schema.clusters.id, schema.images.clusterId))
                .innerJoin(schema.workloadContainers, eq(schema.workloadContainers.imageId, schema.images.id))
                .innerJoin(schema.workloads, eq(schema.workloads.id, schema.workloadContainers.workloadId))
                .innerJoin(schema.namespaces, eq(schema.namespaces.id, schema.workloads.namespaceId))
                .where(where)
                .groupBy(
                    schema.workloads.id,
                    schema.workloads.name,
                    schema.workloads.kind,
                    schema.namespaces.name,
                    schema.clusters.id,
                    schema.clusters.name,
                )
                .orderBy(asc(schema.clusters.name), asc(schema.namespaces.name), asc(schema.workloads.name)),
        ]);

        return { images: imageRows, workloads: workloadRows };
    },
};
