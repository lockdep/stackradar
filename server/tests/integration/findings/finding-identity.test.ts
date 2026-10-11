/**
 * The collapse rule, checked across its three renderings.
 *
 * Which advisories are the same vulnerability is decided in one place —
 * `findingIdentityOf` in `lib/vulnerability-aliases.ts` — but its answer lives
 * in three: the TypeScript read path (`collapseAliases` via
 * `normalizedCveIdentity`), the stored `vulnerabilities.finding_identity`
 * column the counting surfaces read, and the SQL derivation the column
 * replaced, which the backfill migration still uses for pre-existing rows.
 * Three copies of a rule drift. This test is what stops them:
 *
 *   1. every case from `normalizedCveIdentity`'s own unit tests is replayed
 *      through the old SQL derivation (kept below as the oracle — it exists
 *      nowhere else in production code) and the answers must match;
 *   2. each case is then pushed through the real sync write path
 *      (`parseOsvJson → convertOsvRecordToVulnerability → bulkUpsertFromSync`)
 *      and the *stored* column must say the same thing;
 *   3. an incremental update that changes an advisory's aliases must rewrite
 *      the stored identity — the "mirror rewrite is the recomputation"
 *      property the materialisation depends on.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import { findingIdentityOf } from "../../../src/lib/vulnerability-aliases.js";

const CASES: { vulnId: string; aliases: string[] | null; upstream?: string[]; why: string }[] = [
    { vulnId: "CVE-2024-1234", aliases: ["GHSA-aaaa-bbbb-cccc"], why: "a CVE record is its own identity" },
    { vulnId: "GHSA-aaaa-bbbb-cccc", aliases: ["CVE-2024-1234"], why: "one named CVE becomes the identity" },
    { vulnId: "GO-2024-0001", aliases: ["cve-2024-1234"], why: "a lower-case alias still matches" },
    { vulnId: "GHSA-x", aliases: ["CVE-2024-1234", "cve-2024-1234"], why: "a repeated alias is not ambiguity" },
    { vulnId: "GHSA-dddd-eeee-ffff", aliases: ["GO-2024-0001"], why: "no CVE named: the GHSA is its own identity" },
    { vulnId: "GO-2024-0002", aliases: null, why: "no aliases at all" },
    { vulnId: "DSA-5678-1", aliases: ["CVE-2024-1111", "CVE-2024-2222"], why: "several CVEs must not bridge them" },
    { vulnId: "CVE-2024-99999", aliases: null, why: "a five-digit CVE sequence" },
    { vulnId: "MAL-2024-0001", aliases: ["CVE-24-1"], why: "a malformed CVE is not a CVE" },
    // `upstream`: where a distro tracker entry names its CVE, and where a
    // security notice lists every CVE it fixes.
    {
        vulnId: "UBUNTU-CVE-2026-4046",
        aliases: null,
        upstream: ["CVE-2026-4046"],
        why: "a tracker entry's upstream CVE is its identity",
    },
    {
        vulnId: "USN-8611-1",
        aliases: null,
        upstream: ["CVE-2026-4046", "CVE-2026-4437", "UBUNTU-CVE-2026-4046"],
        why: "a notice's several upstream CVEs must not bridge them",
    },
    {
        vulnId: "RLSA-2026:1234",
        aliases: ["CVE-2026-4046"],
        upstream: ["cve-2026-4046"],
        why: "one CVE under both fields is one identity",
    },
    {
        vulnId: "USN-8436-1",
        aliases: null,
        upstream: ["UBUNTU-CVE-2026-0001"],
        why: "an upstream that is not a CVE names nothing",
    },
    // No CVE anywhere: the one GHSA in the group stands in for it.
    {
        vulnId: "GO-2026-6061",
        aliases: ["GHSA-hrxh-6v49-42gf"],
        why: "a no-CVE record takes its GHSA alias's identity",
    },
    {
        vulnId: "GHSA-hrxh-6v49-42gf",
        aliases: ["GO-2026-6061"],
        why: "and the GHSA reaches the same one from its own id",
    },
    { vulnId: "RUSTSEC-2026-0001", aliases: ["GHSA-QQQQ-RRRR-SSSS"], why: "an upper-cased GHSA is stored canonically" },
    {
        vulnId: "ECHO-2026-0001",
        aliases: null,
        upstream: ["GHSA-tttt-uuuu-vvvv"],
        why: "a GHSA under upstream counts too",
    },
    {
        vulnId: "MAL-2026-0001",
        aliases: ["GHSA-wwww-xxxx-yyyy", "GHSA-zzzz-2222-3333"],
        why: "two GHSAs is ambiguity, and stands alone",
    },
    {
        vulnId: "GO-2022-0197",
        aliases: ["CVE-2018-17847", "CVE-2018-17848", "GHSA-4r78-hx75-jjj2"],
        why: "several CVEs never merge through a GHSA",
    },
    { vulnId: "PYSEC-2026-0001", aliases: ["GHSA-bad"], why: "a malformed GHSA is not a GHSA" },
];

/** `CVE-2024-1234` — the same shape `lib/vulnerability-aliases.ts` matches. */
const CVE_PATTERN = "^CVE-[0-9]{4}-[0-9]{4,}$";
/** `GHSA-hrxh-6v49-42gf` — likewise. */
const GHSA_PATTERN = "^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$";

