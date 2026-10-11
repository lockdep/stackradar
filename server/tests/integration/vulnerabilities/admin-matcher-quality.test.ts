/**
 * The admin Matcher tab's aggregate figures.
 *
 * Every column here is already written on every link and already rendered per
 * component by the Explorer. What the aggregate adds is the only thing that can
 * catch a regression: one match at a time, a demotion from `exact` to `fuzzy`
 * or an advisory attached to the wrong kind of package looks like a curiosity.
 * Across the table it is a shape.
 *
 * Two claims are pinned here:
 *
 * 1. The distributions must account for *every* link, including the ones with
 *    null metadata — those columns were added after the matcher was already
 *    writing rows, and a bar that quietly drops them misstates its own total.
 * 2. Ecosystem agreement must only judge pairs it can actually judge. An OSV
 *    family outside `matching/ecosystem.ts` and a component with no parseable
 *    PURL are both unanswerable, and folding either into "agreeing" would let
 *    the score improve by knowing less.
 *
 * The repository is imported dynamically: `src/db/index.ts` reads DATABASE_URL
 * at module load, and test-setup.ts only sets it in its own beforeAll.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, createImage, createSbom, withFindingIdentity } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

let adminMatcherRepository: typeof import("../../../src/repositories/admin-matcher.repository.js").adminMatcherRepository;

beforeAll(async () => {
    adminMatcherRepository = (await import("../../../src/repositories/admin-matcher.repository.js"))
        .adminMatcherRepository;
});

let sbomId: string;
let advisoryCounter = 0;

/** A component in the shared SBOM. `purl: null` stands in for one we cannot parse. */
async function component(name: string, purl: string | null) {
    const [row] = await getTestDb()
        .insert(schema.components)
        .values({
            sbomId,
            name,
            version: "1.0.0",
            type: "library",
            purl,
        })
        .returning();
    return row!;
}

async function advisory() {
    const [row] = await getTestDb()
        .insert(schema.vulnerabilities)
        .values(
            withFindingIdentity([
                {
                    vulnId: `CVE-2024-${String(++advisoryCounter).padStart(4, "0")}`,
                    source: "osv",
                    severityLevel: "high",
                },
            ]),
        )
        .returning();
    return row!;
}

/** One link, with whatever match metadata the case under test needs. */
async function link(
    componentId: string,
    values: {
        matchedBy?: string | null;
        matchType?: string | null;
        matchConfidence?: string | null;
        matchedEcosystem?: string | null;
    },
) {
    const vuln = await advisory();
    await getTestDb()
        .insert(schema.componentVulnerabilities)
        .values({
            componentId,
            vulnerabilityId: vuln.id,
            ...values,
        });
}

beforeEach(async () => {
    await cleanAllData();
    const db = getTestDb();
    const { org, cluster } = await seedTestScenario(db);
    const image = await createImage(db, org.id, cluster.id);
    const sbom = await createSbom(db, { imageId: image.id });
    sbomId = sbom.id;
});

describe("adminRepository.getMatcherQuality — distributions", () => {
    it("distributes every link across all three columns", async () => {
        const lodash = await component("lodash", "pkg:npm/lodash@4.17.21");
        await link(lodash.id, { matchedBy: "purl", matchType: "direct", matchConfidence: "exact" });
        await link(lodash.id, { matchedBy: "purl", matchType: "direct", matchConfidence: "fuzzy" });
        await link(lodash.id, { matchedBy: "cpe", matchType: "indirect", matchConfidence: "unconfirmed" });

        const stats = await adminMatcherRepository.getMatcherQuality();

        expect(stats.total).toBe(3);
        expect(stats.byMatchedBy).toEqual({ purl: 2, cpe: 1 });
        expect(stats.byMatchType).toEqual({ direct: 2, indirect: 1 });
        expect(stats.byMatchConfidence).toEqual({ exact: 1, fuzzy: 1, unconfirmed: 1 });
    });

    it("buckets null metadata as `unrecorded` rather than dropping it", async () => {
        const lodash = await component("lodash", "pkg:npm/lodash@4.17.21");
        // A link written before these columns existed. It cannot be audited,
        // which is precisely why the bucket has to be visible — a bar summing to
        // less than `total` would hide how much of the table predates the rewrite.
        await link(lodash.id, {});
        await link(lodash.id, { matchedBy: "purl", matchType: "direct", matchConfidence: "exact" });

        const stats = await adminMatcherRepository.getMatcherQuality();

        expect(stats.total).toBe(2);
        expect(stats.byMatchedBy).toEqual({ purl: 1, unrecorded: 1 });
        expect(stats.byMatchType).toEqual({ direct: 1, unrecorded: 1 });
        expect(stats.byMatchConfidence).toEqual({ exact: 1, unrecorded: 1 });
    });

    it("reads as empty rather than as broken on a database with no matches", async () => {
        const stats = await adminMatcherRepository.getMatcherQuality();

        expect(stats.total).toBe(0);
        expect(stats.byMatchedBy).toEqual({});
        expect(stats.ecosystemAgreement).toEqual({
            agreeing: 0,
            disagreeing: 0,
            unrecorded: 0,
            unresolvable: 0,
            topDisagreements: [],
        });
    });
});

