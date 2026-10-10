/**
 * What counts as a finding.
 *
 * Three surfaces report "how many vulnerabilities does this workload have" —
 * the cluster dashboard's severity cards and its top-risky table, the metrics
 * snapshots behind the trend charts, and the workload's own Vulnerabilities
 * tab. Each of them used to answer it with its own query, and the three
 * queries answered three different questions. On one real workload the
 * dashboard said 195 criticals, the trend chart counted 17, and the detail
 * page listed 14. Every one of those numbers was arrived at honestly and none
 * of them was the number the user wanted.
 *
 * This module is the single answer. A **finding** is one thing the user has to
 * act on, and it is defined by five rules:
 *
 *   1. **It is on an image somebody is running.** Under
 *      [ADR 0004](../../../docs/adr/0004-image-as-the-unit-of-identity.md) an
 *      SBOM belongs to an image digest and there is exactly one per image, so
 *      the old `is_current` filter has nothing left to exclude — a digest's
 *      component list cannot be superseded. What replaces it is *scope*: an
 *      image with no `workload_containers` row pointing at it is not running
 *      anywhere, and `deployedImages` below is how a caller says so.
 *
 *   2. **The matcher positively placed the version inside an affected range**
 *      (`match_confidence` of `exact` or `fuzzy`). An `unconfirmed` row means
 *      the *package* matched but the version question could not be answered —
 *      the identity match is real and worth storing, but reporting it as a
 *      vulnerability states something the matcher never concluded. This is the
 *      rule the dashboard was missing: 180 of those 195 criticals were
 *      unconfirmed rows, six advisories fanned out across thirty Go modules
 *      apiece.
 *
 *   3. **Advisories describing the same vulnerability count once.** A CVE that
 *      reaches the mirror as a GHSA *and* a GO- record is one thing to fix, not
 *      two. `collapseAliases` in `lib/vulnerability-aliases.ts` is that rule for
 *      the read path; `findingIdentity` below reads the same rule's stored
 *      answer, `vulnerabilities.finding_identity`, and
 *      `tests/integration/findings/finding-identity.test.ts` holds the stored
 *      column, the TypeScript rule and the original SQL derivation together.
 *
 *   4. **A distro binary package is not the unit of fix.** `libssl3t64` and
 *      `openssl`, `libc6` and `libc-bin`, the seven `util-linux` binaries: each
 *      set is one Debian *source* package, rebuilt together, upgraded by one
 *      `apt upgrade`. Counting a CVE once per binary made an image osv-scanner
 *      reports at 17 criticals report 24 here, and 305 findings against its
 *      155. So for the distro PURL types (`deb`, `rpm`, `apk`) the package half
 *      of the collapse key is the source package — `packageCollapseKey` below
 *      — and `packageName` names it. Language ecosystems keep the component:
 *      the same CVE on two Go modules really is two things to fix.
 *
 *   5. **A fix advisory adds nothing to the CVEs it fixes.** A `USN-`, `DSA-`
 *      or `RHSA-` record names the per-CVE records it closes under OSV
 *      `related`, carries no CVSS, and stands alone under rule 3 because it
 *      names several CVEs. Left in, it was one extra "unscored" finding per
 *      notice per package — 30 of 78 on that image. `notCoveredByCveFinding`
 *      below drops a stand-alone record that cross-references (or is
 *      cross-referenced by) a counted CVE-identity finding on the same
 *      component. One direction only: a CVE finding never folds into a notice,
 *      so a DSA covering thirty CVEs still leaves thirty findings.
 *
 * `collapseAliases` in `lib/vulnerability-aliases.ts` is rules 3–5 for the
 * TypeScript read path the workload page uses; this module is the same rules
 * for every SQL surface. They must agree, and
 * `tests/integration/findings/finding-definition.test.ts` checks that they do.
 *
 * Note what is *not* here: no re-derivation of the verdict. The read path used
 * to re-decide rule 2 for itself by joining `vulnerability_affected_packages`
 * on package *name* and re-running the range check. That join asks a weaker
 * question than the matcher did — the matcher looks up by canonical key, so it
 * finds `github.com/grafana/pyroscope` for a component the SBOM named
 * `github.com/grafana/pyroscope/api`, and the name join does not. It silently
 * dropped fourteen confirmed findings on that same workload, one of them a
 * critical. The matcher's verdict is the verdict; the affected-package join
 * survives only to decorate a finding with the range it fell into.
 *
 * **Cost.** The identity used to be derived per finding row — a correlated
 * alias scan that was about half the time of an organisation-wide count (130ms
 * over 7,600 findings on a development dataset), growing linearly with
 * findings. It is a pure function of `(vuln_id, aliases, upstream)`, all fields
 * of the advisory, so it is now *stored*: `vulnerabilities.finding_identity`, written
 * at ingest by the OSV sync (the only writer of advisory rows) and rewritten
 * whenever the advisory changes — see the column comment in
 * `schema/vulnerabilities.ts`. This module reads the column; the derivation
 * survives only in TypeScript (`findingIdentityOf`) and as the oracle in the
 * drift-guard test.
 */

