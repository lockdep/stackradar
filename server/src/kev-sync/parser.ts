/**
 * Parsing CISA's Known Exploited Vulnerabilities catalogue.
 *
 * ```json
 * {
 *   "title": "CISA Catalog of Known Exploited Vulnerabilities",
 *   "catalogVersion": "2026.08.15",
 *   "dateReleased": "2026-08-15T14:00:00.0000Z",
 *   "count": 1402,
 *   "vulnerabilities": [
 *     {
 *       "cveID": "CVE-2021-44228",
 *       "vendorProject": "Apache",
 *       "product": "Log4j2",
 *       "dateAdded": "2021-12-10",
 *       "dueDate": "2021-12-24",
 *       "knownRansomwareCampaignUse": "Known",
 *       ...
 *     }
 *   ]
 * }
 * ```
 *
 * Only four fields are kept. The rest — vendor, product, prose description,
 * required action — is a restatement of what the advisory already says, and
 * storing a second copy of it invites the two to disagree. What KEV uniquely
 * knows is *that this is being exploited*, *since when*, and *by ransomware or
 * not*; that is what comes across.
 */

/** One catalogue entry, reduced to what we store. */
export interface KevEntry {
    /** Upper-cased for the exact join against `vuln_id` and aliases. */
    cve: string;
    /** CISA's `dateAdded` — when exploitation was confirmed, not when we synced. */
    dateAdded: Date;
    /** CISA's remediation deadline for federal agencies. Null if absent. */
    dueDate: Date | null;
    /** `"Known"` | `"Unknown"`, verbatim. */
    ransomware: string | null;
}

export interface KevCatalog {
    catalogVersion: string | null;
    releasedAt: Date | null;
    /** CISA's own `count`, for cross-checking against `entries.length`. */
    declaredCount: number | null;
    entries: KevEntry[];
    /** Entries that named no usable CVE or no `dateAdded`. */
    malformed: number;
}

const CVE_ID = /^CVE-\d{4}-\d{4,}$/i;

/** `2021-12-10` or a full ISO timestamp. Returns null for anything else. */
function parseDate(value: unknown): Date | null {
    if (typeof value !== "string" || value.trim() === "") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseCatalog(raw: unknown): KevCatalog {
    if (typeof raw !== "object" || raw === null) {
        throw new Error("KEV feed was not a JSON object");
    }
    const doc = raw as Record<string, unknown>;

    const list = doc.vulnerabilities;
    if (!Array.isArray(list)) {
        throw new Error("KEV feed had no `vulnerabilities` array");
    }

    const entries: KevEntry[] = [];
    let malformed = 0;

    for (const item of list) {
        if (typeof item !== "object" || item === null) {
            malformed++;
            continue;
        }
        const entry = item as Record<string, unknown>;
        const cve = typeof entry.cveID === "string" ? entry.cveID.trim().toUpperCase() : "";
        const dateAdded = parseDate(entry.dateAdded);

        // An entry with no `dateAdded` is dropped rather than defaulted to
        // today. The column is what "listed since" renders from, and a
        // fabricated date would say CISA confirmed exploitation on the day we
        // happened to sync.
        if (!CVE_ID.test(cve) || !dateAdded) {
            malformed++;
            continue;
        }

        const ransomware =
            typeof entry.knownRansomwareCampaignUse === "string"
                ? entry.knownRansomwareCampaignUse.slice(0, 16)
                : null;

        entries.push({ cve, dateAdded, dueDate: parseDate(entry.dueDate), ransomware });
    }

    return {
        catalogVersion: typeof doc.catalogVersion === "string" ? doc.catalogVersion : null,
        releasedAt: parseDate(doc.dateReleased),
        declaredCount: typeof doc.count === "number" ? doc.count : null,
        entries,
        malformed,
    };
}