/** OSV `upstream` off `raw_data`, or an empty list. */
const upstreamRefs: SQL = sql`CASE WHEN jsonb_typeof(${schema.vulnerabilities.rawData} -> 'upstream') = 'array'
                            THEN ${schema.vulnerabilities.rawData} -> 'upstream'
                            ELSE '[]'::jsonb
                       END`;

/**
 * The derivation `finding_identity` replaced, verbatim — the oracle.
 *
 * This is what `db/findings.ts#findingIdentity` used to compute per finding
 * row, and what the backfill migrations (the original, and
 * `0003_finding_identity_upstream` which added `raw_data->'upstream'` to the
 * scan, and `0024_finding_identity_ghsa` which added the sole-GHSA fall-through)
 * ran once per advisory. It must keep agreeing with `findingIdentityOf`:
 * distinct-count on the alias scan because the TypeScript gathers CVEs into a
 * `Set` before asking whether there is exactly one, `upper()` because the Set
 * is of upper-cased ids, and `#` on the fall-through to keep non-CVE ids out
 * of the CVE key space. The GHSA half is `soleGhsaIdentity`: no CVE anywhere,
 * exactly one GHSA among the record's own id, aliases and upstream, stored
 * with its suffix lower-cased.
 */
const oracleIdentity: SQL<string> = sql<string>`
    CASE
        WHEN ${schema.vulnerabilities.vulnId} ~* ${CVE_PATTERN}
            THEN upper(${schema.vulnerabilities.vulnId})
        ELSE coalesce(
            (
                SELECT CASE WHEN count(DISTINCT upper(alias)) = 1
                            THEN min(upper(alias)) END
                FROM jsonb_array_elements_text(
                    coalesce(${schema.vulnerabilities.aliases}, '[]'::jsonb) || ${upstreamRefs}
                ) AS t(alias)
                WHERE alias ~* ${CVE_PATTERN}
            ),
            '#' || coalesce(
                (
                    SELECT CASE WHEN bool_or(ref ~* ${CVE_PATTERN}) THEN NULL
                                WHEN count(DISTINCT lower(ref)) FILTER (WHERE ref ~* ${GHSA_PATTERN}) = 1
                                THEN 'GHSA-' || substr(min(lower(ref)) FILTER (WHERE ref ~* ${GHSA_PATTERN}), 6)
                           END
                    FROM jsonb_array_elements_text(
                        jsonb_build_array(${schema.vulnerabilities.vulnId})
                        || coalesce(${schema.vulnerabilities.aliases}, '[]'::jsonb)
                        || ${upstreamRefs}
                    ) AS t(ref)
                ),
                ${schema.vulnerabilities.vulnId}
            )
        )
    END
`;

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest();

/** A minimal OSV record for `vulnId`, serialised the way a zip entry arrives. */
function osvRecordBytes(
    vulnId: string,
    aliases: string[] | null,
    modified = "2026-01-01T00:00:00Z",
    upstream?: string[],
): Buffer {
    return Buffer.from(
        JSON.stringify({
            id: vulnId,
            modified,
            ...(aliases ? { aliases } : {}),
            ...(upstream ? { upstream } : {}),
        }),
    );
}