import { and, count, eq, exists, gt, inArray, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Transaction } from "./index.js";
import { components } from "./schema/components.js";
import { images } from "./schema/images.js";
import { namespaces } from "./schema/namespaces.js";
import { sboms } from "./schema/sboms.js";
import { workloadContainers } from "./schema/workload-containers.js";
import { workloads } from "./schema/workloads.js";
import { componentVulnerabilities, vulnerabilities } from "./schema/vulnerabilities.js";
import { DISTRO_PURL_TYPES, type MatchConfidence } from "../matching/index.js";
import { lensBucket } from "./finding-tier.js";

/**
 * The confidences that mean "the version is in an affected range".
 *
 * Spelled as an exhaustive map rather than `<> 'unconfirmed'` so that adding a
 * fourth confidence is a type error here, forcing a decision about whether it
 * counts, rather than being silently swept into one side of an inequality.
 */
const COUNTS_AS_FINDING: Record<MatchConfidence, boolean> = {
    exact: true,
    fuzzy: true,
    unconfirmed: false,
};

/**
 * Rule 2, as a function over one matcher verdict — for the read path that
 * holds `VulnMatch` objects rather than rows (`services/match.service.ts`).
 * The same map as {@link isCountedFinding}; there is no second definition.
 */
export function countsAsFinding(confidence: MatchConfidence): boolean {
    return COUNTS_AS_FINDING[confidence];
}

const COUNTED_CONFIDENCES: MatchConfidence[] =
    (Object.keys(COUNTS_AS_FINDING) as MatchConfidence[]).filter((c) => COUNTS_AS_FINDING[c]);

/**
 * Rule 2, as a predicate. Add it to every query that counts or lists findings.
 *
 * `match_confidence` is nullable — the column predates the matcher that always
 * writes it — and a null is not one of the counted values, so such a row is
 * excluded. That is the honest reading: a row that never recorded a verdict is
 * not a row that recorded a positive one.
 */
export function isCountedFinding(): SQL {
    return inArray(componentVulnerabilities.matchConfidence, COUNTED_CONFIDENCES);
}

/**
 * Rule 3, as an expression: the identity two advisories must share to be one
 * finding.
 *
 * A column read. The rule itself — a record that *is* a CVE is its own
 * identity; a record naming exactly one CVE among its aliases takes that
 * CVE's; a record naming no CVE but exactly one GHSA takes `#<that GHSA>`;
 * anything else stands alone under `#<vuln_id>` —
 * lives in `findingIdentityOf` (`lib/vulnerability-aliases.ts`) and is
 * evaluated once per *advisory* when the OSV sync writes the row, not once
 * per finding row when a surface counts. The drift-guard test replays the
 * sync write path against the old SQL derivation to keep the stored value
 * honest.
 *
 * Typed non-null: every sync write supplies the column and the backfill
 * migration covered the rows that predate it, so a NULL here is a bug in a
 * write path, not a state readers accommodate. Every seed of
 * `vulnerabilities` (tests included) must set `findingIdentity` —
 * `findingIdentityOf` is the way to spell it.
 */
