/**
 * `POST /internal/match` — the product's matcher as a stateless function.
 *
 * The charts index (`charts/`) sends an image's components and gets back the
 * findings the product would show for that image: the same matcher, the same
 * five rules for what counts (`db/findings.ts`), the same collapse
 * (`lib/vulnerability-aliases.ts`), the same generated risk column. Nothing is
 * written. The server learns nothing about charts, images or history from
 * this call — it answers one pure question over its own mirror.
 *
 * The parity that matters is with `collapsedFindings`, the SQL rendering of
 * the rules every product surface reads. This module reaches the same answer
 * from the matcher's in-memory verdicts instead of stored
 * `component_vulnerabilities` rows, and `tests/integration/match/parity.test.ts`
 * holds the two together: ingest an SBOM the ordinary way, scan it, and the
 * endpoint must return the same `(purlType, packageName, findingIdentity)` set
 * with the same risk, fixed version and KEV date per key. If that test ever
 * fails, this module is wrong, not the product.
 */

import { inArray, sql } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { countsAsFinding } from "../db/findings.js";
import { vulnerabilities } from "../db/schema/vulnerabilities.js";
import { osvSyncState } from "../db/schema/osv-mirror.js";
import { epssSyncState, kevSyncState } from "../db/schema/threat-intel.js";
import { collapseAliases, type AliasCollapsible } from "../lib/vulnerability-aliases.js";
import { SERVER_VERSION } from "../lib/server-version.js";
import {
    createDrizzleCandidateStore,
    createMatcher,
    isDistroPurlType,
    parsePurl,
} from "../matching/index.js";
import type { Matcher, MatchConfidence } from "../matching/index.js";
import type { VulnMatch } from "../matching/match.js";
import type { MatchRequestComponent } from "../schemas/match.schema.js";
import { assertMirrorReadable, OsvMirrorNotReadyError } from "./vulnerability-sync.service.js";
import { AppError } from "../middleware/error-handler.js";

// ===== Response shape (the contract; see docs/contracts/match-endpoint.json) =====

export type MatchSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface MatchFinding {
    /** Index into the request's `components` — the primary of the collapsed set. */
    component: number;
    vulnId: string;
    findingIdentity: string;
    /** Every other id this finding is known by: OSV aliases of the set, plus the folded advisories' own ids. */
    aliases: string[];
    summary: string | null;
    severityLevel: MatchSeverity;
    cvssScore: number | null;
    epssScore: number | null;
    epssPercentile: number | null;
    kevListedAt: string | null;
    /** OSV `published`, the earliest across the collapsed set's records; null when none carries one. */
    publishedAt: string | null;
    /** `vulnerabilities.risk_score`, the generated column. Never recomputed by a caller. */
    risk: number;
    /** The source package for deb / rpm / apk; the component's name otherwise. */
    packageName: string;
    packageVersion: string | null;
    purl: string | null;
    purlType: string | null;
    fixedVersion: string | null;
    confidence: Exclude<MatchConfidence, "unconfirmed">;
}

export interface MatchResponse {
    serverVersion: string;
    matchedAt: string;
    sync: {
        osvSyncedAt: string | null;
        epssScoreDate: string | null;
        kevCatalogVersion: string | null;
    };
    findings: MatchFinding[];
}

// ===== Internals =====

/**
 * Components per matcher round-trip. The scan job uses 50 because it writes
 * links per batch; here nothing is written and the only cost is the size of
 * the `match_key IN (…)` list, so batches are larger — but still bounded, so
 * a 20,000-component request never becomes a 40,000-parameter statement.
 */
const MATCH_BATCH = 500;

/** Advisory ids per `vulnerabilities` lookup. */
const VULN_BATCH = 1_000;

let _matcher: Matcher | null = null;

function getMatcher(): Matcher {
    if (!_matcher) {
        _matcher = createMatcher(
            createDrizzleCandidateStore(db, { maxCandidatesPerKey: config.match.maxCandidatesPerKey })
        );
    }
    return _matcher;
}

type AdvisoryRow = {
    id: string;
    vulnId: string;
    summary: string | null;
    severityLevel: string | null;
    cvssScore: number | null;
    epssScore: number | null;
    epssPercentile: number | null;
    kevListedAt: Date | null;
    publishedAt: Date | null;
    riskScore: number | null;
    aliases: string[] | null;
    related: string[] | null;
    findingIdentity: string | null;
    withdrawnAt: Date | null;
};

/**
 * One counted match, in the shape `collapseAliases` reads plus what the
 * response needs from it afterwards. `componentId` is the component's index
 * as a string — `collapseAliases` only ever compares ids for equality and
 * uses them as a final tie-breaker, so the synthetic id needs no shim.
 */
