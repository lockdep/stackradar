import { and, asc, desc, eq, ilike, or, sql, countDistinct } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { packagesWhere } from "./component.repository.js";
import { vulnerabilityRepository } from "./vulnerability.repository.js";
import { lensBucket, type TierLens } from "../db/finding-tier.js";

/**
 * The global search behind `GET /api/search` — one org-scoped request that
 * returns the top matches for a term across the five things a person types
 * into the product, with the groups ordered by what the term looks like.
 *
 * Every group already had a query somewhere in the server, each behind a
 * different route with a different scope parameter. The palette needs one
 * round-trip per keystroke and one place that decides the ranking, so the
 * client stays a renderer. The server returns ids, never client URLs.
 *
 * See docs/global-search-plan-2026-09-12.md item 1.
 */

export type SearchIntent = "advisory" | "image" | "name";
export type SearchKind = "vulnerability" | "package" | "image" | "container" | "cluster";

export type SearchVulnerabilityItem = {
    vulnId: string;
    identity: string;
    severity: "critical" | "high" | "medium" | "low" | null;
    /** KEV-listed, or EPSS at or above the notable line — the list's sort key. */
    exploited: boolean;
    /** On CISA KEV specifically — what earns the KEV badge; `exploited` alone may be EPSS. */
    kev: boolean;
    imageCount: number;
    /** Distinct workloads (controllers) running an affected image. */
    workloadCount: number;
    /** Distinct running containers on an affected image — what the UI shows. */
    containerCount: number;
};

export type SearchPackageItem = {
    name: string;
    type: "library";
    purlType: string | null;
    versionCount: number;
    imageCount: number;
    workloadCount: number;
    containerCount: number;
    /**
     * Every occurrence of the name is in the tier lens's base bucket (a
     * distro package or runtime tooling) — the palette's small "base" tag.
     */
    base: boolean;
};

export type SearchImageItem = {
    id: string;
    registry: string | null;
    repository: string | null;
    tag: string | null;
    clusterId: string;
    clusterName: string;
    lastSeenAt: Date;
};

export type SearchContainerItem = {
    workloadId: string;
    containerId: string;
    name: string;
    kind: string | null;
    namespace: string;
    clusterId: string;
    clusterName: string;
};

export type SearchClusterItem = { id: string; name: string };

export type SearchGroup =
    | { kind: "vulnerability"; items: SearchVulnerabilityItem[] }
    | { kind: "package"; items: SearchPackageItem[] }
    | { kind: "image"; items: SearchImageItem[] }
    | { kind: "container"; items: SearchContainerItem[] }
    | { kind: "cluster"; items: SearchClusterItem[] };

export type SearchResult = {
    query: string;
    intent: SearchIntent;
    directHit: { kind: "vulnerability"; vulnId: string } | null;
    /** Ranked by intent; every kind is always present, possibly empty. */
    groups: SearchGroup[];
};

/**
 * Advisory ids have a fixed shape: a short alphabetic prefix, a dash, then
 * a segment that is a year or a four-character code followed by another
 * separator — `CVE-2021-44228`, `GHSA-jfh8-c2jp-5v3q`, `USN-6412-1`,
 * `RUSTSEC-2021-0139`, `RHSA-2024:3351`, `GO-2024-2654`. Distro mirrors
 * put a word between prefix and year (`UBUNTU-CVE-2022-3296`,
 * `SUSE-SU-2026:23213-1`, `DRUPAL-CORE-2018-002`), hence the optional
 * middle segment. Checked against `SELECT DISTINCT id_prefix FROM
 * vulnerabilities` on the dev mirror on 2026-09-12; the longest prefix is
 * `CLEANSTART` (10).
 *
 * The four-character rule is what keeps `kube-state-metrics` and
 * `cert-manager-webhook` out: their second segment is followed by a letter,
 * not a separator. A false positive only reorders the groups and adds one
 * indexed lookup, so the second pattern accepts the purely numeric tails
 * (`AZL-86814`, `DLA-74-1`) at the cost of also accepting `app-42`.
 */
const ADVISORY_ID_RE = /^[a-z]{2,10}-(?:[a-z]+-)?[a-z0-9]{4}[-:]/i;
const ADVISORY_NUMERIC_TAIL_RE = /^[a-z]{2,10}-\d+(?:-\d+)?$/i;

/** What a trimmed search term looks like — decides group order and the direct hit. */
export function classifySearchTerm(q: string): SearchIntent {
    const term = q.trim();
    if (ADVISORY_ID_RE.test(term) || ADVISORY_NUMERIC_TAIL_RE.test(term)) return "advisory";
    if (term.includes("/") || term.includes(":") || term.includes("@sha256")) return "image";
    return "name";
}

/**
 * The order groups come back in, per intent. Every group still runs under
 * every intent: `nginx:1.25` reads as an image but is also a fine package
 * search, and a CVE id is also a package-name search for anything named
 * after it.
 */