export const findingIdentity: SQL<string> = sql<string>`${vulnerabilities.findingIdentity}`;

/** The component's PURL type (`deb`, `golang`, …), lower-cased; null without a PURL. */
const purlType: SQL<string | null> = sql<string | null>`
    lower(substring(${components.purl} from '^pkg:([A-Za-z0-9.+-]+)/'))
`;

const isDistroComponent: SQL<boolean> = sql<boolean>`
    ${purlType} IN (${sql.join([...DISTRO_PURL_TYPES].map((t) => sql`${t}`), sql`, `)})
`;

/**
 * The source package named by the component's own `upstream=` qualifier, or
 * null. `name` or `name@version` for deb and apk; rpm spells it as a source
 * RPM filename (`perl-5.26.3-419.el8.src.rpm`), whose version-release tail is
 * stripped. The SQL twin of `parsePurl(...).upstream.name`.
 */
const purlUpstreamName: SQL<string | null> = sql<string | null>`
    regexp_replace(
        split_part(substring(${components.purl} from '[?&]upstream=([^&#]+)'), '@', 1),
        '-[^-]+-[^-]+\\.src\\.rpm$',
        ''
    )
`;

/**
 * Rule 4: the package a finding is *on*, for naming and for collapsing.
 *
 * For a distro component the source package, in order: `upstream_name` when
 * the matcher reached the advisory through the `upstream=` qualifier; the
 * qualifier itself when it did not (one component can match one advisory
 * directly and another via its source, and both must collapse together); the
 * component's own name when the purl carries no upstream — which for these
 * ecosystems means the binary *is* the source package. Every other component
 * keeps its own name. The same inputs `packageCollapseKeyOf` reads in
 * `lib/vulnerability-aliases.ts`.
 */
export const findingPackageName: SQL<string> = sql<string>`
    CASE WHEN ${isDistroComponent}
         THEN coalesce(
                  ${componentVulnerabilities.upstreamName},
                  nullif(${purlUpstreamName}, ''),
                  ${components.name}
              )
         ELSE ${components.name}
    END
`;

/**
 * Rule 4's half of the collapse key. A distro finding collapses across the
 * binaries of its source package (`src:deb:openssl`, lower-cased and typed so
 * an `apk` and a `deb` `openssl` in one image stay apart); every other finding
 * collapses within its component, as before. Scoped by image by every caller
 * — a source package in two images is two things.
 */
export const packageCollapseKey: SQL<string> = sql<string>`
    CASE WHEN ${isDistroComponent}
         THEN 'src:' || ${purlType} || ':' || lower(${findingPackageName})
         ELSE ${components.id}::text
    END
`;
// `countedFindingRows` spells this same CASE over its stage-1 columns so the
// regex-derived name is computed once per row; this base-table form is the
// rule's definition and the one the drift-guard tests read.

/**
 * `OFFSET 0`, the standard Postgres optimisation fence.
 *
 * A subquery carrying a LIMIT or OFFSET is never pulled up into its parent
 * (`is_simple_subquery`) and its parent's WHERE is never pushed into it, so
 * the planner costs it as a unit. {@link countedFindingRows} uses it twice,
 * and it is why the rollups stopped hash-joining the whole `vulnerabilities`
 * heap — see the comment there. Drizzle types `offset` as a number and drops
 * a literal `0` as falsy; the fragment is truthy and renders verbatim.
 */
const PLANNER_FENCE = sql`0` as unknown as number;

/**
 * A row of {@link countedFindingRows}: one counted `component_vulnerabilities`
 * row with its component, image and advisory, and the rule-4 columns
 * computed once. What {@link collapsedFindings} and `finding-delta.ts`
 * collapse over, each with its own key.
 */
export type CountedFindingRows = ReturnType<typeof countedFindingRows>;

