/**
 * A miniature OSV mirror and the component list that exercises it — shared
 * by the endpoint test and the parity test so both ask the same question.
 *
 * Every case in `db/findings.ts`'s five rules has a representative:
 *
 *   - `openssl` on Alpine: a plain exact match, with EPSS and KEV set so the
 *     generated `risk_score` is non-trivial;
 *   - `libssl3` + `openssl` on Debian 12, one source package reached both
 *     through `upstream=` and directly, plus the DSA that fixes it — four
 *     matcher verdicts, one finding (rules 4 and 5);
 *   - a GHSA and a GO- record for one CVE on a Go module (rule 3);
 *   - an advisory with no ranges and no versions — `unconfirmed` (rule 2);
 *   - a withdrawn advisory;
 *   - a component whose version is already past the fix;
 *   - a component with no purl at all.
 *
 * Match keys are computed with `affectedPackageKey`, exactly as the OSV sync
 * computes them at ingest, so the matcher's lookup is the real one.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../../src/db/schema/index.js";
import { affectedPackageKey } from "../../../src/matching/index.js";
import { withFindingIdentity } from "../../fixtures/seed-data.js";

type Database = PostgresJsDatabase<typeof schema>;

export interface MirrorComponent {
    purl: string | null;
    name: string;
    version: string | null;
}

/** The request, in the order the parity test's SBOM lists them too. */
export const MIRROR_COMPONENTS: MirrorComponent[] = [
    // 0 — Alpine, exact, KEV + EPSS.
    {
        purl: "pkg:apk/alpine/openssl@3.1.4-r5?distro=alpine-3.19.1",
        name: "openssl",
        version: "3.1.4-r5",
    },
    // 1, 2 — one Debian source package, two binaries.
    {
        purl: "pkg:deb/debian/libssl3@3.0.11-1~deb12u2?upstream=openssl&distro=debian-12",
        name: "libssl3",
        version: "3.0.11-1~deb12u2",
    },
    {
        purl: "pkg:deb/debian/openssl@3.0.11-1~deb12u2?distro=debian-12",
        name: "openssl",
        version: "3.0.11-1~deb12u2",
    },
    // 3 — Go module with two advisories for one CVE.
    {
        purl: "pkg:golang/github.com/example/widget@v1.2.3",
        name: "github.com/example/widget",
        version: "v1.2.3",
    },
    // 4 — unconfirmed: the advisory has no bounds to compare against.
    { purl: "pkg:npm/lodash@4.17.21", name: "lodash", version: "4.17.21" },
    // 5 — withdrawn advisory.
    { purl: "pkg:npm/minimist@1.2.5", name: "minimist", version: "1.2.5" },
    // 6 — past the fix.
    { purl: "pkg:npm/express@5.0.0", name: "express", version: "5.0.0" },
    // 7 — no purl.
    { purl: null, name: "mystery-binary", version: "0.1" },
];

export interface SeededMirror {
    /** `vulnerabilities.id` by `vuln_id`. */
    ids: Record<string, string>;
}

export const KEV_LISTED_AT = new Date("2026-08-15T00:00:00.000Z");

/**
 * OSV `published` per seeded record. The GO- record predates the GHSA it
 * shares a CVE with, and the DSA postdates the CVE it folds into, so the
 * endpoint's "earliest across the collapsed set" is observable both ways.
 */
export const PUBLISHED = {
    at: {
        "CVE-2024-0001": new Date("2026-08-01T12:00:00.000Z"),
        "CVE-2024-0002": new Date("2026-08-18T09:30:00.000Z"),
        "DSA-5678-1": new Date("2026-08-20T00:00:00.000Z"),
        "GHSA-aaaa-bbbb-cccc": new Date("2026-07-10T15:00:00.000Z"),
        "GO-2024-0001": new Date("2026-07-01T08:00:00.000Z"),
    } as Record<string, Date>,
};

