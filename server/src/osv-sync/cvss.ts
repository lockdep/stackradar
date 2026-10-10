/**
 * CVSS Vector Parsers & Base Score Calculators
 *
 * Parses CVSS:3.0 and CVSS:3.1 vector strings into numeric base scores
 * and severity labels in-house, implementing the CVSS v3.1 specification:
 * https://www.first.org/cvss/v3.1/specification-document
 *
 * CVSS 4.0 and CVSS 2.0 are delegated to `ae-cvss-calculator` — v4's base
 * score is a 270-entry MacroVector lookup with interpolation, which is not
 * something to retype by hand.
 *
 * Also provides the severity extraction pipeline for OSV records. It reads
 * every place the OSV schema (https://ossf.github.io/osv-schema/) allows a
 * severity to live — record-level `severity[]`, per-entry
 * `affected[].severity[]`, and the free-form text labels distro publishers put
 * in `database_specific` / `affected[].ecosystem_specific` — so that an
 * advisory only ends up "unscored" when its publisher genuinely scored nothing.
 */

import CvssCalculator from "ae-cvss-calculator";

// ===== Types =====

export type SeverityLabel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface CvssResult {
    /** CVSS vector string (e.g. "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H") */
    vector: string;
    /** Numeric base score (0.0 – 10.0) */
    score: number;
    /** Severity label derived from the score */
    label: SeverityLabel;
}

/**
 * Where a severity came from, most to least authoritative. `ubuntu` is the
 * OSV `severity[].type = "Ubuntu"` priority label; `ecosystem_specific` covers
 * the Debian `urgency` and similar per-affected-entry text labels.
 */
export type SeveritySource =
    | "cvss_v3"
    | "cvss_v4"
    | "cvss_v2"
    | "ubuntu"
    | "database_specific"
    | "ecosystem_specific"
    | "heuristic";

export interface SeverityInfo {
    /** Numeric score (0.0 – 10.0), null if not computable */
    score: number | null;
    /** Severity label */
    label: SeverityLabel | null;
    /** Source of the severity information */
    source: SeveritySource;
    /** Original CVSS vector, if available */
    vector: string | null;
}

// ===== CVSS v3.x Metric Values =====

const ATTACK_VECTOR: Record<string, number> = {
    N: 0.85,  // Network
    A: 0.62,  // Adjacent
    L: 0.55,  // Local
    P: 0.2,   // Physical
};

const ATTACK_COMPLEXITY: Record<string, number> = {
    L: 0.77,  // Low
    H: 0.44,  // High
};

const PRIVILEGES_REQUIRED_UNCHANGED: Record<string, number> = {
    N: 0.85,  // None
    L: 0.62,  // Low
    H: 0.27,  // High
};

const PRIVILEGES_REQUIRED_CHANGED: Record<string, number> = {
    N: 0.85,  // None
    L: 0.68,  // Low
    H: 0.50,  // High
};

const USER_INTERACTION: Record<string, number> = {
    N: 0.85,  // None
    R: 0.62,  // Required
};

const CIA_IMPACT: Record<string, number> = {
    H: 0.56,  // High
    L: 0.22,  // Low
    N: 0,     // None
};

// ===== Score Calculation =====

/**
 * Parse a CVSS v3.x vector string and compute the base score.
 *
 * @param vector CVSS vector (e.g. "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")
 * @returns Parsed result with score and label, or null if the vector is invalid
 */