/**
 * Every finding *row* in `scope` before rules 3–5 collapse them: rule 1 is
 * the scope, rule 2 is `isCountedFinding`, and the advisory is joined so the
 * collapse can read its identity and its score. Rule 5 is *not* applied
 * here — it is a predicate the collapsing query adds
 * (`notCoveredByCveFinding`), for the reason below.
 *
 * The shape is a planner argument, not a readability one. Written as one
 * flat join with rule 5 in its WHERE — the shape this was until
 * 2026-09-12 — the planner hashed all 1.9M `vulnerabilities` rows (a 3 GB
 * sequential scan, 128 hash batches, 200 MB of temp) instead of probing the
 * primary key once per finding. Not because the probe was expensive, but
 * because rule 5's `OR NOT EXISTS` subplan is costed at ~32 per joined row:
 * that made the nested loop's estimate (35k rows × 35) look worse than the
 * hash join's, even though the OR short-circuits for the ~97% of rows whose
 * identity is not `#…` and the subplan actually ran a thousand times. 75 s
 * per cluster rollup on the development database, four times per dashboard
 * load, hourly per org in the metrics snapshots (db plan item 3).
 *
 * So the join is fenced off from the filter in two stages:
 *
 *   1. `scoped` — the counted rows in scope, with their component and image
 *      and the rule-4 columns. Scope is applied *first*, on `images`, and
 *      the regex-derived package name is computed once per row rather than
 *      twice (the collapse key used to re-evaluate it inline).
 *   2. the join to `vulnerabilities`, which the planner now costs on its
 *      own — a small fenced input against a 1.9M-row table with a unique
 *      index is a nested loop over `vulnerabilities_pkey`, and the wide
 *      advisory rows the rollup never needed are never read.
 *
 * The collapsing query then filters and sorts the fenced result; rule 5's
 * subplan runs only for stand-alone identities, as before, and against the
 * base tables by `component_id`, so its answer is identical for any scope.
 *
 * `scope` is a predicate over `images`, `sboms` or `components` — the tables
 * stage 1 joins. It must not narrow within a component (a predicate on
 * `component_vulnerabilities` or `vulnerabilities`): rule 5 asks whether
 * *another* row on the same component covers this one, and a scope that
 * hides rows of a component would change that answer. No caller does; the
 * type cannot say so, so this comment does.
 */
