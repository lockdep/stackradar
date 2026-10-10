/**
 * The risk formula. One definition, in two renderings that a test holds
 * together.
 *
 * `findings.ts` is the single answer to *what counts*. This module is the
 * single answer to *what it is worth*, and it exists for the same reason: the
 * moment two surfaces compute a priority differently, the product is back to
 * the 195/17/14 problem that module's header describes, except now the numbers
 * are opinions rather than counts and nobody can tell which one is wrong.
 *
 * ## Two layers, because a finding has no pod count
 *
 * [risk-ranking.md](../../../docs/proposals/risk-ranking.md) phase 3 asks for
 * one composite score per finding, stored on `component_vulnerabilities`, with
 * exploitation, severity **and exposure** as inputs. The first two are
 * properties of the advisory. The third is not, and under
 * [ADR 0004](../../../docs/adr/0004-image-as-the-unit-of-identity.md) it cannot
 * be: a finding keys on an image digest, and one image running in five
 * workloads is *one* finding with five different pod counts, five namespaces
 * and five ages. There is no row to write that number on.
 *
 * So the score is two layers:
 *
 *   1. **Finding risk** — `advisoryRisk`, below. A pure function of one row of
 *      `vulnerabilities`: CVSS, EPSS, KEV. Nothing tenant-scoped, nothing
 *      deployment-scoped, nothing that changes depending on who is asking. It
 *      is therefore a `GENERATED ALWAYS AS (…) STORED` column on that table —
 *      see {@link ADVISORY_RISK_SQL} — which makes drift between the score and
 *      its inputs *unrepresentable* rather than merely unlikely, and turns the
 *      daily EPSS refresh into the recomputation. The alternative in the
 *      proposal, a nightly sweep over every `component_vulnerabilities` row,
 *      recomputes millions of rows to restate a function of two hundred
 *      thousand.
 *
 *   2. **Aggregate risk** — {@link aggregateRiskSql}, applied over the
 *      findings of an image, a workload, a release or a cluster. An unbounded
 *      sum of finding risks (ADR 0007) — the layer that answers "how much
 *      vulnerability debt does this thing carry".
 *
 * Exposure — pod count, init-vs-serving, days unpatched — is deliberately in
 * *neither*. It renders as its own columns beside the score. The reason is the
 * one the proposal itself gives: "the credibility of the whole product rests on
 * findings being traceable to a public advisory". Every input to the number
 * below is a public fact with a URL. A multiplier of 1.15 for "twelve pods" is
 * not, and it is the part a security engineer would argue with first. Sorting
 * by risk and reading the pod count in the next column loses nothing, and keeps
 * the number defensible. This was an explicit product decision, not an
 * omission; revisit it by adding a *second* column, never by folding a guess
 * into this one.
 */

/**
 * What an advisory with no EPSS score is treated as.
 *
 * EPSS covers CVEs. A `GHSA-…` or `PYSEC-…` with no CVE alias, and every
 * `MAL-…`, has no score and never will — see `epss-sync/README.md` § Coverage.
 * The acceptance criterion in risk-ranking.md is that these "rank by a
 * documented, deliberate rule", and the two obvious rules are both wrong:
 * treating a missing score as 0 buries a real vulnerability because nobody
 * modelled it, and treating it as 1 floods the top of the list with the
 * unmodellable.
 *
 * 0.10 is the value {@link exploitability} returns for an EPSS score of 0.001.
 * That is a deliberately low default: under EPSS v5 (FIRST.org file of
 * 2026-09-27) the median CVE scores about 0.0067 (→ 0.19) and fewer than 1% of
 * scored CVEs sit at or below 0.001. So an unscored advisory ranks on its CVSS
 * alone, a little below a median-EPSS CVE of the same severity, and above
 * nothing. The UI must say `EPSS —` for these rather than `EPSS 0.10`;
 * the number is our assumption, not FIRST.org's finding.
 */
export const UNSCORED_EXPLOITABILITY = 0.1;

/**
 * CVSS scores an advisory that never got one, from the severity band it was
 * given instead.
 *
 * ~19% of rows in the mirror carry a `severity_level` and no `cvss_score`
 * (distro advisories mostly, which publish a band and no vector). Dropping
 * them to zero impact would rank a critical Alpine advisory below a scored
 * low, which is the same "no data means no risk" error {@link
 * UNSCORED_EXPLOITABILITY} exists to avoid. The values are the midpoints of the
 * CVSS v3.1 qualitative bands, except `critical`, which is the bottom of its
 * band rather than the midpoint — a band whose top is 10.0 has a midpoint of
 * 9.5, and assuming the worse half of "critical" on no evidence overstates more
 * than assuming the better half understates.
 */
