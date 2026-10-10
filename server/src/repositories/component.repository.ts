import { eq, ne, and, or, like, ilike, asc, desc, isNull, isNotNull, inArray, sql, count, countDistinct } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema, type Transaction } from "../db/index.js";
import type { Component, NewComponent } from "../db/schema/components.js";
import type { License, NewLicense } from "../db/schema/licenses.js";
import type { NewComponentHash } from "../db/schema/component-hashes.js";
import type { NewComponentExternalRef } from "../db/schema/component-external-refs.js";
import type { NewComponentProperty } from "../db/schema/component-properties.js";
import type { SQL } from "drizzle-orm";
import { collapsedFindings, deployedImages, deployedImagesInCluster, emptySeverityCounts, addSeverity, REPORTED_SEVERITIES, type SeverityCounts } from "../db/findings.js";

const BATCH_CHUNK_SIZE = 500;

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
    const images = "clusterId" in scope
        ? deployedImagesInCluster(scope.clusterId)
        : deployedImages(scope.orgId);
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

export type ComponentWithDetails = Component & {
    license: string | null;
    vulnerabilities: { id: string; severity: string | null }[];
    packageType: string | null;
    packageLanguage: string | null;
    location: string | null;
};

/**
 * The findings on these components — the same set, under the same rules, that
 * the Vulnerabilities tab lists.
 *
 * Scoped by component id rather than by image, so it deliberately does not
 * re-assert "current SBOM": the callers have already resolved the component
 * list from the current SBOM, and a second copy of that rule here is a second
 * place for it to change.
 */
async function findingsForComponents(
    componentIds: string[]
): Promise<{ componentId: string; vulnId: string; severityLevel: string | null }[]> {
    const findings = collapsedFindings(inArray(schema.components.id, componentIds));
    return db
        .select({
            componentId: findings.componentId,
            vulnId: findings.vulnId,
            severityLevel: findings.severityLevel,
        })
        .from(findings);
}

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
    ecosystem?: string
) {
    return and(
        "clusterId" in scope
            ? eq(schema.images.clusterId, scope.clusterId)
            : eq(schema.images.orgId, scope.orgId),
        controlledBy(control),
        eq(schema.components.type, "library"),
        ecosystem ? like(schema.components.purl, `pkg:${ecosystem}/%`) : undefined,
        search
            ? or(
                  ilike(schema.components.name, `%${search}%`),
                  ilike(schema.components.purl, `%${search}%`)
              )
            : undefined
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
    kev: boolean | undefined
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
                kev ? isNotNull(findings.kevListedAt) : undefined
            )
        );
    // The row unit is (name, version) and a null version is part of it, so
    // the pair is compared with the null spelled — `IN` alone would drop it.
    return sql`(${schema.components.name}, coalesce(${schema.components.version}, '')) IN ${affected}`;
}

/** One page of `(name, version)` groups, with spread counts and a representative component. */
function fetchPackagePage(
    where: ReturnType<typeof packagesWhere>,
    limit: number,
    offset: number
) {
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
        .leftJoin(
            schema.workloadContainers,
            eq(schema.workloadContainers.imageId, schema.images.id)
        )
        .where(where)
        .groupBy(schema.components.name, schema.components.version)
        .orderBy(asc(schema.components.name), asc(schema.components.version))
        .limit(limit)
        .offset(offset);
}

/** How many `(name, version)` groups the predicate matches in total. */
async function countPackageGroups(
    where: ReturnType<typeof packagesWhere>
): Promise<number> {
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
    pageNames: string[]
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
            .innerJoin(
                schema.licenses,
                eq(schema.componentLicenses.licenseId, schema.licenses.id)
            )
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
                    inArray(schema.componentProperties.name, [
                        "syft:package:type",
                        "syft:package:language",
                    ])
                )
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
            .innerJoin(
                schema.components,
                eq(findings.componentId, schema.components.id)
            )
            .where(inArray(schema.components.name, pageNames))
            .groupBy(
                schema.components.name,
                schema.components.version,
                findings.severityLevel
            ),
    ]);
}