export function countedFindingRows(scope: SQL, executor: typeof db | Transaction = db) {
    const scoped = executor
        .select({
            imageId: sboms.imageId,
            componentId: components.id,
            vulnerabilityId: componentVulnerabilities.vulnerabilityId,
            // The cross-image identity of the *package* side of a finding,
            // carried for the remediation surface: `finding_states` keys a
            // suppression on `(type, name, identity)` — the same key
            // `finding-delta.ts` diffs on — so the rollup can join it without
            // a second definition of a finding.
            packageType: components.type,
            purl: components.purl,
            purlType: purlType.as("purl_type"),
            // Aliased away from `package_name`: drizzle references a subquery
            // column by its bare alias, and `finding_states.package_name` is
            // joined against this subquery in `remediation.repository.ts`.
            packageName: findingPackageName.as("finding_package_name"),
            packageVersion: components.version,
            fixedVersion: componentVulnerabilities.fixedVersion,
            // Which `affected[]` entry won the match (`Alpine:v3.23`). Rides
            // along for the same reason as `fixedVersion`: a null fix means
            // two different things — "no fix published yet" versus "the
            // release line is EOL and never will" — and the ecosystem string
            // is the only column that can tell them apart
            // (`lib/eol-releases.ts` makes the call).
            matchedEcosystem: componentVulnerabilities.matchedEcosystem,
            // The component's tier and the lens bucket it puts the finding in
            // (`finding-tier.ts`). Carried, never filtered on, here: a tier
            // predicate in this stage would narrow within a component, which
            // the scope contract above forbids — the lens is applied by the
            // caller, after the collapse. Rule 4 cannot mix buckets: it only
            // collapses distro binaries, and those are all `os`.
            tier: components.tier,
            bucket: lensBucket.as("lens_bucket"),
        })
        .from(componentVulnerabilities)
        .innerJoin(components, eq(componentVulnerabilities.componentId, components.id))
        .innerJoin(sboms, eq(components.sbomId, sboms.id))
        .innerJoin(images, eq(sboms.imageId, images.id))
        .where(and(isCountedFinding(), scope))
        .offset(PLANNER_FENCE)
        .as("scoped");

    return executor
        .select({
            imageId: scoped.imageId,
            componentId: scoped.componentId,
            vulnerabilityId: scoped.vulnerabilityId,
            packageType: scoped.packageType,
            purl: scoped.purl,
            packageName: scoped.packageName,
            packageVersion: scoped.packageVersion,
            // Rule 4's half of the collapse key, from the columns stage 1
            // computed — see `packageCollapseKey` for the rule.
            packageKey: sql<string>`
                CASE WHEN ${scoped.purlType} IN (${sql.join([...DISTRO_PURL_TYPES].map((t) => sql`${t}`), sql`, `)})
                     THEN 'src:' || ${scoped.purlType} || ':' || lower(${scoped.packageName})
                     ELSE ${scoped.componentId}::text
                END
            `.as("package_collapse_key"),
            fixedVersion: scoped.fixedVersion,
            matchedEcosystem: scoped.matchedEcosystem,
            tier: scoped.tier,
            bucket: scoped.bucket,
            vulnId: vulnerabilities.vulnId,
            identity: findingIdentity.as("identity"),
            aliases: vulnerabilities.aliases,
            related: vulnerabilities.related,
            severityLevel: vulnerabilities.severityLevel,
            cvssScore: vulnerabilities.cvssScore,
            // Non-null when the two above were lent by another record of the
            // identity (`osv-sync/severity-fill.ts`) — display provenance only.
            severitySource: vulnerabilities.severitySource,
            // Carried through so `risk.ts` can rank without a second pass over
            // the same joins. `riskScore` is generated on `vulnerabilities`, so
            // this is a column read, not a computation — see `risk-model.ts`.
            riskScore: vulnerabilities.riskScore,
            kevListedAt: vulnerabilities.kevListedAt,
            kevDueDate: vulnerabilities.kevDueDate,
            kevRansomware: vulnerabilities.kevRansomware,
            epssScore: vulnerabilities.epssScore,
            // When the advisory was first made public — OSV's `published`.
            publishedAt: vulnerabilities.publishedAt,
            severityRank: severityRank.as("severity_rank"),
        })
        .from(scoped)
        .innerJoin(vulnerabilities, eq(vulnerabilities.id, scoped.vulnerabilityId))
        .offset(PLANNER_FENCE)
        .as("counted");
}

/**
 * Rule 5, as a predicate over a row of {@link countedFindingRows}.
 *
 * A row passes unless its identity is the stand-alone form (`#…`) *and*
 * another counted row on the same component carries a CVE identity and the
 * two cross-reference each other under `aliases` or `related` — the notice
 * naming the CVE record it fixes, or the CVE record naming its notice. The
 * asymmetry (only the stand-alone side is ever dropped) is what stops this
 * from being a transitive merge.
 *
 * Cost: the `EXISTS` is only reached for stand-alone rows and is a lookup by
 * `component_id`, which is indexed, then by primary key into
 * `vulnerabilities`; the jsonb `?` tests are over lists of a handful of ids.
 * It reads the base tables rather than the fenced rows so that its answer
 * does not depend on the caller's scope.
 */