const GROUP_ORDER: Record<SearchIntent, SearchKind[]> = {
    advisory: ["vulnerability", "package", "image", "container", "cluster"],
    image: ["image", "container", "package", "vulnerability", "cluster"],
    name: ["package", "container", "image", "vulnerability", "cluster"],
};

/** The cluster group is a short list — an org has few clusters, and the name match is exact-ish. */
const CLUSTER_GROUP_LIMIT = 3;

/** `pkg:npm/lodash@4.17.21` → `npm`; anything else → null. */
function purlType(purl: string | null): string | null {
    if (!purl) return null;
    const m = /^pkg:([^/]+)\//.exec(purl);
    return m?.[1] ?? null;
}

async function searchVulnerabilities(
    orgId: string,
    q: string,
    limit: number,
    tiers?: TierLens
): Promise<SearchVulnerabilityItem[]> {
    const page = await vulnerabilityRepository.findVulnerabilities(
        { orgId },
        { search: q, limit, offset: 0, countTotals: false, tiers }
    );
    return page.vulnerabilities.map((v) => ({
        vulnId: v.vulnId,
        identity: v.identity,
        severity: v.severity,
        exploited: v.exploited,
        kev: v.kevListedAt !== null,
        imageCount: v.imageCount,
        workloadCount: v.workloadCount,
        containerCount: v.containerCount,
    }));
}

/**
 * One row per package *name* — the Packages page groups by `(name, version)`,
 * which the palette folds one level further, so the same predicate
 * (`packagesWhere`) with a coarser GROUP BY.
 */
async function searchPackages(
    orgId: string,
    q: string,
    limit: number,
    tiers?: TierLens
): Promise<SearchPackageItem[]> {
    /* A package has no exploited override of its own — that is a property of
       a finding — so under a lens this is the plain bucket filter. */
    const lensWhere = tiers
        ? sql`${lensBucket} IN (${sql.join(tiers.map((b) => sql`${b}`), sql`, `)})`
        : undefined;
    const rows = await db
        .select({
            name: schema.components.name,
            purl: sql<string | null>`min(${schema.components.purl})`,
            versionCount: countDistinct(sql`coalesce(${schema.components.version}, '')`),
            imageCount: countDistinct(schema.images.id),
            // LEFT JOIN, as the Packages page: an image uploaded before any
            // inventory references it still has real packages.
            workloadCount: countDistinct(schema.workloadContainers.workloadId),
            containerCount: countDistinct(schema.workloadContainers.id),
            base: sql<boolean>`bool_and(${lensBucket} = 'base')`,
        })
        .from(schema.components)
        .innerJoin(schema.sboms, eq(schema.components.sbomId, schema.sboms.id))
        .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
        .leftJoin(schema.workloadContainers, eq(schema.workloadContainers.imageId, schema.images.id))
        .where(and(packagesWhere({ orgId }, q), lensWhere))
        .groupBy(schema.components.name)
        /* Names that start with the term before names that merely contain
           it — `log4j` should list `log4j-core` above `apache-log4j-extras`. */
        .orderBy(sql`(${schema.components.name} ILIKE ${`${q}%`}) DESC`, asc(schema.components.name))
        .limit(limit);

    return rows.map((r) => ({
        name: r.name,
        type: "library" as const,
        purlType: purlType(r.purl),
        versionCount: Number(r.versionCount),
        imageCount: Number(r.imageCount),
        workloadCount: Number(r.workloadCount),
        containerCount: Number(r.containerCount),
        base: r.base === true,
    }));
}

/**
 * Images the org owns whose repository, or the ref a container pulled them
 * by, contains the term. The ref carries registry, repository and tag in one
 * string, which is what a user pastes from `kubectl describe`. The tag is
 * the most recently seen container's — deployment context lives on
 * `workload_containers`, never on `images` (ADR 0004).
 */
async function searchImages(orgId: string, q: string, limit: number): Promise<SearchImageItem[]> {
    const pattern = `%${q}%`;
    const wc = schema.workloadContainers;
    const refMatches = sql`EXISTS (SELECT 1 FROM ${wc} WHERE ${wc.imageId} = ${schema.images.id} AND ${wc.imageRef} ILIKE ${pattern})`;
    const latestTag = sql<string | null>`(SELECT ${wc.imageTag} FROM ${wc} WHERE ${wc.imageId} = ${schema.images.id} ORDER BY ${wc.lastSeenAt} DESC LIMIT 1)`;

    const rows = await db
        .select({
            id: schema.images.id,
            registry: schema.images.registry,
            repository: schema.images.repository,
            tag: latestTag,
            clusterId: schema.clusters.id,
            clusterName: schema.clusters.name,
            lastSeenAt: schema.images.lastSeenAt,
        })
        .from(schema.images)
        .innerJoin(schema.clusters, eq(schema.clusters.id, schema.images.clusterId))
        .where(
            and(
                eq(schema.images.orgId, orgId),
                or(ilike(schema.images.repository, pattern), refMatches)
            )
        )
        .orderBy(desc(schema.images.lastSeenAt), asc(schema.images.repository))
        .limit(limit);

    return rows;
}