describe("finding identity: stored column, TypeScript rule and SQL oracle agree", () => {
    let db: (typeof import("../../../src/db/index.js"))["db"];
    let syncWrite: (vulnId: string, aliases: string[] | null, modified?: string, upstream?: string[]) => Promise<void>;

    beforeAll(async () => {
        db = (await import("../../../src/db/index.js")).db;
        const { parseOsvJson, convertOsvRecordToVulnerability } = await import("../../../src/osv-sync/parser.js");
        const { vulnerabilityMirrorRepository } =
            await import("../../../src/repositories/vulnerability-mirror.repository.js");

        // The real write path, end to end: parse the record as the sync
        // worker would, convert it, upsert it. Nothing here sets
        // `findingIdentity` by hand — the point is that the path does.
        syncWrite = async (vulnId, aliases, modified, upstream) => {
            const record = parseOsvJson(osvRecordBytes(vulnId, aliases, modified, upstream), "test", sha256);
            await vulnerabilityMirrorRepository.bulkUpsertFromSync([convertOsvRecordToVulnerability(record)]);
        };
    });

    beforeEach(async () => {
        await cleanAllData();
    });

    describe("the oracle still matches findingIdentityOf", () => {
        beforeEach(async () => {
            await getTestDb()
                .insert(schema.vulnerabilities)
                .values(
                    CASES.map((c) => ({
                        vulnId: c.vulnId,
                        source: "osv",
                        aliases: c.aliases,
                        rawData: c.upstream ? { upstream: c.upstream } : null,
                    })),
                );
        });

        for (const testCase of CASES) {
            it(`agrees on ${testCase.vulnId}: ${testCase.why}`, async () => {
                const expected = findingIdentityOf(testCase.vulnId, testCase.aliases, testCase.upstream);

                const [row] = await db
                    .select({ identity: oracleIdentity })
                    .from(schema.vulnerabilities)
                    .where(eq(schema.vulnerabilities.vulnId, testCase.vulnId));

                expect(row!.identity).toBe(expected);
            });
        }
    });

    describe("the sync write path stores what the oracle derives", () => {
        for (const testCase of CASES) {
            it(`stores it for ${testCase.vulnId}: ${testCase.why}`, async () => {
                await syncWrite(testCase.vulnId, testCase.aliases, undefined, testCase.upstream);

                const [row] = await db
                    .select({
                        stored: schema.vulnerabilities.findingIdentity,
                        oracle: oracleIdentity,
                    })
                    .from(schema.vulnerabilities)
                    .where(eq(schema.vulnerabilities.vulnId, testCase.vulnId));

                expect(row!.stored).toBe(row!.oracle);
                expect(row!.stored).toBe(findingIdentityOf(testCase.vulnId, testCase.aliases, testCase.upstream));
            });
        }
    });

    it("an incremental update that changes the aliases rewrites the identity", async () => {
        // A GHSA with no CVE alias stands alone …
        await syncWrite("GHSA-pqrs-tuvw-xyzq", null, "2026-01-01T00:00:00Z");
        const before = await db
            .select({ stored: schema.vulnerabilities.findingIdentity })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, "GHSA-pqrs-tuvw-xyzq"));
        expect(before[0]!.stored).toBe("#GHSA-pqrs-tuvw-xyzq");

        // … until upstream publishes the CVE cross-reference. The changed
        // `modified` changes the raw bytes, so the hash-gated upsert rewrites
        // the row — and with it, the identity.
        await syncWrite("GHSA-pqrs-tuvw-xyzq", ["CVE-2025-4242"], "2026-02-01T00:00:00Z");
        const after = await db
            .select({
                stored: schema.vulnerabilities.findingIdentity,
                oracle: oracleIdentity,
            })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, "GHSA-pqrs-tuvw-xyzq"));
        expect(after[0]!.stored).toBe("CVE-2025-4242");
        expect(after[0]!.stored).toBe(after[0]!.oracle);
    });

    it("db/findings.ts#findingIdentity reads the stored column", async () => {
        const { findingIdentity } = await import("../../../src/db/findings.js");

        await syncWrite("GHSA-aaaa-bbbb-cccc", ["CVE-2024-1234"]);
        const [row] = await db
            .select({ identity: findingIdentity })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, "GHSA-aaaa-bbbb-cccc"));

        expect(row!.identity).toBe("CVE-2024-1234");
    });
});