type Row = AliasCollapsible & {
    index: number;
    advisory: AdvisoryRow;
    confidence: Exclude<MatchConfidence, "unconfirmed">;
    /** Rule 4's package name, computed from the row's own fields before collapsing. */
    packageName: string;
    purlType: string | null;
    packageVersion: string | null;
};

const SEVERITIES: ReadonlySet<MatchSeverity> = new Set(["critical", "high", "medium", "low", "unknown"]);

function severityOf(level: string | null): MatchSeverity {
    const lower = (level ?? "").toLowerCase();
    return SEVERITIES.has(lower as MatchSeverity) ? (lower as MatchSeverity) : "unknown";
}

/**
 * Rule 4's package name — the TypeScript twin of `findingPackageName` in
 * `db/findings.ts`, over the same three inputs in the same order: the
 * upstream the matcher went through, else the purl's own `upstream=`, else
 * the component's name. Only for the distro purl types; everything else is
 * the component.
 */
function findingPackageNameOf(
    purlType: string | null,
    componentName: string,
    purlUpstreamName: string | null,
    matchUpstreamName: string | null
): string {
    if (!isDistroPurlType(purlType)) return componentName;
    return matchUpstreamName ?? purlUpstreamName ?? componentName;
}

async function advisoriesById(ids: string[]): Promise<Map<string, AdvisoryRow>> {
    const out = new Map<string, AdvisoryRow>();
    for (let i = 0; i < ids.length; i += VULN_BATCH) {
        const rows = await db
            .select({
                id: vulnerabilities.id,
                vulnId: vulnerabilities.vulnId,
                summary: vulnerabilities.summary,
                severityLevel: vulnerabilities.severityLevel,
                cvssScore: vulnerabilities.cvssScore,
                epssScore: vulnerabilities.epssScore,
                epssPercentile: vulnerabilities.epssPercentile,
                kevListedAt: vulnerabilities.kevListedAt,
                publishedAt: vulnerabilities.publishedAt,
                riskScore: vulnerabilities.riskScore,
                aliases: vulnerabilities.aliases,
                related: vulnerabilities.related,
                findingIdentity: vulnerabilities.findingIdentity,
                withdrawnAt: vulnerabilities.withdrawnAt,
            })
            .from(vulnerabilities)
            .where(inArray(vulnerabilities.id, ids.slice(i, i + VULN_BATCH)));
        for (const row of rows) out.set(row.id, row);
    }
    return out;
}

/**
 * The three sync watermarks in one round-trip. Each is a scalar subquery so
 * an absent state row (a fresh database) reads as null rather than as an
 * empty result set.
 *
 * `osvSyncedAt` is the most recent of the incremental poll, the full refresh
 * and the initial import: whichever last brought the mirror up to date.
 */
async function syncState(): Promise<MatchResponse["sync"]> {
    const [row] = await db.execute<{
        osv_synced_at: string | Date | null;
        epss_score_date: string | null;
        kev_catalog_version: string | null;
    }>(sql`
        SELECT
            (SELECT greatest(
                        ${osvSyncState.lastSuccessfulPollAt},
                        ${osvSyncState.lastFullRefreshAt},
                        ${osvSyncState.initCompletedAt})
               FROM ${osvSyncState} WHERE ${osvSyncState.id} = 1) AS osv_synced_at,
            (SELECT ${epssSyncState.lastScoreDate} FROM ${epssSyncState} WHERE ${epssSyncState.id} = 1) AS epss_score_date,
            (SELECT ${kevSyncState.catalogVersion} FROM ${kevSyncState} WHERE ${kevSyncState.id} = 1) AS kev_catalog_version
    `);
    return {
        osvSyncedAt: row?.osv_synced_at ? new Date(row.osv_synced_at).toISOString() : null,
        epssScoreDate: row?.epss_score_date ?? null,
        kevCatalogVersion: row?.kev_catalog_version ?? null,
    };
}

// ===== The service =====

/**
 * The findings the product would report for `components`, collapsed and
 * counted by its rules, with nothing stored.
 *
 *   1. Refuse while the mirror has never finished a build — the scan job's
 *      gate, for the scan job's reason.
 *   2. Run the matcher; keep only the verdicts that count (rule 2).
 *   3. Read the matched advisories once; drop withdrawn ones.
 *   4. Collapse (rules 3–5) with `collapseAliases`, the rendering the
 *      workload page uses; the fixed version comes out of the same pass.
 *   5. Sort by risk, then id, then package — a total order, so two calls
 *      with the same input return the same list.
 */
