/**
 * OSV Data Parsers
 *
 * Parses modified_id.csv and OSV JSON records.
 * Extracts affected package data for the lookup table.
 */

import { PackageURL } from "packageurl-js";
import type { NewVulnerability, NewVulnerabilityAffectedPackage } from "../db/schema/vulnerabilities.js";
import { createLogger } from "../lib/logger.js";
import { findingIdentityOf } from "../lib/vulnerability-aliases.js";
import { validateOsv, formatOsvValidationErrors, type OsvValidationError } from "../validators/osv.validator.js";
import { affectedPackageKey, parseEcosystem, releaseVersion, repairGluedQualifiers } from "../matching/index.js";
import { extractSeverity, type SeverityInfo } from "./cvss.js";

const log = createLogger("osv-sync:parser");

/**
 * Read an OSV record's `withdrawn` field as a timestamp, or `undefined`.
 *
 * Shared by `parseOsvJson` (which writes `vulnerabilities.withdrawn_at`) and
 * `extractAffectedPackages` (which writes the denormalized
 * `vulnerability_affected_packages.withdrawn` flag) so the two cannot disagree
 * about what counts as withdrawn. An unparseable timestamp is treated as *not*
 * withdrawn on both sides — a stale `false` is a false positive, but a `true`
 * that the vulnerability row contradicts is a discrepancy no query would
 * explain.
 */
function readWithdrawn(value: unknown, vulnId: string | undefined): Date | undefined {
    if (typeof value !== "string" || value === "") return undefined;

    const withdrawn = new Date(value);
    if (isNaN(withdrawn.getTime())) {
        log.warn({ vulnId, withdrawn: value }, "Invalid withdrawn timestamp");
        return undefined;
    }

    return withdrawn;
}

/**
 * Entry from modified_id.csv
 * Format: modified_timestamp,path
 * Example: 2024-01-15T10:30:00Z,PyPI/CVE-2024-1234
 */
export interface ModifiedEntry {
    modifiedTimestamp: Date;
    ecosystemDir: string;
    vulnId: string;
    path: string; // original path from CSV
}

/**
 * Parsed OSV JSON record (minimal fields we extract)
 */
export interface ParsedOsvRecord {
    id: string;
    modified: Date;
    published: Date | undefined;
    withdrawn: Date | undefined;
    raw: unknown; // Full JSON object
    rawSha256: Buffer;
    /** Schema validation errors (empty array if valid) */
    validationErrors: OsvValidationError[];
    /** Extracted severity information (null if not available) */
    severity: SeverityInfo | null;
}

/**
 * Parse one `modified_timestamp,path` line. Returns null (with a warning) for
 * anything malformed, including the header row.
 */
function parseModifiedCsvLine(rawLine: string | undefined, lineNumber: number): ModifiedEntry | null {
    const line = rawLine?.trim();
    if (!line) return null;

    // CSV format: timestamp,path
    const commaIndex = line.indexOf(",");
    if (commaIndex === -1) {
        log.warn({ line: lineNumber, content: line }, "Invalid CSV line: no comma found");
        return null;
    }

    const timestampStr = line.slice(0, commaIndex).trim();
    const path = line.slice(commaIndex + 1).trim();

    // Parse path into ecosystem_dir and vuln_id
    // Path format: ecosystem_dir/vuln_id (e.g., "PyPI/PYSEC-2024-1")
    const slashIndex = path.indexOf("/");
    if (slashIndex === -1) {
        log.warn({ line: lineNumber, path }, "Invalid path format: no slash found");
        return null;
    }

    const modifiedTimestamp = new Date(timestampStr);
    if (isNaN(modifiedTimestamp.getTime())) {
        log.warn({ line: lineNumber, timestamp: timestampStr }, "Invalid timestamp");
        return null;
    }

    return {
        modifiedTimestamp,
        ecosystemDir: path.slice(0, slashIndex),
        vulnId: path.slice(slashIndex + 1),
        path,
    };
}

/**
 * How many consecutive below-cutoff lines end the scan. Cheap insurance
 * (50 lines out of 896k) against a single out-of-order entry sitting exactly at
 * the boundary, which is the one place the ordering check cannot otherwise
 * reach.
 */
const STOP_CONFIRMATION_LINES = 50;

