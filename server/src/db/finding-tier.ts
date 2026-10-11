/**
 * The tier lens: "Application · Base image · All" over findings.
 *
 * `components.tier` says what kind of thing a component is
 * (`lib/component-tier.ts`). This module is the one definition of how that
 * becomes a *view* of findings, so the client, the digest and every API
 * consumer inherit the same three rules:
 *
 *   1. **A tier is a default lens, never a verdict.** It decides what is
 *      shown first, not what exists. Every lensed response carries
 *      `tierCounts` for all buckets, so the folded one stays visible.
 *   2. **Exploited findings are never folded.** A finding on CISA KEV, or with
 *      EPSS at or above `NOTABLE_EPSS` — the same line the unscored filter and
 *      the rollup's `exploitedCount` draw — passes any lens, marked
 *      `shownDespiteTier` so a reader can say why a base-image row is in the
 *      Application list.
 *   3. **Fold, do not suppress.** A lens hides nothing from the count; the
 *      risk score never reads the lens.
 *
 * The `?tier=` parameter carries tier values (`application,main`), and a tier
 * value selects its **bucket**. That indirection is deliberate: once the
 * base-image boundary is known, an `os` package the customer's own
 * `apt-get install` layer added belongs under Application, and only
 * {@link lensBucket} changes — no endpoint, and no client, does.
 *
 * "tier", "bucket", "os" and "runtime" are internal words. The UI says
 * "Application", "Base image", "All".
 */

import { sql, type SQL } from "drizzle-orm";
import { components } from "./schema/components.js";
import { TIERS, type Tier } from "../lib/component-tier.js";

/**
 * Same value as `NOTABLE_EPSS` in `risk.ts`, which re-exports this one: the
 * constant lives here because `risk.ts` imports `findings.ts`, which imports
 * this module.
 */
export const EXPLOITED_EPSS = 0.1;

export type LensBucket = "application" | "base" | "unknown";

const BUCKET_OF_TIER: Record<Tier, LensBucket> = {
    application: "application",
    main: "application",
    os: "base",
    runtime: "base",
    unknown: "unknown",
};

/** {@link lensBucket} over a row in memory: `from_base` when known, the tier otherwise. */
export function bucketOf(row: { tier: Tier; fromBase?: boolean | null | undefined }): LensBucket {
    if (row.fromBase === true) return "base";
    if (row.fromBase === false) return "application";
    return BUCKET_OF_TIER[row.tier];
}

/**
 * The bucket of a component row, as SQL over `components`. Evaluated once per
 * finding row in stage 1 of `countedFindingRows`.
 *
 * Provenance first, kind second: where the base-image boundary is known
 * (`components.from_base`) it decides — an OS package the
 * customer's own `apt-get install` layer added is theirs to fix, and tooling
 * the base image shipped is not. Where it is not known, the tier stands in.
 * {@link bucketOf} is the same rule for rows already in memory.
 */
export const lensBucket: SQL<LensBucket> = sql<LensBucket>`
    CASE
        WHEN ${components.fromBase} IS TRUE THEN 'base'
        WHEN ${components.fromBase} IS FALSE THEN 'application'
        ELSE CASE ${components.tier}
            WHEN 'application' THEN 'application'
            WHEN 'main' THEN 'application'
            WHEN 'os' THEN 'base'
            WHEN 'runtime' THEN 'base'
            ELSE 'unknown'
        END
    END
`;

/** A parsed `?tier=`: the buckets the caller asked to see. */
export type TierLens = readonly LensBucket[];

/**
 * Parse `?tier=application,main`. Comma-joined, unknown values ignored — the
 * treatment `severity` gets — and nothing recognisable means no lens at all,
 * which is "All".
 */
export function parseTierParam(raw: string | undefined | null): TierLens | undefined {
    if (!raw) return undefined;
    const buckets = new Set<LensBucket>();
    for (const part of raw.split(",")) {
        const value = part.trim().toLowerCase();
        if ((TIERS as readonly string[]).includes(value)) buckets.add(BUCKET_OF_TIER[value as Tier]);
    }
    return buckets.size === 0 ? undefined : [...buckets];
}