export function notCoveredByCveFinding(row: CountedFindingRows): SQL {
    const cv2 = alias(componentVulnerabilities, "covering_cv");
    const v2 = alias(vulnerabilities, "covering_v");
    const refsOfRow = sql`(coalesce(${row.aliases}, '[]'::jsonb) || coalesce(${row.related}, '[]'::jsonb))`;
    const refsOfCovering = sql`(coalesce(${v2.aliases}, '[]'::jsonb) || coalesce(${v2.related}, '[]'::jsonb))`;

    return or(
        sql`${row.identity} NOT LIKE '#%'`,
        notExists(
            db
                .select({ one: sql`1` })
                .from(cv2)
                .innerJoin(v2, eq(cv2.vulnerabilityId, v2.id))
                .where(
                    and(
                        eq(cv2.componentId, row.componentId),
                        ne(cv2.vulnerabilityId, row.vulnerabilityId),
                        inArray(cv2.matchConfidence, COUNTED_CONFIDENCES),
                        sql`${v2.findingIdentity} NOT LIKE '#%'`,
                        or(
                            sql`${refsOfRow} ? ${v2.vulnId}`,
                            sql`${refsOfCovering} ? ${row.vulnId}`
                        )
                    )
                )
        )
    )!;
}

/**
 * `critical` > `high` > `medium` > `low` > anything else, matching
 * `SEVERITY_RANK` in `lib/vulnerability-aliases.ts`.
 */
const severityRank: SQL<number> = sql<number>`
    CASE lower(coalesce(${vulnerabilities.severityLevel}, ''))
        WHEN 'critical' THEN 4
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 1
        ELSE 0
    END
`;

/**
 * An image is deployed when a container references it, with a grace window
 * for the upload-before-inventory case: an SBOM can land minutes before the
 * cluster's next inventory report deploys it, and it should count from the
 * start rather than flicker in. One hour is ~12 inventory cycles.
 *
 * An `EXISTS`, not a join, so a finding is never multiplied by the number of
 * places its image runs. A fresh fragment per call rather than a module-level
 * constant: two queries sharing one fragment would share its parameter
 * placeholders.
 *
 * The counterpart this predicate deliberately does not have: *retention*. A
 * digest that stopped running is kept for `IMAGE_GC_RETENTION_DAYS` (the GC's
 * concern, `delete-helpers.ts`) but counts for nothing while it waits —
 * counting retained-but-undeployed images made every rollout ratchet the
 * Components tile and the risk trend up for a month.
 */
function reachableOrNew(): SQL {
    return or(
        exists(
            db.select({ one: sql`1` })
                .from(workloadContainers)
                .where(eq(workloadContainers.imageId, images.id))
        ),
        gt(images.firstSeenAt, sql`now() - interval '1 hour'`)
    )!;
}

/**
 * "This image belongs to `orgId` **and is running somewhere** (or is inside
 * the grace window)", as a predicate over `images`.
 *
 * The single spelling every counting surface scopes with; the indirection is
 * what stops a surface from inventing its own predicate. Surfaces that must
 * see undeployed images — the admin images list with its GC countdown —
 * build their own `FROM images` query on purpose and never come through here.
 */
export function deployedImages(orgId: string): SQL {
    return and(eq(images.orgId, orgId), reachableOrNew())!;
}

/**
 * Cluster-scoped counterpart of {@link deployedImages}. Under ADR 0006 the
 * two partition cleanly: an image belongs to exactly one cluster, so a digest
 * deployed in two clusters is two images, one per cluster.
 */
export function deployedImagesInCluster(clusterId: string): SQL {
    return and(eq(images.clusterId, clusterId), reachableOrNew())!;
}

/**
 * The two scopes every org-or-cluster surface answers in: the caller's whole
 * org, or one cluster of it. Under ADR 0006 they nest cleanly — an org's
 * findings are the union of its clusters', and a digest in two clusters is
 * two images, counted twice in both places.
 */
export type FindingScope = { clusterId: string } | { orgId: string };

/** {@link deployedImages} or {@link deployedImagesInCluster}, by scope. */
export function deployedImagesIn(scope: FindingScope): SQL {
    return "clusterId" in scope
        ? deployedImagesInCluster(scope.clusterId)
        : deployedImages(scope.orgId);
}

