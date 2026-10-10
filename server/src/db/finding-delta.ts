/**
 * What moving from one image to another would actually buy.
 *
 * The whole of `base-image-recommendations.md` phase 1 reduces to one question:
 * given two digests we have both scanned, which findings does the second one
 * not have? Everything above it — tag ordering, chart matching, the copy on the
 * button — is about *choosing* the second digest. This module is the
 * measurement.
 *
 * ## What makes two findings "the same finding"
 *
 * Not the component id: components are rows of an SBOM, so the same package in
 * two images is two rows and every finding would read as resolved-and-
 * reintroduced. Not the advisory alone either: one CVE affecting three packages
 * in an image is three things to fix, and an upgrade that fixes one of them has
 * not cleared the CVE.
 *
 * The key is **(package name, advisory identity)** — the same pair
 * `collapsedFindings` collapses on, with the SBOM-local component id swapped
 * for the package's name. `findingIdentity` is reused verbatim so an advisory
 * that reaches one image as a GHSA and the other as its CVE is one finding on
 * both sides rather than a spurious resolve-and-introduce pair.
 *
 * Package *name* and not PURL, deliberately: a PURL carries the version, so
 * every upgraded package would compare unequal, which is the opposite of what
 * is being asked. Name collisions across ecosystems (an npm `nginx` and an apk
 * `nginx`) are possible in principle and would merge two findings; the type is
 * therefore part of the key too.
 *
 * The name is `findingPackageName` — the source package for a distro
 * component, the component's own name otherwise — so that, exactly as in
 * `collapsedFindings`, a CVE on `libssl3t64` and on `openssl` is one finding
 * here and not two, and "this upgrade resolves N" agrees with the N the
 * dashboards count.
 */

import { and, inArray, sql } from "drizzle-orm";
import { db, type Transaction } from "./index.js";
import { images } from "./schema/images.js";
import { countedFindingRows, notCoveredByCveFinding } from "./findings.js";
import { aggregateRisk } from "./risk-model.js";
import { passesLens, type LensBucket } from "./finding-tier.js";

/** One finding, keyed so it can be compared across images. */
export interface ComparableFinding {
    /** `${type}|${packageName}|${identity}` — see the module header. */
    key: string;
    vulnId: string;
    packageName: string;
    packageType: string;
    /**
     * The package's PURL type (`golang`, `npm`, `deb`, …), for choosing a
     * version comparator (`schemeForPurlType`). Distinct from `packageType`,
     * which is the CycloneDX component type (`library`, `application`) and
     * says nothing about version semantics. Null when the component has no
     * parseable PURL.
     */
    purlType: string | null;
    /** The version present in *this* image. */
    packageVersion: string | null;
    severityLevel: string | null;
    riskScore: number;
    kevListed: boolean;
    epssScore: number | null;
    fixedVersion: string | null;
    /**
     * The tier-lens bucket of the component carrying it (`finding-tier.ts`).
     * Not part of the key: a finding that moved from the base into the
     * customer's own layer is the same finding.
     */
    bucket: LensBucket;
}

/**
 * The difference between two images' findings, with the aggregate risk each
 * side carries.
 *
 * `unchanged` is spelled out rather than left as a count because it is the
 * honest half of the recommendation. `base-image-recommendations.md` is
 * explicit that findings persisting across the upgrade must be listed, "so the
 * customer knows the bump is not the whole fix" — a recommendation that reports
 * only what it clears is a sales pitch.
 */
/** A finding present on both sides whose severity band moved — the advisory was re-scored. */
export interface RescoredFinding extends ComparableFinding {
    previousSeverityLevel: string | null;
}

export interface FindingDelta {
    fromImageId: string;
    toImageId: string;
    resolved: ComparableFinding[];
    introduced: ComparableFinding[];
    /** Present on both sides, by key. Includes the rescored ones — they did persist. */
    unchanged: ComparableFinding[];
    /**
     * The subset of `unchanged` whose severity band changed between the two
     * reads. Only meaningful when both sides are the same image (the scan
     * bracket): an advisory that was `unknown` yesterday and is critical
     * today is a change the feed must show, even though no finding arrived
     * or left. Across two images the same advisory has the same severity,
     * so this is empty for an upgrade delta.
     */
    rescored: RescoredFinding[];
    /** Aggregate risk before and after, on the same scale as everything else. */
    riskBefore: number;
    riskAfter: number;
}

/** `pkg:golang/prometheus@2.51.0` → `golang`. Null for anything unparseable. */
function purlTypeOf(purl: string | null): string | null {
    if (!purl) return null;
    const match = /^pkg:([A-Za-z0-9.+-]+)\//.exec(purl);
    return match ? match[1]!.toLowerCase() : null;
}