/**
 * Workloads whose name or namespace contains the term, each with the
 * container the client links to — the first by name, since the workload
 * page's unit is a `workload_containers` row.
 */
async function searchContainers(orgId: string, q: string, limit: number): Promise<SearchContainerItem[]> {
    const pattern = `%${q}%`;
    const wc = schema.workloadContainers;
    const firstContainer = sql<string | null>`(SELECT ${wc.id} FROM ${wc} WHERE ${wc.workloadId} = ${schema.workloads.id} ORDER BY ${wc.name} ASC LIMIT 1)`;

    const rows = await db
        .select({
            workloadId: schema.workloads.id,
            containerId: firstContainer,
            name: schema.workloads.name,
            kind: schema.workloads.kind,
            namespace: schema.namespaces.name,
            clusterId: schema.clusters.id,
            clusterName: schema.clusters.name,
        })
        .from(schema.workloads)
        .innerJoin(schema.namespaces, eq(schema.namespaces.id, schema.workloads.namespaceId))
        .innerJoin(schema.clusters, eq(schema.clusters.id, schema.namespaces.clusterId))
        .where(
            and(
                eq(schema.workloads.orgId, orgId),
                or(ilike(schema.workloads.name, pattern), ilike(schema.namespaces.name, pattern))
            )
        )
        .orderBy(
            /* Name hits above namespace-only hits, then the most recently seen. */
            sql`(${schema.workloads.name} ILIKE ${pattern}) DESC`,
            desc(schema.workloads.lastSeenAt),
            asc(schema.workloads.name)
        )
        .limit(limit);

    /* A workload the inventory reported with no container is not a page the
       client can open; the write path never produces one, but the join is a
       subquery, so refuse rather than emit a null id. */
    return rows.filter((r): r is typeof r & { containerId: string } => r.containerId !== null);
}

/** The org's customer clusters — `system` is the platform scan's, never a customer's. */
async function searchClusters(orgId: string, q: string, limit: number): Promise<SearchClusterItem[]> {
    return db
        .select({ id: schema.clusters.id, name: schema.clusters.name })
        .from(schema.clusters)
        .where(
            and(
                eq(schema.clusters.orgId, orgId),
                eq(schema.clusters.system, false),
                ilike(schema.clusters.name, `%${q}%`)
            )
        )
        .orderBy(asc(schema.clusters.name))
        .limit(Math.min(limit, CLUSTER_GROUP_LIMIT));
}

/**
 * Under `advisory` intent only: the same pair of calls the vulnerability
 * page's `overview` makes, so a hit here is guaranteed to render there.
 */
async function directHitFor(orgId: string, q: string): Promise<SearchResult["directHit"]> {
    const identities = await vulnerabilityRepository.identitiesForVulnId(q);
    const page = await vulnerabilityRepository.findVulnerabilities(
        { orgId },
        { identities, limit: 1, countTotals: false }
    );
    const row = page.vulnerabilities[0];
    return row ? { kind: "vulnerability", vulnId: row.vulnId } : null;
}

/** Wraps each group's promise so the controller can time them individually. */
export type SearchTimer = <T>(label: string, p: Promise<T>) => Promise<T>;

export const searchRepository = {
    classifySearchTerm,

    /**
     * The five groups and the direct hit, in parallel. `time` receives each
     * group's promise so per-group latency lands in the logs — the caller
     * supplies it with the org and the term *length* as context, never the
     * term itself, which may be a customer's internal name.
     */
    async search(
        orgId: string,
        q: string,
        limit: number,
        time: SearchTimer = (_label, p) => p,
        tiers?: TierLens
    ): Promise<SearchResult> {
        const query = q.trim();
        const intent = classifySearchTerm(query);

        const [vulnerability, pkg, image, container, cluster, directHit] = await Promise.all([
            time("vulnerabilities", searchVulnerabilities(orgId, query, limit, tiers)),
            time("packages", searchPackages(orgId, query, limit, tiers)),
            time("images", searchImages(orgId, query, limit)),
            time("containers", searchContainers(orgId, query, limit)),
            time("clusters", searchClusters(orgId, query, limit)),
            intent === "advisory" ? time("directHit", directHitFor(orgId, query)) : Promise.resolve(null),
        ]);

        const byKind: Record<SearchKind, SearchGroup> = {
            vulnerability: { kind: "vulnerability", items: vulnerability },
            package: { kind: "package", items: pkg },
            image: { kind: "image", items: image },
            container: { kind: "container", items: container },
            cluster: { kind: "cluster", items: cluster },
        };

        return {
            query,
            intent,
            directHit,
            groups: GROUP_ORDER[intent].map((kind) => byKind[kind]),
        };
    },
};