/**
 * "This image runs in a namespace called `name`", as a predicate over
 * `images` — the vulnerability lists' `?namespace=`. A *name*, not an id, so
 * one value spans clusters (`default` everywhere is a useful view) exactly as
 * it does on `/containers`. An `EXISTS`, like every scope here: joining
 * `workload_containers` would multiply each finding by the places its image
 * runs. It only ever narrows a `deployedImages*` scope — on its own it says
 * nothing about whose image it is — and it drops the grace-window images,
 * which run nowhere yet.
 */
export function runsInNamespace(name: string): SQL {
    return exists(
        db.select({ one: sql`1` })
            .from(workloadContainers)
            .innerJoin(workloads, eq(workloads.id, workloadContainers.workloadId))
            .innerJoin(namespaces, eq(namespaces.id, workloads.namespaceId))
            .where(and(eq(workloadContainers.imageId, images.id), eq(namespaces.name, name)))
    );
}

/**
 * {@link deployedImagesInCluster} over several clusters at once — the shape
 * the clusters list needs. Same rule, one query.
 */
export function deployedImagesInClusters(clusterIds: string[]): SQL {
    return and(inArray(images.clusterId, clusterIds), reachableOrNew())!;
}

/**
 * Every finding in `scope`, one row each — the subquery the counting surfaces
 * aggregate.
 *
 * `scope` is a predicate over `images`, `sboms` or `components`; the joins
 * those need are already in {@link countedFindingRows}, so a caller writes
 * `deployedImages(orgId)` and nothing else. Callers must not add rules of
 * their own: any predicate that changes *which* findings are counted belongs
 * in this file, or the surfaces drift apart again.
 *
 * Rows come out keyed by `imageId`, not by workload. A finding is a property of
 * an image, and the five workloads running that image share one — attributing
 * it five times is what the old model did and what remediation could not use.
 *
 * `DISTINCT ON (image_id, package key, identity)` is rules 3 and 4 — the same
 * CVE on two Go modules stays two findings, because it is two things to fix;
 * on two binaries of one source package it is one. `packageName` is the
 * source package for a distro finding for the same reason: it is the package
 * the advisory, and its fix version, are written against. That is the name
 * `finding_states` / `issues` key on, so a suppression follows the source
 * package rather than whichever binary happened to survive the collapse.
 *
 * `fixedVersion` rides along so "is there anything to do about this" is a
 * question the counting surfaces can answer without a second definition of a
 * finding. It is `component_vulnerabilities.fixed_version` — the version the
 * *matcher* recorded, off the `affected[]` entry that actually won the match —
 * and never the name-joined guess the read paths fall back to for display
 * (`preferMatchedFixedVersion` in `repositories/vulnerability.repository.ts`
 * explains why those two are not the same answer). It is null both for
 * advisories that state no fix and for rows written before the column existed,
 * so a count over it is a floor: everything it reports is real, and a re-scan
 * can only move the number up.
 */
export function collapsedFindings(scope: SQL) {
    const counted = countedFindingRows(scope);

    return db
        .selectDistinctOn([counted.imageId, counted.packageKey, counted.identity], {
            imageId: counted.imageId,
            componentId: counted.componentId,
            packageType: counted.packageType,
            // The component's PURL: the only thing that says which package
            // manager a bump command is written for (`remediation-commands.ts`).
            purl: counted.purl,
            packageName: counted.packageName,
            packageVersion: counted.packageVersion,
            identity: counted.identity,
            vulnId: counted.vulnId,
            severityLevel: counted.severityLevel,
            fixedVersion: counted.fixedVersion,
            matchedEcosystem: counted.matchedEcosystem,
            tier: counted.tier,
            bucket: counted.bucket,
            // The surviving row's — the worst of the set, by the ordering below.
            cvssScore: counted.cvssScore,
            severitySource: counted.severitySource,
            riskScore: counted.riskScore,
            kevListedAt: counted.kevListedAt,
            kevDueDate: counted.kevDueDate,
            kevRansomware: counted.kevRansomware,
            epssScore: counted.epssScore,
            publishedAt: counted.publishedAt,
        })
        .from(counted)
        .where(notCoveredByCveFinding(counted))
        // How the surviving row of a collapsed set is chosen — the part of it
        // that can change a count. Only the first two tie-breakers can decide
        // the *severity* the collapsed finding reports: once two rows tie on
        // CVSS and on severity rank they have the same severity by definition,
        // so the remaining tie-breakers move which record is displayed and
        // never which bucket it is counted in.
        .orderBy(
            counted.imageId,
            counted.packageKey,
            counted.identity,
            sql`${counted.cvssScore} DESC NULLS LAST`,
            sql`${counted.severityRank} DESC`,
            // A third tie-breaker, and the only one that can decide the *risk*
            // the collapsed finding reports. It almost never fires: both EPSS
            // and KEV are applied through the alias and `upstream` lists, so two advisories
            // collapsing to one CVE carry the same exploitation signal and
            // therefore the same risk once their CVSS has tied. It is here so
            // that when they somehow disagree, the surviving row is the worse
            // one — under-reporting risk is the failure that hides work.
            sql`${counted.riskScore} DESC NULLS LAST`,
            // Rule 4 puts one advisory on several binaries into one set, so
            // the tie-breakers above can genuinely tie. The name settles it —
            // arbitrarily, but the same way on every request.
            counted.packageName,
            counted.componentId
        )
        .as("findings");
}

