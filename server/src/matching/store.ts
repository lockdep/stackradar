/**
 * Where candidates come from — the matcher's one dependency on storage.
 *
 * `match.ts` needs to ask a single question: *given these canonical keys, what
 * advisory entries were published against them?* `CandidateStore` is that
 * question and nothing else. The Drizzle implementation lives below it, and the
 * matcher never sees Drizzle, a connection, or a table name.
 *
 * That separation is not ceremony. Every behaviour worth testing in this module
 * — release scoping, dedup, direct-beats-indirect, the upstream version
 * substitution — is a property of `match.ts` over a candidate list, so with a
 * port those tests are plain in-memory unit tests. Only the adapter itself
 * needs a real PostgreSQL, and what it needs testing *for* is narrow: that the
 * SQL returns the right rows and uses the right index.
 */

import { and, eq, gt, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "../db/schema/index.js";
import { vulnerabilityAffectedPackages } from "../db/schema/vulnerabilities.js";
import type { OsvRange } from "../db/schema/vulnerabilities.js";
import { isCurrentGeneration } from "../db/generation.js";
import { parseEcosystem, releaseVersion } from "./ecosystem.js";

/**
 * Loaded on first use rather than imported: `lib/logger` reads `config`,
 * and `config` snapshots `process.env` at import. This module sits under
 * `matching/index.ts`, which test fixtures import statically *before* they
 * set the env their app-under-test needs, so a static logger import here
 * would freeze an empty config into every such test.
 */
async function warn(fields: Record<string, unknown>, message: string): Promise<void> {
    const { createLogger } = await import("../lib/logger.js");
    createLogger("matching:store").warn(fields, message);
}

/**
 * One `affected[]` entry of one advisory, as the matcher needs it.
 *
 * This is a projection of `vulnerability_affected_packages`, not the row: the
 * parsed-PURL columns, severity and the `database_specific` blobs are for
 * debugging and admin views, and pulling them here would cost bandwidth on the
 * hottest query in the system for data no matching rule reads.
 */
export interface Candidate {
    /** Internal UUID of the parent `vulnerabilities` row. */
    vulnerabilityId: string;
    /** The canonical key this entry was indexed under (`identity.ts`). */
    matchKey: string;
    /**
     * Full OSV ecosystem string: `Red Hat:enterprise_linux:8::appstream`.
     *
     * Release scoping reads this in `match.ts` as the second guard. The first
     * is the store's own predicate on `release_version` — the distro version
     * `matching/ecosystem.ts#releaseVersion` reads out of the release, written
     * at ingest — which keeps the 18 unwanted releases of `deb/ubuntu|linux`
     * from leaving the database at all. Both guards apply the same rule
     * (`isCompatibleRelease` / `releaseScope`), and the in-memory one stays
     * for the same reason the withdrawn check is duplicated below: the two
     * fail independently.
     */
    ecosystem: string | null;
    packageName: string;
    versions: string[] | null;
    ranges: OsvRange[] | null;
    fixedVersion: string | null;
    /**
     * Denormalized from `vulnerabilities.withdrawn_at`.
     *
     * The store excludes withdrawn entries and the matcher drops them again.
     * The duplication is intentional — a withdrawn advisory reaching a customer
     * report is a false positive with a paper trail saying the industry already
     * retracted it, and the two guards fail independently: one is a SQL
     * predicate, the other survives any store implementation.
     */
    withdrawn: boolean;
}

/**
 * One key to look up, and how far to scope it.
 *
 * `releases` is `releaseScope(...)` for the pass asking: the advisory
 * release versions this component can be affected by, `[]` for a distro
 * component that named no release (only release-less rows apply), or `null`
 * for no scoping at all. A release-less entry (`release_version IS NULL`) is
 * always returned for a scoped key.
 */
export interface CandidateKey {
    key: string;
    releases: readonly string[] | null;
}

/**
 * The port. One method, because one question.
 *
 * Implementations must return only entries with `withdrawn = false`, must
 * omit keys with no entries from the map rather than mapping them to `[]`,
 * and may narrow a scoped key to entries whose release is one of `releases`
 * or none — never wider than asked, never narrower than that. A key repeated
 * with different scopes is answered with the union.
 */
export interface CandidateStore {
    /**
     * Advisory entries for each of `keys`, grouped by the key that found them.
     *
     * Batched rather than single because the caller always has a set: even one
     * component asks about two keys when it names an upstream, and a scan asks
     * about thousands. A per-key method would make the round-trip count a
     * function of SBOM size.
     */
    findByKeys(keys: readonly CandidateKey[]): Promise<Map<string, Candidate[]>>;
}

/**
 * One lookup per distinct key: the widest scope asked for it. `null` (no
 * scoping) absorbs everything; otherwise the union of the release sets. The
 * matcher's batch spans one SBOM, so in practice every key arrives with one
 * scope and this is a dedup.
 */
export function mergeCandidateKeys(keys: readonly CandidateKey[]): CandidateKey[] {
    const merged = new Map<string, Set<string> | null>();

    for (const { key, releases } of keys) {
        const current = merged.get(key);
        if (current === null) continue;
        if (releases === null) {
            merged.set(key, null);
            continue;
        }
        const set = current ?? new Set<string>();
        for (const r of releases) set.add(r);
        merged.set(key, set);
    }

    return [...merged].map(([key, set]) => ({
        key,
        releases: set === null ? null : [...set].sort(),
    }));
}

// ===== Drizzle adapter =====

/**
 * The row ceiling for one key. Above it the key is treated as having no
 * candidates (and logged): a pathological key degrades to "unmatched" instead
 * of taking the process down. See `config.match.maxCandidatesPerKey`.
 *
 * Sized from the development mirror on 2026-09-12: after release scoping the
 * Ubuntu kernel keys are 8–15k rows and 3–12 MB each (`deb/ubuntu|linux-fips`
 * at 22.04 is the largest, 14,464 rows), while unscoped they are 47–65k rows
 * and 19–60 MB. 20k keeps every real key and still cuts the unscoped shape
 * that exhausted the heap.
 */
export const DEFAULT_MAX_CANDIDATES_PER_KEY = 20_000;

export interface DrizzleCandidateStoreOptions {
    maxCandidatesPerKey?: number;
}

/**
 * The `WHERE` both adapter queries share.
 *
 * `match_key IN (…)` against `vuln_affected_pkg_match_key_release_idx`, which
 * is partial on `withdrawn = false`. The withdrawn predicate is therefore load
 * bearing twice over: it is the correctness filter, *and* it is what makes the
 * partial index applicable at all. Drop it and the planner has no usable index
 * for this predicate, so the hottest query in the system quietly becomes a
 * sequential scan over the whole mirror — a regression that changes no result
 * and so fails no behavioural test.
 *
 * Scoped keys are grouped by their release set — one SBOM's distro
 * components all carry the same release, so a batch has one or two groups —
 * and each group is two arms the index answers on both columns:
 * `(key IN g AND release_version IS NULL)` and
 * `(key IN g AND release_version IN releases)`. Written as separate arms
 * rather than an `OR` inside the `AND` so each is a complete index
 * condition; the planner combines them with a BitmapOr.
 */
function candidatePredicate(keys: readonly CandidateKey[], excludeKeys: readonly string[] = []): SQL {
    const unscoped: string[] = [];
    const groups = new Map<string, { keys: string[]; releases: readonly string[] }>();

    for (const { key, releases } of mergeCandidateKeys(keys)) {
        if (releases === null) {
            unscoped.push(key);
            continue;
        }
        const signature = releases.join(" ");
        const group = groups.get(signature);
        if (group) group.keys.push(key);
        else groups.set(signature, { keys: [key], releases });
    }

    const arms: SQL[] = [];
    if (unscoped.length > 0) arms.push(inArray(vulnerabilityAffectedPackages.matchKey, unscoped));
    for (const { keys: groupKeys, releases } of groups.values()) {
        arms.push(
            and(
                inArray(vulnerabilityAffectedPackages.matchKey, groupKeys),
                isNull(vulnerabilityAffectedPackages.releaseVersion),
            )!,
        );
        if (releases.length > 0) {
            arms.push(
                and(
                    inArray(vulnerabilityAffectedPackages.matchKey, groupKeys),
                    inArray(vulnerabilityAffectedPackages.releaseVersion, [...releases]),
                )!,
            );
        }
    }

    return and(
        eq(vulnerabilityAffectedPackages.withdrawn, false),
        // Scoped to the live generation: a rebuild in flight has a second
        // full copy of the mirror in this table, and without this every
        // candidate would be returned twice. See src/db/generation.ts.
        isCurrentGeneration(),
        or(...arms)!,
        ...(excludeKeys.length > 0 ? [notInArray(vulnerabilityAffectedPackages.matchKey, [...excludeKeys])] : []),
    )!;
}

/**
 * The lookup, as a query rather than a result.
 *
 * @internal Exposed only so the integration test can assert on its `EXPLAIN`
 * output. Asserting against hand-written SQL would prove the *index* works
 * while saying nothing about the query the store actually issues.
 */
export function candidateQuery(
    db: PostgresJsDatabase<typeof schema>,
    keys: readonly CandidateKey[],
    excludeKeys: readonly string[] = [],
) {
    return db
        .select({
            vulnerabilityId: vulnerabilityAffectedPackages.vulnerabilityId,
            matchKey: vulnerabilityAffectedPackages.matchKey,
            ecosystem: vulnerabilityAffectedPackages.ecosystem,
            packageName: vulnerabilityAffectedPackages.packageName,
            versions: vulnerabilityAffectedPackages.versions,
            ranges: vulnerabilityAffectedPackages.ranges,
            fixedVersion: vulnerabilityAffectedPackages.fixedVersion,
            withdrawn: vulnerabilityAffectedPackages.withdrawn,
        })
        .from(vulnerabilityAffectedPackages)
        .where(candidatePredicate(keys, excludeKeys));
}

/**
 * Which keys of a batch would exceed `cap` rows under the same predicate.
 *
 * Runs before the lookup so the rows are counted where they live instead of
 * after they have been shipped to the heap: the Ubuntu kernel keys are 50–65k
 * rows and 40–60 MB each, and four concurrent batches of that shape is what
 * exhausted the server's heap on 2026-09-12. Reads the same index and heap
 * pages the lookup is about to, minus the TOASTed version lists, so for an
 * ordinary batch it is a fraction of the lookup's cost.
 */
export function oversizedKeysQuery(db: PostgresJsDatabase<typeof schema>, keys: readonly CandidateKey[], cap: number) {
    return db
        .select({
            matchKey: vulnerabilityAffectedPackages.matchKey,
            rows: sql<number>`count(*)::int`,
        })
        .from(vulnerabilityAffectedPackages)
        .where(candidatePredicate(keys))
        .groupBy(vulnerabilityAffectedPackages.matchKey)
        .having(gt(sql`count(*)`, cap));
}

/** The production store. */
export function createDrizzleCandidateStore(
    db: PostgresJsDatabase<typeof schema>,
    options: DrizzleCandidateStoreOptions = {},
): CandidateStore {
    const cap = options.maxCandidatesPerKey ?? DEFAULT_MAX_CANDIDATES_PER_KEY;

    return {
        async findByKeys(keys: readonly CandidateKey[]): Promise<Map<string, Candidate[]>> {
            const merged = mergeCandidateKeys(keys);
            if (merged.length === 0) return new Map();

            const oversized = await oversizedKeysQuery(db, merged, cap);
            for (const { matchKey, rows } of oversized) {
                await warn(
                    { matchKey, rows, cap },
                    "Match key exceeds the candidate cap after release scoping; treating as unmatched",
                );
            }

            return groupByKey(
                await candidateQuery(
                    db,
                    merged,
                    oversized.map((o) => o.matchKey),
                ),
            );
        },
    };
}

// ===== In-memory store =====

/**
 * A store backed by a literal array, for tests.
 *
 * It lives here rather than in `tests/` so it cannot drift from the port: a
 * change to `CandidateStore` or `Candidate` breaks this file at compile time,
 * which is exactly the signal a fake should give.
 *
 * It enforces the same withdrawn and release contracts as the real one — the
 * release read off the ecosystem string with the function that writes the
 * stored column — so a test that seeds a withdrawn or wrong-release
 * candidate is testing the matcher's own guard rather than an accident of
 * the fake.
 */
export function createInMemoryCandidateStore(candidates: readonly Candidate[]): CandidateStore {
    const byKey = groupByKey(candidates.filter((c) => !c.withdrawn));

    return {
        findByKeys(keys: readonly CandidateKey[]): Promise<Map<string, Candidate[]>> {
            const result = new Map<string, Candidate[]>();

            for (const { key, releases } of mergeCandidateKeys(keys)) {
                const found = byKey.get(key);
                if (!found) continue;

                const admitted =
                    releases === null
                        ? found
                        : found.filter((c) => {
                              const release = releaseVersion(parseEcosystem(c.ecosystem)?.release);
                              return release === null || releases.includes(release);
                          });
                if (admitted.length > 0) result.set(key, admitted);
            }

            return Promise.resolve(result);
        },
    };
}

function groupByKey(rows: readonly Candidate[]): Map<string, Candidate[]> {
    const map = new Map<string, Candidate[]>();

    for (const row of rows) {
        const existing = map.get(row.matchKey);
        if (existing) existing.push(row);
        else map.set(row.matchKey, [row]);
    }

    return map;
}