/** The per-bucket finding counts every lensed response carries. */
export type TierCounts = { application: number; base: number; all: number };

export function emptyTierCounts(): TierCounts {
    return { application: 0, base: 0, all: 0 };
}

/** The columns of a findings row the lens reads, whatever subquery produced them. */
type LensRow = {
    bucket: SQL.Aliased<LensBucket> | SQL<LensBucket>;
    kevListedAt: unknown;
    epssScore: unknown;
};

function bucketList(lens: TierLens): SQL {
    return sql.join(
        lens.map((b) => sql`${b}`),
        sql`, `,
    );
}

function exploitedSql(row: LensRow): SQL {
    return sql`(${row.kevListedAt} IS NOT NULL OR ${row.epssScore} >= ${EXPLOITED_EPSS})`;
}

/** Rule 2 as a predicate: in the lens, or exploited. `undefined` without a lens. */
export function inTierLens(row: LensRow, lens: TierLens | undefined): SQL | undefined {
    if (!lens) return undefined;
    return sql`(${row.bucket} IN (${bucketList(lens)}) OR ${exploitedSql(row)})`;
}

/** True for a row the lens would have folded and the override kept. */
export function shownDespiteTierSql(row: LensRow, lens: TierLens | undefined): SQL<boolean> {
    if (!lens) return sql<boolean>`false`;
    return sql<boolean>`(${row.bucket} NOT IN (${bucketList(lens)}))`;
}

/**
 * The three `count(*) FILTER` columns behind {@link TierCounts}. Select them
 * from a findings subquery **without** the lens predicate; the buckets are
 * plain — the override rows are not counted into Application, so the
 * segments add up to All (less `unknown`).
 */
export function tierCountColumns(row: LensRow) {
    return {
        application: sql<number>`count(*) FILTER (WHERE ${row.bucket} = 'application')::int`,
        base: sql<number>`count(*) FILTER (WHERE ${row.bucket} = 'base')::int`,
        all: sql<number>`count(*)::int`,
    };
}

// ===== The same rules over rows already in memory =====

/** Rule 2 over a finding that already knows its bucket (`finding-delta.ts`). */
export function passesLens(
    finding: { bucket: LensBucket; kevListed: boolean; epssScore: number | null },
    lens: TierLens | undefined,
): boolean {
    if (!lens || lens.includes(finding.bucket)) return true;
    return finding.kevListed || (finding.epssScore != null && finding.epssScore >= EXPLOITED_EPSS);
}

/**
 * The key event payloads store per-lens counts under, or null when the lens
 * is not one a payload can answer (no lens, several buckets, `unknown`) — the
 * caller then reads the unlensed counts.
 */
export function singleBucketLens(lens: TierLens | undefined): "application" | "base" | null {
    if (!lens || lens.length !== 1 || lens[0] === "unknown") return null;
    return lens[0]!;
}

type LensFacts = {
    tier: Tier;
    fromBase?: boolean | null | undefined;
    kevListedAt: Date | null;
    epssScore: number | null;
};

function isExploited(row: LensFacts): boolean {
    return row.kevListedAt != null || (row.epssScore != null && row.epssScore >= EXPLOITED_EPSS);
}

export function tierCountsOf(rows: readonly LensFacts[]): TierCounts {
    const counts = emptyTierCounts();
    for (const row of rows) {
        const bucket = bucketOf(row);
        if (bucket === "application") counts.application += 1;
        else if (bucket === "base") counts.base += 1;
        counts.all += 1;
    }
    return counts;
}

/** Apply the lens, marking the rows rule 2 kept. Without a lens every row passes unmarked. */
export function applyTierLens<T extends LensFacts>(
    rows: readonly T[],
    lens: TierLens | undefined,
): (T & { shownDespiteTier: boolean })[] {
    const kept: (T & { shownDespiteTier: boolean })[] = [];
    for (const row of rows) {
        const inLens = !lens || lens.includes(bucketOf(row));
        if (inLens) kept.push({ ...row, shownDespiteTier: false });
        else if (isExploited(row)) kept.push({ ...row, shownDespiteTier: true });
    }
    return kept;
}