export interface ModifiedCsvScan {
    /** Entries at or after the cutoff, in file order (newest first). */
    entries: ModifiedEntry[];
    /** Newest timestamp in the file — the head of it, when sorted as advertised. */
    maxModifiedSeen: Date | null;
    /** Lines that parsed into an entry, whether or not they passed the cutoff. */
    linesParsed: number;
    /** True when the scan stopped at the cutoff instead of reading to EOF. */
    stoppedEarly: boolean;
    /**
     * True when a line was newer than the one before it. The scan then reads to
     * EOF, because the ordering that justifies stopping early no longer holds.
     */
    orderingViolated: boolean;
}

/**
 * Scan `modified_id.csv` line by line, keeping only entries at or after
 * `cutoff`.
 *
 * The file is sorted newest-first and is 896k lines back to 2002, of which a
 * typical hour touches ~220. Parsing all of it to find them costs a few hundred
 * MB of peak heap and 99.98% waste, so this stops at the first line older than
 * the cutoff and abandons the rest of the transfer.
 *
 * The sort order is OSV's implementation detail, not a documented guarantee, so
 * it is *checked* rather than trusted: a single out-of-order line disables the
 * early stop for the rest of the run and the scan degrades to reading the whole
 * file, which is exactly the old behaviour. Entries are still filtered by the
 * cutoff either way, so the result set does not depend on the ordering holding.
 */
export async function scanModifiedCsv(
    lines: AsyncIterable<string>,
    cutoff: Date | null
): Promise<ModifiedCsvScan> {
    const entries: ModifiedEntry[] = [];
    let maxModifiedSeen: Date | null = null;
    let previousTimestamp: Date | null = null;
    let linesParsed = 0;
    let lineNumber = 0;
    let belowCutoffRun = 0;
    let stoppedEarly = false;
    let orderingViolated = false;

    for await (const line of lines) {
        lineNumber++;

        // The header ("modified,path") has no slash in its second field and is
        // dropped by the line parser like any other malformed row.
        const entry = parseModifiedCsvLine(line, lineNumber);
        if (!entry) continue;

        linesParsed++;

        if (!maxModifiedSeen || entry.modifiedTimestamp > maxModifiedSeen) {
            maxModifiedSeen = entry.modifiedTimestamp;
        }

        if (previousTimestamp && entry.modifiedTimestamp > previousTimestamp && !orderingViolated) {
            orderingViolated = true;
            log.warn(
                {
                    line: lineNumber,
                    timestamp: entry.modifiedTimestamp,
                    previousTimestamp,
                },
                "modified_id.csv is not sorted newest-first — falling back to a full scan"
            );
        }
        previousTimestamp = entry.modifiedTimestamp;

        if (cutoff && entry.modifiedTimestamp < cutoff) {
            belowCutoffRun++;
            // Not the *first* line past the cutoff, but a run of them. One
            // straggler at the boundary is the kind of thing a mostly-sorted
            // file has, and it is also the only kind of ordering violation an
            // early-stopping scan could otherwise never see — it would stop on
            // the straggler and never read what sits behind it.
            if (!orderingViolated && belowCutoffRun >= STOP_CONFIRMATION_LINES) {
                stoppedEarly = true;
                break;
            }
            continue;
        }

        belowCutoffRun = 0;
        entries.push(entry);
    }

    return { entries, maxModifiedSeen, linesParsed, stoppedEarly, orderingViolated };
}

/**
 * Parse an OSV JSON record
 *
 * Parses the JSON, validates it against the OSV schema, and extracts
 * key fields. Validation errors are attached to the result as warnings
 * rather than causing rejection, since upstream OSV data may occasionally
 * have minor schema deviations.
 */
