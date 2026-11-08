import { csvDocument } from "./csv.js";
import { fileStem } from "./sbom-filename.js";
import type { FindingExportRow } from "../repositories/vulnerability.repository.js";

/**
 * The findings export: one row per finding — one advisory on one package in
 * one image, the unit the severity cards count — with the columns the
 * vulnerability lists show, so a filtered list and its download never
 * disagree. The row count is the headline findings badge of the view it was
 * downloaded from, under the same filters.
 *
 * Snake-case headers, one word where one will do: this is read by
 * spreadsheets, ticket importers and scripts, not by people choosing a
 * column from a menu. `risk_score` is the finding's own contribution
 * (0–100, ADR 0005), not the advisory's sum. `layer` is the lens bucket —
 * `application`, `base` or `unclassified`, as the Findings menu names it.
 */
export const FINDINGS_CSV_COLUMNS = [
    "vulnerability",
    "severity",
    "cvss",
    "epss",
    "kev",
    "kev_due_date",
    "risk_score",
    "package",
    "installed_version",
    "fixed_version",
    "package_type",
    "layer",
    "cluster",
    "image",
    "digest",
    "namespaces",
    "published",
    "matched_advisory",
    "summary",
] as const;

const BANDS = new Set(["critical", "high", "medium", "low"]);

/** The four bands as the list spells them; anything else the mirror holds is "unscored". */
function severityBand(level: string | null): string {
    const key = level?.toLowerCase() ?? "";
    return BANDS.has(key) ? key : "unscored";
}

/** The Findings menu's words for the lens buckets; `unknown` is "unclassified" there, never a blank. */
function layerOf(bucket: FindingExportRow["bucket"]): string {
    return bucket === "unknown" ? "unclassified" : bucket;
}

/** The purl's scheme word (`npm`, `deb`), the ecosystem mark the list shows beside a package. */
function purlTypeOf(purl: string | null): string | null {
    const match = purl?.match(/^pkg:([A-Za-z0-9.+-]+)\//);
    return match?.[1]?.toLowerCase() ?? null;
}

function isoDate(value: Date | null): string | null {
    return value && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : null;
}

/** `registry/repository`, or whichever half the SBOM recorded. */
export function imageNameOf(registry: string | null, repository: string | null): string {
    return [registry, repository].filter(Boolean).join("/");
}

export function findingsCsv(rows: readonly FindingExportRow[]): string {
    return csvDocument(
        FINDINGS_CSV_COLUMNS,
        rows.map((row) => [
            /* `#` marks an identity that is just its own advisory id — the
               list drops it for display and so does the file. */
            row.identity.replace(/^#/, ""),
            severityBand(row.severityLevel),
            row.cvssScore,
            row.epssScore,
            row.kevListedAt !== null,
            isoDate(row.kevDueDate),
            row.riskScore === null ? null : Math.round(row.riskScore),
            row.packageName,
            row.packageVersion,
            row.fixedVersion,
            purlTypeOf(row.purl),
            layerOf(row.bucket),
            row.clusterName,
            imageNameOf(row.registry, row.repository),
            row.digest,
            row.namespaces.join(";"),
            isoDate(row.publishedAt),
            row.vulnId,
            row.summary,
        ]),
    );
}

/**
 * `stackradar-findings-<scope>-<date>.csv`: the scope the list was over —
 * the organization's slug, a cluster's name, an image's name and digest —
 * and the day it was taken, so two downloads of one view sort by date in a
 * folder and a ticket can say which one it quotes.
 */
export function findingsCsvFilename(scope: string, now: Date = new Date()): string {
    return `stackradar-findings-${fileStem(scope) || "all"}-${now.toISOString().slice(0, 10)}.csv`;
}