export const REPORTED_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type SeverityCounts = { critical: number; high: number; medium: number; low: number };

export function emptySeverityCounts(): SeverityCounts {
    return { critical: 0, high: 0, medium: 0, low: 0 };
}

/** Fold one `(severityLevel, count)` row into a `SeverityCounts`. */
export function addSeverity(
    counts: SeverityCounts,
    severityLevel: string | null,
    n: number
): void {
    const severity = (severityLevel ?? "").toLowerCase();
    if (severity === "critical") counts.critical += n;
    else if (severity === "high") counts.high += n;
    else if (severity === "medium") counts.medium += n;
    else if (severity === "low") counts.low += n;
}

/**
 * The severity histogram of every finding in `scope` — the
 * `collapsedFindings → GROUP BY severity → addSeverity` idiom the per-entity
 * surfaces repeat, spelled once. The scope predicate stays the caller's
 * (`deployedImages(orgId)`, `eq(images.id, …)`, …); which rows count and how
 * they bucket stays here, next to the rules that define a finding.
 */
export async function severityCountsForScope(scope: SQL): Promise<SeverityCounts> {
    const findings = collapsedFindings(scope);
    const rows = await db
        .select({ severityLevel: findings.severityLevel, count: count() })
        .from(findings)
        .groupBy(findings.severityLevel);

    const counts = emptySeverityCounts();
    for (const row of rows) addSeverity(counts, row.severityLevel, row.count);
    return counts;
}

/**
 * Per-image severity rows for a set of images — one row per
 * `(imageId, severityLevel)`. The raw grouped form, for a caller that folds
 * its own buckets: the admin images surface keeps an `unknown` bucket the
 * customer-facing surfaces deliberately fold away.
 */
export function severityRowsByImage(imageIds: string[]) {
    const findings = collapsedFindings(inArray(images.id, imageIds));
    return db
        .select({
            imageId: findings.imageId,
            severityLevel: findings.severityLevel,
            count: count(),
        })
        .from(findings)
        .groupBy(findings.imageId, findings.severityLevel);
}

/**
 * {@link severityRowsByImage}, folded into one {@link SeverityCounts} per
 * image. An image with no findings is absent from the map — the caller
 * decides whether that means "clean" or "never scanned" (they are not the
 * same thing, and only the caller has the scan evidence to tell them apart).
 */
export async function severityCountsByImage(
    imageIds: string[]
): Promise<Map<string, SeverityCounts>> {
    const byImage = new Map<string, SeverityCounts>();
    for (const row of await severityRowsByImage(imageIds)) {
        let counts = byImage.get(row.imageId);
        if (!counts) {
            counts = emptySeverityCounts();
            byImage.set(row.imageId, counts);
        }
        addSeverity(counts, row.severityLevel, row.count);
    }
    return byImage;
}