export async function seedMatchMirror(db: Database): Promise<SeededMirror> {
    const vulns = await db
        .insert(schema.vulnerabilities)
        .values(
            withFindingIdentity([
                {
                    vulnId: "CVE-2024-0001",
                    source: "osv",
                    summary: "openssl: buffer over-read",
                    severityLevel: "high",
                    cvssScore: 7.5,
                    epssScore: 0.5,
                    epssPercentile: 0.97,
                    kevListedAt: KEV_LISTED_AT,
                    publishedAt: PUBLISHED.at["CVE-2024-0001"],
                    aliases: [],
                },
                {
                    vulnId: "CVE-2024-0002",
                    source: "osv",
                    summary: "openssl: timing side channel",
                    severityLevel: "medium",
                    cvssScore: 5.9,
                    epssScore: 0.01,
                    epssPercentile: 0.4,
                    publishedAt: PUBLISHED.at["CVE-2024-0002"],
                    aliases: [],
                },
                {
                    vulnId: "DSA-5678-1",
                    source: "osv",
                    summary: "openssl - security update",
                    severityLevel: "unknown",
                    cvssScore: null,
                    publishedAt: PUBLISHED.at["DSA-5678-1"],
                    aliases: [],
                    related: ["CVE-2024-0002"],
                },
                {
                    vulnId: "GHSA-aaaa-bbbb-cccc",
                    source: "osv",
                    summary: "widget: path traversal",
                    severityLevel: "critical",
                    cvssScore: 9.8,
                    epssScore: 0.2,
                    epssPercentile: 0.9,
                    publishedAt: PUBLISHED.at["GHSA-aaaa-bbbb-cccc"],
                    aliases: ["CVE-2024-0005"],
                },
                {
                    vulnId: "GO-2024-0001",
                    source: "osv",
                    summary: "Path traversal in github.com/example/widget",
                    severityLevel: "unknown",
                    cvssScore: null,
                    publishedAt: PUBLISHED.at["GO-2024-0001"],
                    aliases: ["CVE-2024-0005", "GHSA-aaaa-bbbb-cccc"],
                },
                {
                    vulnId: "CVE-2024-0003",
                    source: "osv",
                    summary: "lodash: prototype pollution (no bounds)",
                    severityLevel: "high",
                    cvssScore: 7.2,
                    aliases: [],
                },
                {
                    vulnId: "CVE-2024-0004",
                    source: "osv",
                    summary: "minimist: withdrawn",
                    severityLevel: "critical",
                    cvssScore: 9.1,
                    aliases: [],
                    withdrawnAt: new Date("2025-01-01T00:00:00.000Z"),
                },
                {
                    vulnId: "CVE-2024-0006",
                    source: "osv",
                    summary: "express: open redirect (fixed long ago)",
                    severityLevel: "medium",
                    cvssScore: 6.1,
                    aliases: [],
                },
            ])
        )
        .returning({ id: schema.vulnerabilities.id, vulnId: schema.vulnerabilities.vulnId });

    const ids: Record<string, string> = {};
    for (const v of vulns) ids[v.vulnId] = v.id;

    const affects = (
        vulnId: string,
        ecosystem: string,
        packageName: string,
        purl: string,
        ranges: schema.OsvRange[],
        fixedVersion: string | null,
        extra: Partial<typeof schema.vulnerabilityAffectedPackages.$inferInsert> = {}
    ): typeof schema.vulnerabilityAffectedPackages.$inferInsert => ({
        vulnerabilityId: ids[vulnId]!,
        ecosystem,
        ecosystemFamily: ecosystem.split(":")[0]!,
        ecosystemRelease: ecosystem.includes(":") ? ecosystem.slice(ecosystem.indexOf(":") + 1) : null,
        packageName,
        purl,
        matchKey: affectedPackageKey(purl, ecosystem, packageName),
        ranges,
        fixedVersion,
        ...extra,
    });

    const eco = (introduced: string, fixed: string): schema.OsvRange[] => [
        { type: "ECOSYSTEM", events: [{ introduced }, { fixed }] },
    ];
    const semver = (introduced: string, fixed: string): schema.OsvRange[] => [
        { type: "SEMVER", events: [{ introduced }, { fixed }] },
    ];

    await db.insert(schema.vulnerabilityAffectedPackages).values([
        affects("CVE-2024-0001", "Alpine:v3.19", "openssl", "pkg:apk/alpine/openssl?arch=source", eco("0", "3.1.5-r0"), "3.1.5-r0"),
        affects("CVE-2024-0002", "Debian:12", "openssl", "pkg:deb/debian/openssl?arch=source", eco("0", "3.0.11-1~deb12u3"), "3.0.11-1~deb12u3"),
        affects("DSA-5678-1", "Debian:12", "openssl", "pkg:deb/debian/openssl?arch=source", eco("0", "3.0.11-1~deb12u3"), "3.0.11-1~deb12u3"),
        affects("GHSA-aaaa-bbbb-cccc", "Go", "github.com/example/widget", "pkg:golang/github.com/example/widget", semver("0", "1.3.0"), "1.3.0"),
        affects("GO-2024-0001", "Go", "github.com/example/widget", "pkg:golang/github.com/example/widget", semver("0", "1.3.0"), "1.3.0"),
        // No ranges, no versions: the matcher can only say "unconfirmed".
        affects("CVE-2024-0003", "npm", "lodash", "pkg:npm/lodash", [], null, { versions: [] }),
        // Withdrawn on both rows, as the OSV sync writes it: the store's
        // partial index hides the affected row, and the service drops the
        // advisory again if one ever slips through.
        affects("CVE-2024-0004", "npm", "minimist", "pkg:npm/minimist", semver("0", "1.2.6"), "1.2.6", { withdrawn: true }),
        affects("CVE-2024-0006", "npm", "express", "pkg:npm/express", semver("0", "4.19.2"), "4.19.2"),
    ]);

    return { ids };
}

/**
 * What the mirror above must produce for `MIRROR_COMPONENTS`, keyed the way
 * the parity test compares: `${purlType}|${packageName}|${findingIdentity}`.
 */
export const EXPECTED_FINDING_KEYS = [
    "apk|openssl|CVE-2024-0001",
    "deb|openssl|CVE-2024-0002",
    "golang|github.com/example/widget|CVE-2024-0005",
].sort();

/** A CycloneDX document carrying `MIRROR_COMPONENTS`, for the ordinary ingest. */
export function mirrorCycloneDx(): Record<string, unknown> {
    return {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: {
            timestamp: "2026-09-01T00:00:00Z",
            component: { type: "container", name: "example/app", version: "1.0.0" },
        },
        components: MIRROR_COMPONENTS.map((c) => ({
            type: "library",
            name: c.name,
            ...(c.version ? { version: c.version } : {}),
            ...(c.purl ? { purl: c.purl } : {}),
        })),
    };
}