export function parseOsvJson(
    rawBytes: Buffer,
    ecosystemDir: string,
    computeSha256: (data: Buffer) => Buffer
): ParsedOsvRecord {
    const raw = JSON.parse(rawBytes.toString("utf8")) as {
        id?: string;
        modified?: string;
        published?: string;
        withdrawn?: string;
    };

    if (!raw.id) {
        throw new Error("OSV record missing 'id' field");
    }

    if (!raw.modified) {
        throw new Error(`OSV record ${raw.id} missing 'modified' field`);
    }

    // Validate against OSV JSON schema
    const validation = validateOsv(raw);
    if (!validation.valid) {
        log.warn(
            {
                vulnId: raw.id,
                ecosystemDir,
                errorCount: validation.errors.length,
                errors: formatOsvValidationErrors(validation.errors),
            },
            "OSV record has schema validation errors"
        );
    }

    const modified = new Date(raw.modified);
    if (isNaN(modified.getTime())) {
        throw new Error(`OSV record ${raw.id} has invalid 'modified' timestamp`);
    }

    let published: Date | undefined;
    if (raw.published) {
        published = new Date(raw.published);
        if (isNaN(published.getTime())) {
            log.warn({ vulnId: raw.id, published: raw.published }, "Invalid published timestamp");
            published = undefined;
        }
    }

    const withdrawn = readWithdrawn(raw.withdrawn, raw.id);

    // Extract severity information from the parsed record
    const severity = extractSeverity(raw);

    return {
        id: raw.id,
        modified,
        published,
        withdrawn,
        raw,
        rawSha256: computeSha256(rawBytes),
        validationErrors: validation.errors,
        severity,
    };
}

/**
 * Deduplicate entries by vulnId, keeping the one with the latest timestamp.
 * When duplicates exist (same vulnId under multiple ecosystem dirs), records
 * which entries were collapsed.
 */
function deduplicateByVulnId(entries: ModifiedEntry[]): {
    candidates: ModifiedEntry[];
    deduplications: { vulnId: string; ecosystemDirs: string[] }[];
} {
    const byVulnId = new Map<string, { entry: ModifiedEntry; ecosystemDirs: string[] }>();

    for (const entry of entries) {
        const existing = byVulnId.get(entry.vulnId);
        if (!existing) {
            byVulnId.set(entry.vulnId, { entry, ecosystemDirs: [entry.ecosystemDir] });
        } else {
            existing.ecosystemDirs.push(entry.ecosystemDir);
            if (entry.modifiedTimestamp > existing.entry.modifiedTimestamp) {
                existing.entry = entry;
            }
        }
    }

    const candidates: ModifiedEntry[] = [];
    const deduplications: { vulnId: string; ecosystemDirs: string[] }[] = [];

    for (const [vulnId, { entry, ecosystemDirs }] of byVulnId) {
        candidates.push(entry);
        if (ecosystemDirs.length > 1) {
            deduplications.push({ vulnId, ecosystemDirs });
        }
    }

    return { candidates, deduplications };
}

/**
 * The oldest `modified` timestamp a run still cares about: the watermark, less
 * the overlap window. Null means "everything" (nothing has been applied yet).
 *
 * Shared by the streaming scan (which stops reading here) and
 * `filterUpdateCandidates` (which filters here) so the two cannot drift into
 * disagreeing about what the run is meant to cover.
 */
export function updateCutoff(lastModifiedApplied: Date | null, overlapMinutes: number): Date | null {
    if (!lastModifiedApplied) return null;
    return new Date(lastModifiedApplied.getTime() - overlapMinutes * 60 * 1000);
}

/**
 * Filter entries that need processing based on the overlap window,
 * then deduplicate by vulnId (same vulnerability cross-listed under
 * multiple ecosystem directories).
 *
 * @param entries All entries from modified_id.csv
 * @param lastModifiedApplied The last timestamp we successfully applied
 * @param overlapMinutes Extra minutes to look back for safety
 * @returns Deduplicated candidates sorted by timestamp, plus dedup details
 */
export function filterUpdateCandidates(
    entries: ModifiedEntry[],
    lastModifiedApplied: Date | null,
    overlapMinutes: number
): { candidates: ModifiedEntry[]; deduplications: { vulnId: string; ecosystemDirs: string[] }[] } {
    const cutoff = updateCutoff(lastModifiedApplied, overlapMinutes);
    const filtered = cutoff
        ? entries.filter((entry) => entry.modifiedTimestamp >= cutoff)
        : [...entries];

    const { candidates, deduplications } = deduplicateByVulnId(filtered);

    // Sort by timestamp ascending (oldest first)
    candidates.sort(
        (a, b) => a.modifiedTimestamp.getTime() - b.modifiedTimestamp.getTime()
    );

    return { candidates, deduplications };
}