const SEVERITY_FALLBACK_CVSS: Record<string, number> = {
    critical: 9.0,
    high: 7.5,
    medium: 5.0,
    low: 2.0,
};

/** CVSS band midpoint for an advisory with neither a score nor a known band. */
const UNKNOWN_CVSS = 4.0;

/**
 * How likely this is to be exploited, in [0, 1].
 *
 * KEV membership is 1.0 and dominates everything: CISA lists a CVE there
 * because it has been observed exploited in the wild, which is not a
 * probability to be blended with a prediction of one. risk-ranking.md phase 2
 * asks for KEV to also be "a distinct visual state, not a higher number" — that
 * is the UI's job, and it is not made redundant by this. A KEV finding on a
 * CVSS 3.1 advisory scores 31, below plenty of things; the badge is what says
 * *someone is using this right now* regardless of where it sorts.
 *
 * Otherwise, the cube root of the EPSS probability. The raw score is not usable
 * as a weight — its distribution is extreme, with a median around 0.007 (EPSS
 * v5) and a long thin tail (about 4.5% of CVEs at or above 0.1), so a linear
 * term makes almost every finding arithmetically indistinguishable from zero and the aggregate
 * collapses to "the one CVE with an EPSS score". The cube root spreads that
 * out: 0.001 → 0.10, 0.01 → 0.22, 0.1 → 0.46, 0.5 → 0.79, 0.97 → 0.99. The
 * ordering is untouched — it is a monotone transform — so this changes how far
 * apart two findings sit, never which is in front.
 *
 * Note this uses `epss_score` (the probability) and not `epss_percentile` (the
 * rank). Percentile is uniform by construction, so the median CVE would arrive
 * as 0.5, asserting that half of all CVEs are moderately likely to be
 * exploited. FIRST.org's own finding is that under 5% are ever exploited at
 * all. Percentile is worth showing — "99th pct" is how a human reads a score of
 * 0.87 — and worth nothing as a weight.
 */
export function exploitability(v: {
    kevListedAt?: Date | string | null;
    epssScore?: number | null;
}): number {
    if (v.kevListedAt != null) return 1.0;
    if (v.epssScore == null) return UNSCORED_EXPLOITABILITY;
    return Math.cbrt(Math.max(0, Math.min(1, v.epssScore)));
}

/** How bad it is if exploited, in [0, 1]. CVSS base score over 10. */
export function impact(v: {
    cvssScore?: number | null;
    severityLevel?: string | null;
}): number {
    const score =
        v.cvssScore ??
        SEVERITY_FALLBACK_CVSS[(v.severityLevel ?? "").toLowerCase()] ??
        UNKNOWN_CVSS;
    return Math.max(0, Math.min(10, score)) / 10;
}

/**
 * One advisory's risk, 0–100. Likelihood times consequence, and nothing else.
 *
 * The multiplication is the point, and it is what makes this a *ranking* rather
 * than a restatement of CVSS. A CVSS 9.8 nobody has ever exploited (EPSS
 * 0.0004) scores 7; a CVSS 5.3 with an exploit in the wild scores 53. That
 * inversion is the entire reason for the feature, and it is also the thing that
 * will generate the first support ticket, so every surface showing this number
 * must show its inputs next to it.
 *
 * Most findings score in the single digits. That is correct and should not be
 * "fixed" by rescaling: fewer than 5% of CVEs are ever exploited, so a list
 * where almost everything is near zero and four things are not *is* the
 * finding.
 */
export function advisoryRisk(v: {
    cvssScore?: number | null;
    severityLevel?: string | null;
    epssScore?: number | null;
    kevListedAt?: Date | string | null;
}): number {
    return 100 * impact(v) * exploitability(v);
}

/**
 * The SQL rendering of {@link advisoryRisk}, over bare column names of
 * `vulnerabilities`.
 *
 * Written as a string of unqualified column references rather than a Drizzle
 * `sql` template because its first consumer is a `GENERATED ALWAYS AS`
 * clause, which may not name a table and may not carry a bound parameter.
 * Every function in it — `power`, `coalesce`, `least`, `greatest`, `lower`,
 * `CASE` — is immutable, which is what Postgres requires of a generated
 * column and what lets the expression be indexed.
 *
 * `power(x, 1/3.0)` rather than `cbrt(x)`: identical for the non-negative
 * domain here, and it keeps the exponent visible at the call site so this
 * reads as the same transform the TypeScript applies.
 *
 * `tests/unit/db/risk-model.test.ts` evaluates both renderings over the same
 * inputs and asserts they agree. Change one without the other and it fails.
 */