/** Join the page rows with their detail rows into the response shape. */
function buildPackages(
    rows: Awaited<ReturnType<typeof fetchPackagePage>>,
    [licensesResult, propsResult, severityRows]: Awaited<
        ReturnType<typeof fetchPackageDetails>
    >
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

export const componentRepository = {
    async findById(id: string): Promise<Component | undefined> {
        const results = await db
            .select()
            .from(schema.components)
            .where(eq(schema.components.id, id));
        return results[0];
    },

    async findBySbomId(sbomId: string): Promise<Component[]> {
        return db
            .select()
            .from(schema.components)
            .where(eq(schema.components.sbomId, sbomId));
    },

    async findLibrariesBySbomId(sbomId: string): Promise<Component[]> {
        return db
            .select()
            .from(schema.components)
            .where(
                and(
                    eq(schema.components.sbomId, sbomId),
                    eq(schema.components.type, "library")
                )
            );
    },

    /**
     * Find all library components for an image's SBOM.
     * Only returns components with type 'library'.
     *
     * No `isCurrent` filter and no `LIMIT 1` tie-breaker: `sboms_image_id_unique`
     * makes "the image's SBOM" singular, so there is nothing left to
     * disambiguate.
     */
    async findByImageIdCurrent(imageId: string): Promise<Component[]> {
        const sbom = await db
            .select({ id: schema.sboms.id })
            .from(schema.sboms)
            .where(eq(schema.sboms.imageId, imageId));

        if (sbom.length === 0) return [];

        return db
            .select()
            .from(schema.components)
            .where(
                and(
                    eq(schema.components.sbomId, sbom[0]!.id),
                    eq(schema.components.type, "library")
                )
            );
    },

    /**
     * Find all components for an image's SBOM with license and vulnerability info.
     * Used for the workload detail view's dependencies tab.
     */
    async findByImageIdWithDetails(imageId: string): Promise<ComponentWithDetails[]> {
        const components = await this.findByImageIdCurrent(imageId);

        if (components.length === 0) {
            return [];
        }

        const componentIds = components.map(c => c.id);

        const licensesResult = await db
            .select({
                componentId: schema.componentLicenses.componentId,
                spdxId: schema.licenses.spdxId,
                name: schema.licenses.name,
                expression: schema.licenses.expression,
            })
            .from(schema.componentLicenses)
            .innerJoin(
                schema.licenses,
                eq(schema.componentLicenses.licenseId, schema.licenses.id)
            )
            .where(inArray(schema.componentLicenses.componentId, componentIds));

        // The same findings the Vulnerabilities tab lists, so a component's
        // badge on the Dependencies tab and its row one tab over agree.
        const vulnsResult = await findingsForComponents(componentIds);

        const SYFT_PROP_NAMES = [
            "syft:package:type",
            "syft:package:language",
            "syft:location:0:path",
        ];
        const propsResult = await db
            .select({
                componentId: schema.componentProperties.componentId,
                name: schema.componentProperties.name,
                value: schema.componentProperties.value,
            })
            .from(schema.componentProperties)
            .where(
                and(
                    inArray(schema.componentProperties.componentId, componentIds),
                    inArray(schema.componentProperties.name, SYFT_PROP_NAMES)
                )
            );

        const propsMap = new Map<string, { packageType: string | null; packageLanguage: string | null; location: string | null }>();
        for (const prop of propsResult) {
            if (!propsMap.has(prop.componentId)) {
                propsMap.set(prop.componentId, { packageType: null, packageLanguage: null, location: null });
            }
            const entry = propsMap.get(prop.componentId)!;
            if (prop.name === "syft:package:type") entry.packageType = prop.value;
            else if (prop.name === "syft:package:language") entry.packageLanguage = prop.value;
            else if (prop.name === "syft:location:0:path") entry.location = prop.value;
        }

        const licenseMap = new Map<string, string>();
        for (const lic of licensesResult) {
            if (!licenseMap.has(lic.componentId)) {
                licenseMap.set(lic.componentId, lic.spdxId ?? lic.expression ?? lic.name ?? "Unknown");
            }
        }

        const vulnMap = new Map<string, { id: string; severity: string | null }[]>();
        for (const vuln of vulnsResult) {
            if (!vulnMap.has(vuln.componentId)) {
                vulnMap.set(vuln.componentId, []);
            }
            vulnMap.get(vuln.componentId)!.push({
                id: vuln.vulnId,
                severity: vuln.severityLevel,
            });
        }

        return components.map(comp => {
            const props = propsMap.get(comp.id);
            return {
                ...comp,
                license: licenseMap.get(comp.id) ?? null,
                vulnerabilities: vulnMap.get(comp.id) ?? [],
                packageType: props?.packageType ?? null,
                packageLanguage: props?.packageLanguage ?? null,
                location: props?.location ?? null,
            };
        });
    },

    /**
     * Find all library components for a specific SBOM with license, vulnerability, and property info.
     */
    async findBySbomIdWithDetails(sbomId: string): Promise<ComponentWithDetails[]> {
        const components = await db
            .select()
            .from(schema.components)
            .where(
                and(
                    eq(schema.components.sbomId, sbomId),
                    eq(schema.components.type, "library")
                )
            );

        if (components.length === 0) {
            return [];
        }

        const componentIds = components.map(c => c.id);

        const SYFT_PROP_NAMES = [
            "syft:package:type",
            "syft:package:language",
            "syft:location:0:path",
        ];

        const [licensesResult, vulnsResult, propsResult] = await Promise.all([
            db
                .select({
                    componentId: schema.componentLicenses.componentId,
                    spdxId: schema.licenses.spdxId,
                    name: schema.licenses.name,
                    expression: schema.licenses.expression,
                })
                .from(schema.componentLicenses)
                .innerJoin(
                    schema.licenses,
                    eq(schema.componentLicenses.licenseId, schema.licenses.id)
                )
                .where(inArray(schema.componentLicenses.componentId, componentIds)),
            findingsForComponents(componentIds),
            db
                .select({
                    componentId: schema.componentProperties.componentId,
                    name: schema.componentProperties.name,
                    value: schema.componentProperties.value,
                })
                .from(schema.componentProperties)
                .where(
                    and(
                        inArray(schema.componentProperties.componentId, componentIds),
                        inArray(schema.componentProperties.name, SYFT_PROP_NAMES)
                    )
                ),
        ]);

        const propsMap = new Map<string, { packageType: string | null; packageLanguage: string | null; location: string | null }>();
        for (const prop of propsResult) {
            if (!propsMap.has(prop.componentId)) {
                propsMap.set(prop.componentId, { packageType: null, packageLanguage: null, location: null });
            }
            const entry = propsMap.get(prop.componentId)!;
            if (prop.name === "syft:package:type") entry.packageType = prop.value;
            else if (prop.name === "syft:package:language") entry.packageLanguage = prop.value;
            else if (prop.name === "syft:location:0:path") entry.location = prop.value;
        }

        const licenseMap = new Map<string, string>();
        for (const lic of licensesResult) {
            if (!licenseMap.has(lic.componentId)) {
                licenseMap.set(lic.componentId, lic.spdxId ?? lic.expression ?? lic.name ?? "Unknown");
            }
        }

        const vulnMap = new Map<string, { id: string; severity: string | null }[]>();
        for (const vuln of vulnsResult) {
            if (!vulnMap.has(vuln.componentId)) {
                vulnMap.set(vuln.componentId, []);
            }
            vulnMap.get(vuln.componentId)!.push({
                id: vuln.vulnId,
                severity: vuln.severityLevel,
            });
        }

        return components.map(comp => {
            const props = propsMap.get(comp.id);
            return {
                ...comp,
                license: licenseMap.get(comp.id) ?? null,
                vulnerabilities: vulnMap.get(comp.id) ?? [],
                packageType: props?.packageType ?? null,
                packageLanguage: props?.packageLanguage ?? null,
                location: props?.location ?? null,
            };
        });
    },

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
        } = {}
    ): Promise<ClusterPackagesPage> {
        const limit = Math.min(options.limit ?? 50, 200);
        const offset = options.offset ?? 0;
        const search = options.search?.trim();
        const where = and(
            packagesWhere(scope, search, options.control, options.ecosystem),
            hasMatchingFinding(scope, options.control, options.severities, options.kev)
        );

        const [rows, total] = await Promise.all([
            fetchPackagePage(where, limit, offset),
            countPackageGroups(where),
        ]);
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
        options: { name: string; version: string | null; control?: PackageControlFilter | undefined }
    ): Promise<PackageOccurrences> {
        const where = and(
            "clusterId" in scope
                ? eq(schema.images.clusterId, scope.clusterId)
                : eq(schema.images.orgId, scope.orgId),
            // The list's filter, so a count opens to the things it counted.
            controlledBy(options.control),
            eq(schema.components.type, "library"),
            eq(schema.components.name, options.name),
            options.version === null
                ? isNull(schema.components.version)
                : eq(schema.components.version, options.version)
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
                .orderBy(
                    asc(schema.clusters.name),
                    asc(schema.images.repository),
                    asc(schema.images.digest)
                ),
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
                .innerJoin(
                    schema.workloadContainers,
                    eq(schema.workloadContainers.imageId, schema.images.id)
                )
                .innerJoin(
                    schema.workloads,
                    eq(schema.workloads.id, schema.workloadContainers.workloadId)
                )
                .innerJoin(
                    schema.namespaces,
                    eq(schema.namespaces.id, schema.workloads.namespaceId)
                )
                .where(where)
                .groupBy(
                    schema.workloads.id,
                    schema.workloads.name,
                    schema.workloads.kind,
                    schema.namespaces.name,
                    schema.clusters.id,
                    schema.clusters.name
                )
                .orderBy(
                    asc(schema.clusters.name),
                    asc(schema.namespaces.name),
                    asc(schema.workloads.name)
                ),
        ]);

        return { images: imageRows, workloads: workloadRows };
    },

    /**
     * Lean version of findBySbomIdWithDetails for endpoints that only need component
     * metadata + syft properties (no licenses, no vulnerability counts).
     * Two queries instead of four; skips large columns.
     */
    async findLeanMetaBySbomId(sbomId: string): Promise<{
        id: string;
        name: string;
        version: string | null;
        isDirect: boolean | null;
        packageType: string | null;
        location: string | null;
    }[]> {
        const components = await db
            .select({
                id: schema.components.id,
                name: schema.components.name,
                version: schema.components.version,
                isDirect: schema.components.isDirect,
            })
            .from(schema.components)
            .where(
                and(
                    eq(schema.components.sbomId, sbomId),
                    eq(schema.components.type, "library")
                )
            );

        if (components.length === 0) return [];

        const componentIds = components.map(c => c.id);
        const propsResult = await db
            .select({
                componentId: schema.componentProperties.componentId,
                name: schema.componentProperties.name,
                value: schema.componentProperties.value,
            })
            .from(schema.componentProperties)
            .where(
                and(
                    inArray(schema.componentProperties.componentId, componentIds),
                    inArray(schema.componentProperties.name, ["syft:package:type", "syft:location:0:path"])
                )
            );

        const propsMap = new Map<string, { packageType: string | null; location: string | null }>();
        for (const prop of propsResult) {
            if (!propsMap.has(prop.componentId)) {
                propsMap.set(prop.componentId, { packageType: null, location: null });
            }
            const entry = propsMap.get(prop.componentId)!;
            if (prop.name === "syft:package:type") entry.packageType = prop.value;
            else if (prop.name === "syft:location:0:path") entry.location = prop.value;
        }

        return components.map(c => {
            const props = propsMap.get(c.id);
            return {
                ...c,
                packageType: props?.packageType ?? null,
                location: props?.location ?? null,
            };
        });
    },

    /**
     * Every component of every stored SBOM. Used for periodic vulnerability
     * re-syncing.
     *
     * "Current" has no meaning here any more — one SBOM per image, and an image
     * is immutable — so this is simply every component, deduplicated by image
     * rather than repeated once per workload that runs it.
     */
    async findAllFromCurrentSboms(): Promise<Component[]> {
        return db
            .select({
                id: schema.components.id,
                sbomId: schema.components.sbomId,
                purl: schema.components.purl,
                name: schema.components.name,
                version: schema.components.version,
                type: schema.components.type,
                groupName: schema.components.groupName,
                publisher: schema.components.publisher,
                author: schema.components.author,
                description: schema.components.description,
                cpe: schema.components.cpe,
                bomRef: schema.components.bomRef,
                isDirect: schema.components.isDirect,
                scope: schema.components.scope,
                tier: schema.components.tier,
                layerIndex: schema.components.layerIndex,
                fromBase: schema.components.fromBase,
                tierVersion: schema.components.tierVersion,
                createdAt: schema.components.createdAt,
                updatedAt: schema.components.updatedAt,
            })
            .from(schema.components)
            .innerJoin(schema.sboms, eq(schema.components.sbomId, schema.sboms.id));
    },

    /**
     * Batch insert components. No deduplication -- each SBOM gets its own component rows.
     */
    async batchCreate(components: NewComponent[], tx?: Transaction): Promise<Component[]> {
        if (components.length === 0) return [];

        const q = tx ?? db;
        const results: Component[] = [];
        for (let i = 0; i < components.length; i += BATCH_CHUNK_SIZE) {
            const chunk = components.slice(i, i + BATCH_CHUNK_SIZE);
            const created = await q
                .insert(schema.components)
                .values(chunk)
                .returning();
            results.push(...created);
        }
        return results;
    },

    // Hash operations
    async batchAddAllHashes(hashes: NewComponentHash[], tx?: Transaction): Promise<void> {
        if (hashes.length === 0) return;

        const q = tx ?? db;
        for (let i = 0; i < hashes.length; i += BATCH_CHUNK_SIZE) {
            const chunk = hashes.slice(i, i + BATCH_CHUNK_SIZE);
            await q
                .insert(schema.componentHashes)
                .values(chunk)
                .onConflictDoNothing();
        }
    },

    // External reference operations
    async batchAddAllExternalRefs(refs: NewComponentExternalRef[], tx?: Transaction): Promise<void> {
        if (refs.length === 0) return;

        const q = tx ?? db;
        for (let i = 0; i < refs.length; i += BATCH_CHUNK_SIZE) {
            const chunk = refs.slice(i, i + BATCH_CHUNK_SIZE);
            await q
                .insert(schema.componentExternalRefs)
                .values(chunk);
        }
    },

    // Property operations
    async batchAddComponentProperties(properties: NewComponentProperty[], tx?: Transaction): Promise<void> {
        if (properties.length === 0) return;

        const q = tx ?? db;
        for (let i = 0; i < properties.length; i += BATCH_CHUNK_SIZE) {
            const chunk = properties.slice(i, i + BATCH_CHUNK_SIZE);
            await q
                .insert(schema.componentProperties)
                .values(chunk);
        }
    },

    /**
     * Batch find-or-create licenses. Deduplicates by spdxId/name/expression.
     */
    async batchFindOrCreateLicenses(
        licenses: NewLicense[],
        tx?: Transaction
    ): Promise<Map<string, License>> {
        if (licenses.length === 0) return new Map();

        const q = tx ?? db;
        const result = new Map<string, License>();

        const unique = new Map<string, NewLicense>();
        for (const lic of licenses) {
            const key = lic.spdxId ?? lic.expression ?? lic.name ?? "";
            if (key && !unique.has(key)) {
                unique.set(key, lic);
            }
        }

        const spdxIds = [...unique.values()]
            .filter(l => l.spdxId)
            .map(l => l.spdxId!);

        if (spdxIds.length > 0) {
            const existing = await q
                .select()
                .from(schema.licenses)
                .where(inArray(schema.licenses.spdxId, spdxIds));

            for (const lic of existing) {
                if (lic.spdxId) {
                    result.set(lic.spdxId, lic);
                    unique.delete(lic.spdxId);
                }
            }
        }

        const toCreate = [...unique.entries()];
        if (toCreate.length > 0) {
            for (let i = 0; i < toCreate.length; i += BATCH_CHUNK_SIZE) {
                const chunk = toCreate.slice(i, i + BATCH_CHUNK_SIZE);
                const created = await q
                    .insert(schema.licenses)
                    .values(chunk.map(([, lic]) => lic))
                    .returning();

                for (let j = 0; j < created.length; j++) {
                    const key = chunk[j]![0];
                    result.set(key, created[j]!);
                }
            }
        }

        return result;
    },

    /**
     * Batch link components to licenses.
     */
    async batchLinkComponentLicenses(
        links: Array<{ componentId: string; licenseId: string }>,
        tx?: Transaction
    ): Promise<void> {
        if (links.length === 0) return;

        const q = tx ?? db;
        for (let i = 0; i < links.length; i += BATCH_CHUNK_SIZE) {
            const chunk = links.slice(i, i + BATCH_CHUNK_SIZE);
            await q
                .insert(schema.componentLicenses)
                .values(chunk)
                .onConflictDoNothing();
        }
    },
};