export function parseCvssV3(vector: string): CvssResult | null {
    if (!vector.startsWith("CVSS:3.")) return null;

    const metrics = parseMetrics(vector);
    if (!metrics) return null;

    const AV = metrics.AV!;
    const AC = metrics.AC!;
    const PR = metrics.PR!;
    const UI = metrics.UI!;
    const S = metrics.S!;
    const C = metrics.C!;
    const I = metrics.I!;
    const A = metrics.A!;

    const av = ATTACK_VECTOR[AV];
    const ac = ATTACK_COMPLEXITY[AC];
    const pr = S === "C"
        ? PRIVILEGES_REQUIRED_CHANGED[PR]
        : PRIVILEGES_REQUIRED_UNCHANGED[PR];
    const ui = USER_INTERACTION[UI];
    const c = CIA_IMPACT[C];
    const i = CIA_IMPACT[I];
    const a = CIA_IMPACT[A];

    if (av == null || ac == null || pr == null || ui == null || c == null || i == null || a == null) {
        return null;
    }

    // Impact Sub Score (ISS)
    const iss = 1 - ((1 - c) * (1 - i) * (1 - a));

    let impact: number;
    if (S === "U") {
        impact = 6.42 * iss;
    } else {
        impact = 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
    }

    // If impact is <= 0, the score is 0
    if (impact <= 0) {
        return { vector, score: 0, label: "NONE" };
    }

    // Exploitability
    const exploitability = 8.22 * av * ac * pr * ui;

    let score: number;
    if (S === "U") {
        score = roundUp(Math.min(impact + exploitability, 10));
    } else {
        score = roundUp(Math.min(1.08 * (impact + exploitability), 10));
    }

    return {
        vector,
        score,
        label: scoreToLabel(score),
    };
}

/**
 * Parse a CVSS v4.0 vector string and compute the *base* score.
 *
 * Threat and environmental metrics are ignored if present (`baseMetricsOnly`),
 * matching what {@link parseCvssV3} computes — `cvss_score` is a base score
 * everywhere it is read, and the risk model brings in exploitability through
 * EPSS/KEV rather than through CVSS's own threat metrics.
 *
 * v4 uses the same qualitative bands as v3.1, so {@link scoreToLabel} applies.
 */
export function parseCvssV4(vector: string): CvssResult | null {
    if (!vector.startsWith("CVSS:4.0/")) return null;
    try {
        const parsed = new CvssCalculator.Cvss4P0(vector);
        if (!parsed.isBaseFullyDefined()) return null;
        const score = parsed.calculateScores().baseMetricsOnly;
        if (typeof score !== "number" || !Number.isFinite(score)) return null;
        return { vector, score, label: scoreToLabel(score) };
    } catch {
        return null;
    }
}

/**
 * Parse a CVSS v2.0 vector string and compute the base score.
 *
 * OSV writes v2 vectors both bare (`AV:N/AC:L/Au:N/C:P/I:P/A:P`) and with the
 * NVD-style `CVSS:2.0/` prefix; both are accepted. v2 has no CRITICAL band
 * (NVD: 0–3.9 LOW, 4.0–6.9 MEDIUM, 7.0–10.0 HIGH), so the label is capped at
 * HIGH rather than run through the v3 bands — a v2 10.0 was never called
 * "critical" by anyone who published it.
 */
export function parseCvssV2(vector: string): CvssResult | null {
    const bare = vector.startsWith("CVSS:2.0/") ? vector.slice("CVSS:2.0/".length) : vector;
    if (!/^AV:[LAN]\/AC:[HML]\/Au:[MSN]\/C:[NPC]\/I:[NPC]\/A:[NPC]/.test(bare)) return null;
    try {
        const parsed = new CvssCalculator.Cvss2(bare);
        if (!parsed.isBaseFullyDefined()) return null;
        const score = parsed.calculateScores().base;
        if (typeof score !== "number" || !Number.isFinite(score)) return null;
        return { vector, score, label: scoreToLabelV2(score) };
    } catch {
        return null;
    }
}

/** NVD's CVSS v2 qualitative bands. */
export function scoreToLabelV2(score: number): SeverityLabel {
    if (score === 0) return "NONE";
    if (score <= 3.9) return "LOW";
    if (score <= 6.9) return "MEDIUM";
    return "HIGH";
}

/**
 * Parse metric key-value pairs from a CVSS vector string.
 */
