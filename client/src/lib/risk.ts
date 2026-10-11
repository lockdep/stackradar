/**
 * Risk, on the client side.
 *
 * **A copy, deliberately.** The bands and their reasoning live in
 * `server/src/db/risk-model.ts`, and the client and server are separate
 * workspace roots with no shared package, so this file is the copy-and-
 * drift-check arrangement the rest of the codebase uses. Two rules follow:
 *
 *  1. **Nothing here computes a score.** The number always arrives from the
 *     API, where it came from a generated column. Re-deriving it in the browser
 *     would create a second definition of the thing the server went to some
 *     trouble to make unforgeable, and the two would disagree the first time a
 *     constant moved.
 *  2. `RISK_BANDS` must match the server's. It is a presentation table — where
 *     the colour changes — so a drift shows up as a badge in the wrong colour
 *     rather than a wrong number, but it is still drift.
 */

/**
 * Where the colour changes — for a **single finding's** 0–100 score.
 *
 * Never applied to an aggregate: since ADR 0007 the aggregate is an unbounded
 * sum, and a rollup's `band` arrives from the server as the band of its worst
 * finding. Colour says how bad the worst thing is; the total says how much
 * there is.
 *
 * Not the CVSS bands, and lower than they look like they should be. The score
 * is a product of two fractions, so its reachable range is compressed: a CVSS
 * 9.8 at the median EPSS score lands near 18 (low), and only measured
 * exploitation puts a finding at 35 or above. Recalibrated for EPSS v5 on
 * 2026-09-27 (was 70/40/15); the reasoning is on the server's `RISK_BANDS`. Reusing the CVSS boundaries here would
 * paint almost the whole corpus "low" and hide the ordering the score exists to
 * produce.
 */
const RISK_BANDS = [
    { min: 60, band: 'critical' },
    { min: 35, band: 'high' },
    { min: 20, band: 'medium' },
    { min: 1, band: 'low' },
    { min: 0, band: 'none' },
] as const;

export type RiskBand = (typeof RISK_BANDS)[number]['band'];

/**
 * The scales, in one sentence each. Kept here so the column header, the chip
 * and any future surface all describe the same number the same way.
 *
 * Naming (2026-08-19): **"Radar Score" is the branded name of the unbounded
 * aggregate** — the number unique to a customer's stack — never of the
 * per-finding 0–100, which is that finding's *contribution* to it. The brand
 * must read identically here, on the landing page and in /docs/radar-score;
 * flip all three or none.
 */
export const RISK_SCALE_HINT =
    'This finding’s contribution to the Radar Score, 0–100: CVSS severity weighted by EPSS exploitation likelihood, raised for findings on the CISA KEV list. Higher contributions get fixed first.';

/**
 * The aggregate's sentence. One number per image, workload, release, cluster
 * or org: the sum of its findings' contributions. Unbounded on purpose — it
 * grows with the pile and shrinks as findings are fixed, like
 * Dependency-Track's Inherited Risk Score, but each finding weighs in at its
 * exploitation-aware contribution rather than a severity constant.
 */
export const TOTAL_RISK_HINT =
    'Radar Score: the sum of every finding’s 0–100 contribution (CVSS weighted by EPSS exploitation likelihood, raised for CISA KEV findings). Unbounded — it falls as findings are fixed. Colour reflects the worst single finding.';

export function riskBand(score: number | null | undefined): RiskBand {
    if (score == null) return 'none';
    return RISK_BANDS.find((b) => score >= b.min)?.band ?? 'none';
}

/** The API shape of a risk rollup. Mirrors `RiskRollup` in `server/src/db/risk.ts`. */
export interface RiskRollup {
    /** Unbounded sum of the group's finding risks — a magnitude, not a ranking. */
    score: number;
    /** The band of the group's worst finding, never a threshold on the total. */
    band: RiskBand;
    findingCount: number;
    kevCount: number;
    exploitedCount: number;
    topFinding: { vulnId: string; risk: number } | null;
}

/** The exploitation inputs carried on every finding row. */
export interface RiskInputs {
    riskScore: number | null;
    cvssScore: number | null;
    epssScore: number | null;
    epssPercentile: number | null;
    kevListedAt: string | null;
    kevDueDate?: string | null;
    kevRansomware?: string | null;
}

/**
 * EPSS as the chance it reads as — `0.7%`, `34%`: one decimal below 10%,
 * none above. Most advisories sit under a tenth of a percent, and `0.0%`
 * there would print a zero FIRST.org never gave, so those say `<0.1%`.
 */
export function epssPercent(score: number): string {
    const percent = score * 100;
    if (percent > 0 && percent < 0.1) return '<0.1%';
    return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

/**
 * The sentence under a ranked row: why it sits where it sits.
 *
 * Every clause is a public fact with a source. The one thing this must never do
 * is print a number for a missing EPSS score — the model treats an unscored
 * advisory as roughly typical, but that is our assumption and not FIRST.org's
 * finding, so the honest rendering is a dash.
 */
export function explainRisk(inputs: RiskInputs): string[] {
    const parts: string[] = [];

    if (inputs.kevListedAt) {
        const since = new Date(inputs.kevListedAt).toISOString().slice(0, 10);
        parts.push(`On CISA KEV since ${since}`);
    }

    if (inputs.epssScore != null) {
        const pct = inputs.epssPercentile != null ? ` (${Math.round(inputs.epssPercentile * 100)}th pct)` : '';
        parts.push(`EPSS ${inputs.epssScore.toFixed(3)}${pct}`);
    } else {
        parts.push('EPSS — (not scored)');
    }

    parts.push(inputs.cvssScore != null ? `CVSS ${inputs.cvssScore.toFixed(1)}` : 'CVSS —');

    return parts;
}

/** `−54.3` → "cuts risk by 54". Sign-aware, because a bump can make things worse. */
export function formatRiskChange(change: number): string {
    if (change === 0) return 'no change in risk';
    const magnitude = Math.abs(change).toFixed(0);
    return change < 0 ? `cuts risk by ${magnitude}` : `raises risk by ${magnitude}`;
}