export const ADVISORY_RISK_SQL = `
    100.0
    * (least(greatest(coalesce(
        cvss_score,
        CASE lower(coalesce(severity_level, ''))
            WHEN 'critical' THEN ${SEVERITY_FALLBACK_CVSS.critical}
            WHEN 'high'     THEN ${SEVERITY_FALLBACK_CVSS.high}
            WHEN 'medium'   THEN ${SEVERITY_FALLBACK_CVSS.medium}
            WHEN 'low'      THEN ${SEVERITY_FALLBACK_CVSS.low}
            ELSE ${UNKNOWN_CVSS}
        END
      ), 0), 10) / 10.0)
    * (CASE
        WHEN kev_listed_at IS NOT NULL THEN 1.0
        WHEN epss_score IS NULL THEN ${UNSCORED_EXPLOITABILITY}
        ELSE power(least(greatest(epss_score, 0), 1), 1/3.0)
      END)
`;

/**
 * Roll a set of finding risks up into one number for the thing that carries
 * them — an image, a workload, a release, a cluster, an org.
 *
 * A plain, unbounded **sum** of the finding risks — the same shape as
 * Dependency-Track's Inherited Risk Score (`critical×10 + high×5 + …`), except
 * each finding's weight is its `advisoryRisk` rather than a severity-band
 * constant, so EPSS and KEV still decide what a finding contributes. See
 * [ADR 0007](../../../docs/adr/0007-aggregate-risk-is-an-unbounded-sum.md) for
 * why this replaced the bounded rank-decayed noisy-OR ADR 0005 argued for.
 *
 * The short version: the aggregate is a **magnitude**, not a ranking. It
 * answers "how much vulnerability debt does this thing carry", it visibly
 * shrinks as findings are fixed, and — because a sum composes — a cluster's
 * score really is the sum of its images' scores, which the old fold could not
 * offer. The property the sum gives up is worst-domination: five hundred
 * trivial findings now outscore one KEV critical. That question — "how bad is
 * the worst thing in here" — is answered by the rollup's *band*, which is the
 * band of its worst finding, and by the KEV badge; neither is derived from the
 * total.
 *
 * Two properties still hold and still matter: **monotone** (a new finding never
 * lowers the score) and **traceable** (the total is the sum of per-finding
 * numbers the UI can show, each computed from public facts).
 *
 * Rounded to a whole number in both renderings: at the scale a sum reaches,
 * decimals are noise.
 */
export function aggregateRiskSql(risk: string): string {
    return `round(sum(${risk}))::int`;
}

/**
 * The TypeScript rendering of the aggregate, for tests and for callers holding
 * findings in memory. Takes finding risks in any order.
 */
export function aggregateRisk(findingRisks: number[]): number {
    return Math.round(findingRisks.reduce((sum, r) => sum + r, 0));
}

/**
 * The bands the UI colours by, and the only place a risk number becomes a word.
 *
 * Bands are defined over a **single finding's** 0–100 `advisoryRisk`, never
 * over an aggregate: the aggregate is an unbounded sum, so any threshold on it
 * would really be a threshold on finding *count*. A rollup's band is the band
 * of its worst finding — colour says "how bad is the worst thing in here",
 * the total says "how much is there".
 *
 * Deliberately *not* aligned to the CVSS severity bands, and the boundaries are
 * lower than they look like they should be. `advisoryRisk` is a product of two
 * fractions, so the reachable range is compressed: a CVSS 9.8 at the median
 * EPSS score lands near 18 (low), and only measured exploitation gets a
 * finding to 35 or above. Reusing the CVSS bands here would label almost the
 * entire corpus "low" and hide the ordering the score exists to produce.
 *
 * Recalibrated 2026-09-27 for EPSS v5 (model v2026.06.15), from 70/40/15. v5
 * raised the middle of the distribution (median 0.0026 → 0.0067) and pulled
 * in the tail (99th percentile 0.77 → 0.55), so the old thresholds put 73% of
 * CVSS 9.8 CVEs in medium and fewer in high and critical. 60/35/20 restores
 * the pre-v5 share of CVEs at or above each boundary for CVSS 8.8–9.8 (at 9.8:
 * 43.5 / 8.7 / 2.3% against 41.4 / 8.4 / 2.8% on the FIRST files of
 * 2026-06-14 and 2026-09-27). KEV findings (likelihood 1.0) are critical from
 * CVSS 6.0 and high from 3.5. The canonical pair keeps its bands: 9.8 at EPSS
 * 0.0004 adds 7 (low), 5.3 + KEV adds 53 (high).
 */
export const RISK_BANDS = [
    { min: 60, band: "critical" },
    { min: 35, band: "high" },
    { min: 20, band: "medium" },
    { min: 1, band: "low" },
    { min: 0, band: "none" },
] as const;

export type RiskBand = (typeof RISK_BANDS)[number]["band"];

export function riskBand(score: number | null | undefined): RiskBand {
    if (score == null) return "none";
    return RISK_BANDS.find((b) => score >= b.min)?.band ?? "none";
}