function parseMetrics(vector: string): Record<string, string> | null {
    // Strip the "CVSS:3.x/" prefix
    const slashIdx = vector.indexOf("/");
    if (slashIdx === -1) return null;

    const metricStr = vector.slice(slashIdx + 1);
    const parts = metricStr.split("/");
    const metrics: Record<string, string> = {};

    for (const part of parts) {
        const colonIdx = part.indexOf(":");
        if (colonIdx === -1) return null;
        const key = part.slice(0, colonIdx);
        const value = part.slice(colonIdx + 1);
        metrics[key] = value;
    }

    // Validate required base metrics are present
    const required = ["AV", "AC", "PR", "UI", "S", "C", "I", "A"];
    for (const key of required) {
        if (!metrics[key]) return null;
    }

    return metrics;
}

/**
 * CVSS "round up" function: round to 1 decimal place, always rounding up.
 * This is the specific rounding function defined in the CVSS v3.1 spec.
 */
function roundUp(value: number): number {
    const rounded = Math.round(value * 100000);
    if (rounded % 10000 === 0) {
        return rounded / 100000;
    }
    return (Math.floor(rounded / 10000) + 1) / 10;
}

// ===== Severity Labels =====

/**
 * Map a numeric CVSS score to a severity label.
 */
export function scoreToLabel(score: number): SeverityLabel {
    if (score === 0) return "NONE";
    if (score <= 3.9) return "LOW";
    if (score <= 6.9) return "MEDIUM";
    if (score <= 8.9) return "HIGH";
    return "CRITICAL";
}

/**
 * Map a text severity label to a normalized SeverityLabel. Returns null if
 * unrecognized — and unrecognized includes the publisher's own spellings of
 * "we have not decided yet" (`not yet assigned`, `untriaged`, `unknown`),
 * which must stay unscored rather than be guessed at.
 *
 * Vocabularies folded in, by publisher:
 *   - GHSA / NVD / Bitnami: `LOW | MODERATE | MEDIUM | HIGH | CRITICAL`
 *   - Red Hat, Rocky, Alma, Oracle, SUSE (`database_specific.severity`):
 *     `Low | Moderate | Important | Critical`
 *   - Debian (`affected[].ecosystem_specific.urgency`):
 *     `unimportant | low | medium | high | not yet assigned | end-of-life`
 *   - Ubuntu (`severity[].type = "Ubuntu"` and `database_specific.priority`):
 *     `Negligible | Low | Medium | High | Critical`
 *
 * `unimportant` and `negligible` both mean "real but of no practical security
 * consequence" and map to LOW: the advisory still names an affected version,
 * and LOW is the lowest band that still counts as a finding.
 */
export function normalizeLabel(text: string): SeverityLabel | null {
    const upper = text.toUpperCase().trim();
    switch (upper) {
        case "NONE":
            return "NONE";
        case "LOW":
        case "NEGLIGIBLE":
        case "UNIMPORTANT":
        case "MINOR":
            return "LOW";
        case "MEDIUM":
        case "MODERATE":
            return "MEDIUM";
        case "HIGH":
        case "IMPORTANT":
        case "MAJOR":
            return "HIGH";
        case "CRITICAL":
            return "CRITICAL";
        default:
            return null;
    }
}

const LABEL_RANK: Record<SeverityLabel, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/**
 * The worse of two severities — by score, then by label when scores tie or are
 * missing. Used wherever one record offers several (one per `affected[]`
 * entry): a package that is critical on one release and low on another is a
 * critical finding until the matcher narrows it, because under-reporting is
 * the error that hides work.
 */
function worseOf(a: SeverityInfo | null, b: SeverityInfo | null): SeverityInfo | null {
    if (!a) return b;
    if (!b) return a;
    const scoreA = a.score ?? -1;
    const scoreB = b.score ?? -1;
    if (scoreA !== scoreB) return scoreA > scoreB ? a : b;
    const rankA = a.label ? LABEL_RANK[a.label] : -1;
    const rankB = b.label ? LABEL_RANK[b.label] : -1;
    return rankB > rankA ? b : a;
}