/**
 * Every counted finding on these images, in comparable form.
 *
 * Deliberately not built on `collapsedFindings`: that subquery collapses on
 * a per-image package key, which is exactly the key that cannot cross an image
 * boundary. The rows it collapses are shared — `countedFindingRows` is rules
 * 1, 2 and 4 and `notCoveredByCveFinding` is rule 5, imported, not restated
 * — but the `DISTINCT ON` is over the cross-image key instead. Keeping the two in one file would mean a
 * parameterised key, and a shared function whose key argument changes what a
 * finding *is* is worse than two call sites that each say which question they
 * are asking.
 */
export async function comparableFindings(
    imageIds: string[],
    /**
     * The inventory report measures a completed move inside its own
     * transaction, so the read can run on that connection rather than take
     * a second one from the pool while the first is held.
     */
    executor: typeof db | Transaction = db,
    /**
     * Only the findings of one advisory identity — the exposure walk asks
     * "did this older digest carry it too?" of many images at once and has
     * no use for the rest. Applied after the collapse's own rules, never in
     * `countedFindingRows`' scope: rule 5 must still see the whole component.
     */
    identity?: string
): Promise<Map<string, ComparableFinding[]>> {
    const out = new Map<string, ComparableFinding[]>();
    if (imageIds.length === 0) return out;
    for (const id of imageIds) out.set(id, []);

    const scoped = countedFindingRows(inArray(images.id, imageIds), executor);

    const rows = await executor
        .selectDistinctOn([scoped.imageId, scoped.packageType, scoped.packageName, scoped.identity], {
            imageId: scoped.imageId,
            packageName: scoped.packageName,
            packageType: scoped.packageType,
            purl: scoped.purl,
            packageVersion: scoped.packageVersion,
            vulnId: scoped.vulnId,
            severityLevel: scoped.severityLevel,
            riskScore: scoped.riskScore,
            kevListedAt: scoped.kevListedAt,
            epssScore: scoped.epssScore,
            fixedVersion: scoped.fixedVersion,
            identity: scoped.identity,
            bucket: scoped.bucket,
        })
        .from(scoped)
        .where(and(
            notCoveredByCveFinding(scoped),
            identity === undefined ? undefined : sql`${scoped.identity} = ${identity}`
        ))
        .orderBy(
            scoped.imageId,
            scoped.packageType,
            scoped.packageName,
            scoped.identity,
            // Same survivor rule as `collapsedFindings`, for the same reason:
            // the collapsed row must report the worst of what it folded.
            sql`${scoped.cvssScore} DESC NULLS LAST`,
            sql`${scoped.riskScore} DESC NULLS LAST`
        );

    for (const row of rows) {
        out.get(row.imageId)?.push({
            key: `${row.packageType}|${row.packageName}|${row.identity}`,
            vulnId: row.vulnId,
            packageName: row.packageName,
            packageType: row.packageType,
            purlType: purlTypeOf(row.purl),
            packageVersion: row.packageVersion,
            severityLevel: row.severityLevel,
            riskScore: row.riskScore ?? 0,
            kevListed: row.kevListedAt != null,
            epssScore: row.epssScore,
            fixedVersion: row.fixedVersion,
            bucket: row.bucket,
        });
    }

    return out;
}

/** The advisory identity half of a {@link ComparableFinding.key}. An identity never contains `|`. */
export function identityOfKey(key: string): string {
    return key.slice(key.lastIndexOf("|") + 1);
}

/** Diff two already-loaded finding sets. Pure, so the ordering rules are testable. */
export function diffFindings(
    fromImageId: string,
    toImageId: string,
    from: ComparableFinding[],
    to: ComparableFinding[]
): FindingDelta {
    const toByKey = new Map(to.map((f) => [f.key, f]));
    const fromKeys = new Set(from.map((f) => f.key));

    const resolved: ComparableFinding[] = [];
    const unchanged: ComparableFinding[] = [];
    const rescored: RescoredFinding[] = [];
    for (const finding of from) {
        const after = toByKey.get(finding.key);
        if (!after) {
            resolved.push(finding);
            continue;
        }
        unchanged.push(finding);
        // A rescored finding is reported in its *after* state, with the
        // before state's level alongside — that pair is the change.
        if (severityBand(after.severityLevel) !== severityBand(finding.severityLevel)) {
            rescored.push({ ...after, previousSeverityLevel: finding.severityLevel });
        }
    }

    const introduced = to.filter((f) => !fromKeys.has(f.key));

    // Worst first on every list. The user reads the head of each and stops.
    const byRisk = (a: ComparableFinding, b: ComparableFinding) => b.riskScore - a.riskScore;
    resolved.sort(byRisk);
    introduced.sort(byRisk);
    unchanged.sort(byRisk);
    rescored.sort(byRisk);

    return {
        fromImageId,
        toImageId,
        resolved,
        introduced,
        unchanged,
        rescored,
        riskBefore: aggregateRisk(from.map((f) => f.riskScore)),
        riskAfter: aggregateRisk(to.map((f) => f.riskScore)),
    };
}