/**
 * Extract the ecosystem directory name from a parsed OSV JSON record.
 *
 * Uses the first `affected[].package.ecosystem` value and strips any
 * version suffix (e.g. "AlmaLinux:8" → "AlmaLinux", "Debian:11" → "Debian").
 * Falls back to the vulnerability ID prefix when no affected package exists.
 *
 * Returns "" if the ecosystem cannot be determined.
 */
export function extractEcosystemDir(raw: unknown): string {
    if (raw == null || typeof raw !== "object") {
        return "";
    }

    const record = raw as {
        id?: string;
        affected?: Array<{ package?: { ecosystem?: string } }>;
    };

    // Try affected[].package.ecosystem first
    const ecosystem = record.affected?.[0]?.package?.ecosystem;
    if (ecosystem) {
        // Strip version suffix: "AlmaLinux:8" → "AlmaLinux"
        const colonIdx = ecosystem.indexOf(":");
        return colonIdx !== -1 ? ecosystem.slice(0, colonIdx) : ecosystem;
    }

    return "";
}

// ===== Affected Package Extraction =====

/**
 * Shape of the affected[] entries inside an OSV JSON record
 */
interface OsvAffectedEntry {
    package?: {
        ecosystem?: string;
        name?: string;
        purl?: string;
    };
    ranges?: Array<{
        type: string;
        repo?: string;
        events: Array<Record<string, string>>;
        database_specific?: Record<string, unknown>;
    }>;
    versions?: string[];
    /** Per-entry severity — same shape as the record-level array. Read by `extractSeverity`. */
    severity?: Array<{ type: string; score: string }>;
    /** Publisher-defined. Debian puts `urgency` here. Read by `extractSeverity`. */
    ecosystem_specific?: Record<string, unknown>;
    database_specific?: Record<string, unknown>;
}

/**
 * Strip version, qualifiers, and subpath from a PURL to get the base PURL.
 * e.g. "pkg:npm/%40angular/core@16.0.0" -> "pkg:npm/%40angular/core"
 *
 * Uses packageurl-js for proper parsing; falls back to regex on parse failure.
 */