/**
 * Map a normalized severity label to a representative numeric score.
 * Used when we have a label but no vector to compute a precise score.
 */
export function labelToRepresentativeScore(label: SeverityLabel): number {
    switch (label) {
        case "NONE": return 0;
        case "LOW": return 2.0;
        case "MEDIUM": return 5.5;
        case "HIGH": return 7.5;
        case "CRITICAL": return 9.5;
    }
}

// ===== OSV Severity Extraction =====

/** Shape of entries in the OSV `severity` array (record-level or per-affected). */
interface OsvSeverityEntry {
    type: string;
    score: string;
}

/** The slice of an OSV record this module reads. Everything is optional on the wire. */
interface OsvSeverityView {
    id?: string;
    severity?: OsvSeverityEntry[];
    database_specific?: Record<string, unknown>;
    affected?: Array<{
        severity?: OsvSeverityEntry[];
        ecosystem_specific?: Record<string, unknown>;
        database_specific?: Record<string, unknown>;
    }>;
}

/** Keys a publisher may use for a text severity inside a free-form object. */
const TEXT_LABEL_KEYS = ["severity", "urgency", "priority"] as const;

/**
 * Publishers whose CVSS is a constant rather than an assessment, and the
 * vector they stamp. Cleanstart put `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`
 * (9.8) on every record it scored at all — 1,257 of 1,257 on 2026-09-30,
 * where a real source has hundreds of distinct vectors — and left the other
 * 77% unscored. A placeholder is no score: the entry is dropped before the
 * resolution below, so the record parses as unscored and borrows a real
 * score from the other records of its CVE (`severity-fill.ts`), exactly as
 * an honestly unscored record does. Keyed by id prefix; only the placeholder
 * vector is dropped, so a real assessment from the same publisher would
 * count. Matched on the metrics, whatever the `CVSS:3.x/` version prefix.
 */
export const PLACEHOLDER_SCORERS: Readonly<Record<string, readonly string[]>> = {
    CLEANSTART: ["AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"],
};