describe("adminRepository.getMatcherQuality — ecosystem agreement", () => {
    it("counts a family and PURL type that describe the same kind of package as agreeing", async () => {
        const lodash = await component("lodash", "pkg:npm/lodash@4.17.21");
        const openssl = await component("openssl", "pkg:apk/alpine/openssl@3.1.4-r5");

        await link(lodash.id, { matchedEcosystem: "npm" });
        // Release suffix stripped: Alpine:v3.19 and Alpine:v3.23 are the same
        // answer to "what kind of package is this".
        await link(openssl.id, { matchedEcosystem: "Alpine:v3.19" });
        await link(openssl.id, { matchedEcosystem: "Alpine:v3.23" });

        const { ecosystemAgreement: eco } = await adminMatcherRepository.getMatcherQuality();

        expect(eco.agreeing).toBe(3);
        expect(eco.disagreeing).toBe(0);
        expect(eco.topDisagreements).toEqual([]);
    });

    it("flags an advisory attached to a component type it is never published for", async () => {
        const golang = await component("golang.org/x/net", "pkg:golang/golang.org/x/net@v0.17.0");
        // Debian publishes `deb`, never `golang` — the shape of a match-key or
        // release-scoping leak, and invisible one component at a time.
        await link(golang.id, { matchedEcosystem: "Debian:12" });
        await link(golang.id, { matchedEcosystem: "Debian:11" });

        const { ecosystemAgreement: eco } = await adminMatcherRepository.getMatcherQuality();

        expect(eco.disagreeing).toBe(2);
        expect(eco.agreeing).toBe(0);
        // Both releases fold into one row: it is one defect, not two.
        expect(eco.topDisagreements).toEqual([
            { family: "Debian", expectedPurlType: "deb", componentPurlType: "golang", count: 2 },
        ]);
    });

    it("ranks crossed pairs by size and caps the table without capping the count", async () => {
        const golang = await component("x/net", "pkg:golang/golang.org/x/net@v0.17.0");
        const npmPkg = await component("lodash", "pkg:npm/lodash@4.17.21");

        await link(golang.id, { matchedEcosystem: "Debian:12" });
        await link(golang.id, { matchedEcosystem: "Debian:11" });
        await link(npmPkg.id, { matchedEcosystem: "Alpine:v3.19" });

        const { ecosystemAgreement: eco } = await adminMatcherRepository.getMatcherQuality(1);

        expect(eco.disagreeing).toBe(3);
        // The cap is on the table, not the figure — the gap between them is what
        // says a tail exists.
        expect(eco.topDisagreements).toHaveLength(1);
        expect(eco.topDisagreements[0]).toEqual({
            family: "Debian",
            expectedPurlType: "deb",
            componentPurlType: "golang",
            count: 2,
        });
    });

    it("separates links whose provenance was never recorded", async () => {
        const lodash = await component("lodash", "pkg:npm/lodash@4.17.21");
        await link(lodash.id, { matchedEcosystem: null });

        const { ecosystemAgreement: eco } = await adminMatcherRepository.getMatcherQuality();

        expect(eco).toMatchObject({ unrecorded: 1, agreeing: 0, disagreeing: 0, unresolvable: 0 });
    });

    it("separates pairs the question cannot be asked of, in either direction", async () => {
        const lodash = await component("lodash", "pkg:npm/lodash@4.17.21");
        const noPurl = await component("mystery", null);
        const badPurl = await component("legacy", "pkg://npm/lodash@4.17.21");

        // An OSV family with no PURL type in the table. Not a defect — asking
        // would mean guessing, and a guess here reads as a real finding.
        await link(lodash.id, { matchedEcosystem: "GitHub Actions" });
        // A component with no PURL at all, and the legacy `pkg://` form we
        // deliberately refuse to parse.
        await link(noPurl.id, { matchedEcosystem: "npm" });
        await link(badPurl.id, { matchedEcosystem: "npm" });

        const { ecosystemAgreement: eco } = await adminMatcherRepository.getMatcherQuality();

        expect(eco).toMatchObject({ unresolvable: 3, agreeing: 0, disagreeing: 0, unrecorded: 0 });
    });

    it("accounts for every link across the four buckets", async () => {
        const lodash = await component("lodash", "pkg:npm/lodash@4.17.21");
        const golang = await component("x/net", "pkg:golang/golang.org/x/net@v0.17.0");
        const noPurl = await component("mystery", null);

        await link(lodash.id, { matchedEcosystem: "npm" });
        await link(golang.id, { matchedEcosystem: "Debian:12" });
        await link(noPurl.id, { matchedEcosystem: "npm" });
        await link(lodash.id, { matchedEcosystem: null });

        const stats = await adminMatcherRepository.getMatcherQuality();
        const { agreeing, disagreeing, unresolvable, unrecorded } = stats.ecosystemAgreement;

        // The four buckets are a partition. If they ever stop summing to `total`,
        // every percentage rendered from them is wrong.
        expect(agreeing + disagreeing + unresolvable + unrecorded).toBe(stats.total);
    });
});