export function toBasePurl(purl: string): string {
    // osv.dev's SUSE purls glue their qualifier onto the name with `&`; read
    // literally, the stored base purl would carry the whole distro string as
    // part of the package name (`identity.ts#repairGluedQualifiers`).
    purl = repairGluedQualifiers(purl);
    try {
        const parsed = PackageURL.fromString(purl);
        return new PackageURL(
            parsed.type,
            parsed.namespace,
            parsed.name,
            null, // no version
            null, // no qualifiers
            null  // no subpath
        ).toString();
    } catch {
        // Fallback: strip everything after @ or ? or #
        return purl.replace(/[@?#].*$/, "");
    }
}

/**
 * Extract the first "fixed" version from OSV range events.
 *
 * GIT ranges are skipped. Their bounds are commit hashes, not versions, so a
 * `fixed` read out of one is a 40-char SHA in a column the UI renders as
 * "fixed in <version>" — and because PYSEC advisories conventionally list the
 * GIT range *before* the ECOSYSTEM range, the hash was winning over the real
 * answer rather than merely filling in for a missing one. `matching/ranges.ts`
 * already drops GIT ranges for the same reason; this is the one place that
 * still read them.
 */
function extractFirstFixedVersion(
    ranges?: OsvAffectedEntry["ranges"]
): string | null {
    if (!ranges) return null;
    for (const range of ranges) {
        if (range.type === "GIT") continue;
        for (const event of range.events) {
            if (event.fixed) return event.fixed;
        }
    }
    return null;
}

/**
 * Extract affected packages from a raw OSV JSON record into rows
 * suitable for the vulnerability_affected_packages lookup table.
 *
 * @param vulnerabilityId  The internal UUID of the parent vulnerability row
 * @param raw              The full OSV JSON record
 * @returns Array of NewVulnerabilityAffectedPackage rows (may be empty)
 */
export function extractAffectedPackages(
    vulnerabilityId: string,
    raw: unknown
): NewVulnerabilityAffectedPackage[] {
    if (raw == null || typeof raw !== "object") return [];

    const record = raw as { id?: string; affected?: OsvAffectedEntry[]; withdrawn?: unknown };
    if (!Array.isArray(record.affected)) return [];

    // Record-level, so it is read once and stamped onto every row this record
    // produces. Derived here rather than passed in by the caller: both sync
    // paths already hand us the full OSV record, and deriving it at extract
    // time is what makes a withdrawal propagate for free when
    // `replaceForVulns` re-inserts the rows of a changed advisory.
    const withdrawn = readWithdrawn(record.withdrawn, record.id) !== undefined;

    const rows: NewVulnerabilityAffectedPackage[] = [];

    for (const entry of record.affected) {
        const pkgName = entry.package?.name;
        if (!pkgName) continue;

        const pkg = entry.package!;

        const basePurl = pkg.purl ? toBasePurl(pkg.purl) : null;

        const ecosystem = pkg.ecosystem ?? null;
        const parsedEcosystem = parseEcosystem(ecosystem);

        rows.push({
            vulnerabilityId,
            ecosystem,
            ecosystemFamily: parsedEcosystem?.family ?? null,
            ecosystemRelease: parsedEcosystem?.release ?? null,
            // The distro version inside the release, by the same function
            // the matcher scopes with — written here, not derived in SQL, so
            // the two sides cannot drift. Null for language ecosystems and
            // for releases that name no version. `scripts/backfill-release-version.ts`
            // fills rows that predate the column.
            releaseVersion: releaseVersion(parsedEcosystem?.release),
            packageName: pkgName,
            purl: basePurl,
            // From the *original* purl, qualifiers included — `canonicalKey`
            // strips them itself, and `toBasePurl` has already dropped the
            // `?arch=source` that OSV's distro purls carry.
            matchKey: affectedPackageKey(pkg.purl, ecosystem, pkgName),
            withdrawn,
            versions: entry.versions ?? null,
            ranges: (entry.ranges as NewVulnerabilityAffectedPackage["ranges"]) ?? null,
            fixedVersion: extractFirstFixedVersion(entry.ranges) ?? null,
        });
    }

    return rows;
}

/**
 * Convert a ParsedOsvRecord into a NewVulnerability row ready for upsert.
 * Used by the OSV sync bootstrap and incremental processes.
 */
export function convertOsvRecordToVulnerability(record: ParsedOsvRecord): NewVulnerability {
    const severityLevel = record.severity?.label?.toLowerCase() ?? "unknown";
    const raw = record.raw as Record<string, unknown>;
    const aliases = (raw.aliases as string[] | undefined) ?? [];
    // OSV `upstream`: the ids this record was derived from — for a distro
    // tracker entry (`UBUNTU-CVE-…`) the one CVE it tracks. Read for the
    // identity only; not stored as a column, `raw_data` keeps it.
    const upstream = (raw.upstream as string[] | undefined) ?? [];

    return {
        vulnId: record.id,
        schemaVersion: (raw.schema_version as string | undefined) ?? "1.0.0",
        source: "osv",
        sourceUrl: `https://osv.dev/vulnerability/${record.id}`,
        summary: ((raw.summary as string | undefined) ?? null)?.slice(0, 512) ?? null,
        details: (raw.details as string | undefined) ?? null,
        severity: (raw.severity as NewVulnerability["severity"]) ?? [],
        severityLevel,
        cvssScore: record.severity?.score ?? null,
        aliases,
        // The cross-image collapse key, computed here for the same reason
        // `ecosystem_family` is computed in `extractAffectedPackages`: it is a
        // pure function of fields this record carries, and stamping it at
        // ingest means every rewrite of the advisory recomputes it — see the
        // column comment in `db/schema/vulnerabilities.ts`.
        findingIdentity: findingIdentityOf(record.id, aliases, upstream),
        related: (raw.related as string[] | undefined) ?? [],
        references: (raw.references as NewVulnerability["references"]) ?? [],
        credits: (raw.credits as NewVulnerability["credits"]) ?? [],
        databaseSpecific: (raw.database_specific as Record<string, unknown> | undefined) ?? null,
        publishedAt: record.published ?? null,
        modifiedAt: record.modified,
        withdrawnAt: record.withdrawn ?? null,
        rawData: raw,
        rawHash: record.rawSha256,
    };
}