/** The `severity[]` entries of `id`'s record that are not its publisher's placeholder. */
function withoutPlaceholders(id: unknown, entries: OsvSeverityEntry[] | undefined): OsvSeverityEntry[] | undefined {
    if (!Array.isArray(entries) || typeof id !== "string") return entries;
    const placeholders = PLACEHOLDER_SCORERS[id.split("-")[0]!];
    if (!placeholders) return entries;
    return entries.filter(
        (e) => !(e && typeof e.score === "string" && placeholders.includes(e.score.replace(/^CVSS:\d+(\.\d+)?\//, "")))
    );
}

/**
 * Resolve one OSV `severity[]` array (schema: `{type, score}` entries, type one
 * of `CVSS_V2 | CVSS_V3 | CVSS_V4 | Ubuntu`) to the best severity it states.
 *
 * v3 first: it is what the rest of the platform is calibrated against and what
 * a reader will compare with NVD. v4 next — a v4-only record is scored, not
 * unknown. v2 after that, for the pre-2016 advisories that were never
 * rescored. The `Ubuntu` type is a priority label, not a vector, and ranks
 * with the other text labels.
 */
function severityFromArray(entries: OsvSeverityEntry[] | undefined): SeverityInfo | null {
    if (!Array.isArray(entries)) return null;

    const ofType = (type: string) =>
        entries.filter((s) => s && s.type === type && typeof s.score === "string");

    for (const entry of ofType("CVSS_V3")) {
        const parsed = parseCvssV3(entry.score);
        if (parsed) return { score: parsed.score, label: parsed.label, source: "cvss_v3", vector: parsed.vector };
    }
    for (const entry of ofType("CVSS_V4")) {
        const parsed = parseCvssV4(entry.score);
        if (parsed) return { score: parsed.score, label: parsed.label, source: "cvss_v4", vector: parsed.vector };
    }
    for (const entry of ofType("CVSS_V2")) {
        const parsed = parseCvssV2(entry.score);
        if (parsed) return { score: parsed.score, label: parsed.label, source: "cvss_v2", vector: parsed.vector };
    }
    for (const entry of ofType("Ubuntu")) {
        const label = normalizeLabel(entry.score);
        if (label) return { score: labelToRepresentativeScore(label), label, source: "ubuntu", vector: null };
    }
    return null;
}

/**
 * A text severity label out of a free-form `database_specific` /
 * `ecosystem_specific` object, under any of the keys publishers use.
 */
function severityFromTextLabels(
    obj: Record<string, unknown> | undefined,
    source: "database_specific" | "ecosystem_specific",
): SeverityInfo | null {
    if (!obj || typeof obj !== "object") return null;
    for (const key of TEXT_LABEL_KEYS) {
        const value = obj[key];
        if (typeof value !== "string") continue;
        const label = normalizeLabel(value);
        if (label) return { score: labelToRepresentativeScore(label), label, source, vector: null };
    }
    return null;
}

/**
 * Extract severity information from a raw OSV JSON record.
 *
 * Resolution order — each step is taken only if every earlier one produced
 * nothing, and within a step the worst of several candidates wins:
 *
 * 1. Record-level `severity[]` — CVSS_V3, then CVSS_V4, then CVSS_V2, then
 *    the `Ubuntu` priority label
 * 2. Per-entry `affected[].severity[]`, same resolution, worst entry wins
 * 3. `database_specific.{severity,urgency,priority}` text label
 * 4. `affected[].ecosystem_specific.{severity,urgency,priority}` (Debian's
 *    `urgency` lives here) and `affected[].database_specific`, worst wins
 * 5. Heuristic: MAL-* IDs → CRITICAL (malicious packages)
 * 6. null (no severity available — the record is genuinely unscored)
 *
 * A CVSS vector anywhere beats a text label anywhere: the vector is the
 * publisher's actual assessment, the label is a band — except a publisher's
 * placeholder vector, which is neither and is dropped first
 * (`PLACEHOLDER_SCORERS`).
 */
export function extractSeverity(raw: unknown): SeverityInfo | null {
    if (raw == null || typeof raw !== "object") return null;

    const record = raw as OsvSeverityView;
    const affected = Array.isArray(record.affected) ? record.affected : [];

    // 1. Record-level severity[]
    const recordLevel = severityFromArray(withoutPlaceholders(record.id, record.severity));
    if (recordLevel) return recordLevel;

    // 2. Per-affected severity[]
    let perAffected: SeverityInfo | null = null;
    for (const entry of affected) {
        if (entry && typeof entry === "object") {
            perAffected = worseOf(perAffected, severityFromArray(withoutPlaceholders(record.id, entry.severity)));
        }
    }
    if (perAffected) return perAffected;

    // 3. database_specific text label
    const dbLabel = severityFromTextLabels(record.database_specific, "database_specific");
    if (dbLabel) return dbLabel;

    // 4. Per-affected text labels
    let perAffectedLabel: SeverityInfo | null = null;
    for (const entry of affected) {
        if (!entry || typeof entry !== "object") continue;
        perAffectedLabel = worseOf(
            perAffectedLabel,
            severityFromTextLabels(entry.ecosystem_specific, "ecosystem_specific"),
        );
        perAffectedLabel = worseOf(
            perAffectedLabel,
            severityFromTextLabels(entry.database_specific, "ecosystem_specific"),
        );
    }
    if (perAffectedLabel) return perAffectedLabel;

    // 5. Heuristic: malicious packages are implicitly critical
    if (typeof record.id === "string" && record.id.startsWith("MAL-")) {
        return { score: 9.5, label: "CRITICAL", source: "heuristic", vector: null };
    }

    // 6. No severity information available
    return null;
}
