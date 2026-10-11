/**
 * Parsing the EPSS snapshot.
 *
 * The file is a gzipped CSV with a one-line comment header, then a column
 * header, then ~220k rows:
 *
 * ```
 * #model_version:v2023.03.01,score_date:2026-08-15T00:00:00+0000
 * cve,epss,percentile
 * CVE-2021-44228,0.97571,0.99935
 * ```
 *
 * Parsed as a stream of lines rather than with a CSV library on purpose: three
 * unquoted scalar columns have no escaping to get right, and the alternative is
 * a dependency and a 15 MB string in memory.
 */

/** One scored CVE. */
export interface EpssRow {
    /** Upper-cased, because the join against `vuln_id` and aliases is exact. */
    cve: string;
    /** Probability of exploitation in the next 30 days, 0–1. */
    score: number;
    /** Rank among all scored CVEs, 0–1. */
    percentile: number;
}

export interface EpssParseOutcome {
    /** `score_date` from the comment header, as `YYYY-MM-DD`. Null if absent. */
    scoreDate: string | null;
    /** Model version from the comment header, for the log line. */
    modelVersion: string | null;
    /** Rows that did not parse. Individually skipped; a large count is a signal. */
    malformed: number;
}

/** `#model_version:v2023.03.01,score_date:2026-08-15T00:00:00+0000` */
export function parseHeader(line: string): Pick<EpssParseOutcome, "scoreDate" | "modelVersion"> {
    const fields = new Map<string, string>();
    for (const part of line.replace(/^#/, "").split(",")) {
        const idx = part.indexOf(":");
        if (idx > 0) fields.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
    const rawDate = fields.get("score_date");
    return {
        // Kept as the date portion only. The feed is daily, the time component
        // is always midnight, and a bare `YYYY-MM-DD` is what a human comparing
        // it to today wants to read.
        scoreDate: rawDate ? (rawDate.split("T")[0] ?? null) : null,
        modelVersion: fields.get("model_version") ?? null,
    };
}

const CVE_ID = /^CVE-\d{4}-\d{4,}$/i;

/**
 * Parse one data line. Returns null for anything that is not a usable row —
 * blank lines, the column header, a malformed record.
 *
 * A row whose score or percentile is out of [0, 1] is rejected rather than
 * clamped. The generated `risk_score` column clamps defensively too, but a
 * probability outside its own range means the file is not what we think it is,
 * and silently repairing it would hide that.
 */
export function parseRow(line: string): EpssRow | null {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return null;

    const parts = trimmed.split(",");
    if (parts.length < 3) return null;

    const [rawCve, rawScore, rawPercentile] = parts as [string, string, string];
    if (!CVE_ID.test(rawCve)) return null; // also rejects the `cve,epss,percentile` header

    const score = Number(rawScore);
    const percentile = Number(rawPercentile);
    if (!Number.isFinite(score) || score < 0 || score > 1) return null;
    if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) return null;

    return { cve: rawCve.toUpperCase(), score, percentile };
}