/**
 * A set of findings counted per severity band. `unscored` is the mirror's
 * `unknown` and every level that is not one of the four bands — kept apart
 * rather than folded into `low`, because "no CVSS yet" is not "low".
 */
export interface SeverityBreakdown {
    critical: number;
    high: number;
    medium: number;
    low: number;
    unscored: number;
}

export type SeverityBand = keyof SeverityBreakdown;

/** The band a severity level falls in; anything outside the four is `unscored`. */
export function severityBand(level: string | null | undefined): SeverityBand {
    switch ((level ?? "").toLowerCase()) {
        case "critical": return "critical";
        case "high": return "high";
        case "medium": return "medium";
        case "low": return "low";
        default: return "unscored";
    }
}

export function countBySeverity<T extends ComparableFinding>(
    findings: readonly T[],
    level: (f: T) => string | null = (f) => f.severityLevel
): SeverityBreakdown {
    const out: SeverityBreakdown = { critical: 0, high: 0, medium: 0, low: 0, unscored: 0 };
    for (const f of findings) out[severityBand(level(f))] += 1;
    return out;
}

/**
 * {@link countBySeverity} under each single-bucket tier lens, the exploited
 * override already applied — what an event payload stores so the movement
 * block can answer `?tier=` from counts alone, long after the findings
 * themselves have changed.
 */
export type LensBreakdown = { application: SeverityBreakdown; base: SeverityBreakdown };

export function countByLens(findings: readonly ComparableFinding[]): LensBreakdown {
    return {
        application: countBySeverity(findings.filter((f) => passesLens(f, ["application"]))),
        base: countBySeverity(findings.filter((f) => passesLens(f, ["base"]))),
    };
}

/**
 * What a move clears, split by where the findings live — a package bump and
 * a base rebuild are different kinds of action, and a tag move is some of
 * each. `unknown` counts as application: recommendations treat what nothing
 * has classified as the customer's own, because hiding a fix there is the
 * expensive error. Not on {@link DeltaSummary}: that shape is shared with the
 * chart index through a byte-equal fixture.
 */
export type ScopeCounts = { application: number; base: number };

export function resolvedByScope(delta: FindingDelta): ScopeCounts {
    const out: ScopeCounts = { application: 0, base: 0 };
    for (const f of delta.resolved) out[f.bucket === "base" ? "base" : "application"] += 1;
    return out;
}

/** Scored findings per plain lens bucket — no exploited override, unlike {@link countByLens}. */
export function countByBucket(findings: readonly ComparableFinding[]): ScopeCounts & { unknown: number } {
    const out = { application: 0, base: 0, unknown: 0 };
    for (const f of findings) {
        if (severityBand(f.severityLevel) !== "unscored") out[f.bucket] += 1;
    }
    return out;
}

/** The scope a move is filed under: where most of what it clears lives; a tie is the application's. */
export function moveScope(counts: ScopeCounts): "application" | "base" {
    return counts.base > counts.application ? "base" : "application";
}

/** The headline numbers, for a list row that has no space for the findings. */
export interface DeltaSummary {
    resolved: number;
    introduced: number;
    unchanged: number;
    resolvedKev: number;
    introducedKev: number;
    resolvedHigh: number;
    riskBefore: number;
    riskAfter: number;
    /** Negative is an improvement. Rounded to one place, like the scores. */
    riskChange: number;
}

const HIGH_OR_WORSE = new Set(["critical", "high"]);

export function summariseDelta(delta: FindingDelta): DeltaSummary {
    return {
        resolved: delta.resolved.length,
        introduced: delta.introduced.length,
        unchanged: delta.unchanged.length,
        resolvedKev: delta.resolved.filter((f) => f.kevListed).length,
        introducedKev: delta.introduced.filter((f) => f.kevListed).length,
        resolvedHigh: delta.resolved.filter((f) =>
            HIGH_OR_WORSE.has((f.severityLevel ?? "").toLowerCase())
        ).length,
        riskBefore: delta.riskBefore,
        riskAfter: delta.riskAfter,
        riskChange: Math.round((delta.riskAfter - delta.riskBefore) * 10) / 10,
    };
}