export async function matchComponents(
    components: readonly MatchRequestComponent[]
): Promise<MatchResponse> {
    // Only the mirror's own "not yet" becomes the contract's 503; a database
    // that cannot be reached is an ordinary failure and reports as one.
    try {
        await assertMirrorReadable();
    } catch (error) {
        if (error instanceof OsvMirrorNotReadyError) {
            throw new AppError(503, "matching_unavailable");
        }
        throw error;
    }

    const matcher = getMatcher();
    const inputs = components.map((c, index) => ({
        id: String(index),
        purl: c.purl ?? null,
        name: c.name,
        version: c.version ?? null,
    }));

    const counted: { index: number; match: VulnMatch }[] = [];
    for (let i = 0; i < inputs.length; i += MATCH_BATCH) {
        const batch = inputs.slice(i, i + MATCH_BATCH);
        const matchMap = await matcher.findVulnerabilitiesBatch(batch);
        for (const input of batch) {
            for (const match of matchMap.get(input.id) ?? []) {
                if (countsAsFinding(match.confidence)) {
                    counted.push({ index: Number(input.id), match });
                }
            }
        }
    }

    const advisories = await advisoriesById([...new Set(counted.map((c) => c.match.vulnerabilityId))]);

    const rows: Row[] = [];
    for (const { index, match } of counted) {
        const advisory = advisories.get(match.vulnerabilityId);
        // Withdrawn between the store's read and this one, or a row the store
        // should never have returned: either way, not a finding.
        if (!advisory || advisory.withdrawnAt !== null) continue;

        const component = components[index]!;
        const purl = component.purl ?? null;
        const identity = parsePurl(purl);
        const purlType = identity?.type ?? null;
        const upstreamName = match.upstream?.name ?? null;

        rows.push({
            index,
            advisory,
            confidence: match.confidence as Exclude<MatchConfidence, "unconfirmed">,
            purlType,
            packageName: findingPackageNameOf(
                purlType,
                component.name,
                identity?.upstream?.name ?? null,
                upstreamName
            ),
            packageVersion: component.version ?? identity?.version ?? null,
            // The `AliasCollapsible` half.
            vulnId: advisory.vulnId,
            aliases: advisory.aliases,
            related: advisory.related,
            findingIdentity: advisory.findingIdentity,
            componentId: String(index),
            componentName: component.name,
            componentPurl: purl,
            cvssScore: advisory.cvssScore,
            severityLevel: advisory.severityLevel,
            summary: advisory.summary,
            fixedVersion: match.fixedVersion,
            upstreamName,
        });
    }

    const aliasesOf = new Map<string, string[]>();
    const publishedOf = new Map<string, Date | null>();
    for (const row of rows) {
        aliasesOf.set(row.vulnId, row.aliases ?? []);
        publishedOf.set(row.vulnId, row.advisory.publishedAt);
    }

    const findings: MatchFinding[] = collapseAliases(rows).map((c) => {
        // Every id the collapsed set is known by, except the one it is shown as.
        const known = new Set<string>();
        for (const id of [c.vulnId, ...c.aliasIds]) {
            known.add(id);
            for (const alias of aliasesOf.get(id) ?? []) known.add(alias);
        }
        known.delete(c.vulnId);

        // The earliest `published` of the primary and every record folded into
        // it: when the vulnerability became public, not when one distribution's
        // notice did.
        let publishedAt: Date | null = null;
        for (const id of [c.vulnId, ...c.aliasIds]) {
            const at = publishedOf.get(id) ?? null;
            if (at && (!publishedAt || at < publishedAt)) publishedAt = at;
        }

        return {
            component: c.index,
            vulnId: c.vulnId,
            findingIdentity: c.findingIdentity ?? c.vulnId,
            aliases: [...known].sort(),
            summary: c.summary,
            severityLevel: severityOf(c.severityLevel),
            cvssScore: c.cvssScore,
            epssScore: c.advisory.epssScore,
            epssPercentile: c.advisory.epssPercentile,
            kevListedAt: c.advisory.kevListedAt?.toISOString() ?? null,
            publishedAt: publishedAt?.toISOString() ?? null,
            risk: c.advisory.riskScore ?? 0,
            packageName: c.packageName,
            packageVersion: c.packageVersion,
            purl: c.componentPurl,
            purlType: c.purlType,
            fixedVersion: c.fixedVersion,
            confidence: c.confidence,
        };
    });

    findings.sort(
        (a, b) =>
            b.risk - a.risk ||
            (a.vulnId < b.vulnId ? -1 : a.vulnId > b.vulnId ? 1 : 0) ||
            (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0) ||
            a.component - b.component
    );

    return {
        serverVersion: SERVER_VERSION,
        matchedAt: new Date().toISOString(),
        sync: await syncState(),
        findings,
    };
}
