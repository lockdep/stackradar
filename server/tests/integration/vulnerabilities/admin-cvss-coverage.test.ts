/**
 * `withoutCvssScore` — the count that stops the `unknown` severity bar being
 * read as mirror coverage.
 *
 * The two are independent questions and they diverge in both directions. An
 * advisory can carry a severity level derived from a vendor string with no CVSS
 * vector behind it (counted here, not in `unknown`), and it can carry a score
 * that maps to no level we recognise (counted in `unknown`, not here). Neither
 * bucket contains the other, so only the explicit figure answers "how much of
 * the mirror can be ranked numerically" — and an empty database answers it the
 * same way as one OSV has published no scores for, which is the conflation this
 * exists to break.
 *
 * The repository is imported dynamically: `src/db/index.ts` reads DATABASE_URL
 * at module load, and test-setup.ts only sets it in its own beforeAll.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import { withFindingIdentity } from "../../fixtures/seed-data.js";

let adminRepository: typeof import("../../../src/repositories/admin.repository.js").adminRepository;
let adminStatusRepository: typeof import("../../../src/repositories/admin-status.repository.js").adminStatusRepository;

beforeAll(async () => {
    adminRepository = (await import("../../../src/repositories/admin.repository.js")).adminRepository;
    adminStatusRepository = (await import("../../../src/repositories/admin-status.repository.js"))
        .adminStatusRepository;
});

beforeEach(async () => {
    await cleanAllData();
});

let counter = 0;

async function advisory(values: {
    severityLevel?: string | null;
    cvssScore?: number | null;
    withdrawnAt?: Date | null;
}) {
    await getTestDb()
        .insert(schema.vulnerabilities)
        .values(
            withFindingIdentity([
                {
                    vulnId: `CVE-2024-${String(++counter).padStart(4, "0")}`,
                    source: "osv",
                    ...values,
                },
            ]),
        );
}

describe("advisories with no CVSS score", () => {
    it("counts advisories whose score is null", async () => {
        await advisory({ severityLevel: "high", cvssScore: 7.5 });
        await advisory({ severityLevel: "high", cvssScore: null });
        await advisory({ severityLevel: null, cvssScore: null });

        const stats = await adminRepository.getVulnerabilityStats();

        expect(stats.total).toBe(3);
        expect(stats.withoutCvssScore).toBe(2);
    });

    it("is not the unknown severity bucket", async () => {
        // A level with no score behind it: counted here, absent from `unknown`.
        await advisory({ severityLevel: "critical", cvssScore: null });
        // A score with no level mapped from it: counted in `unknown`, absent here.
        await advisory({ severityLevel: null, cvssScore: 5.0 });

        const stats = await adminRepository.getVulnerabilityStats();

        expect(stats.withoutCvssScore).toBe(1);
        expect(stats.bySeverity["unknown"]).toBe(1);
        // Same mirror, two different numbers — which is the whole point.
        expect(stats.bySeverity["critical"]).toBe(1);
    });

    it("excludes withdrawn advisories, like every other figure on the tab", async () => {
        await advisory({ severityLevel: "high", cvssScore: null });
        await advisory({ severityLevel: "high", cvssScore: null, withdrawnAt: new Date("2026-01-15T00:00:00Z") });

        const stats = await adminRepository.getVulnerabilityStats();

        // The unscored figure is rendered as a share of `total`, which excludes
        // withdrawn. Counting a retraction here could put it over 100%.
        expect(stats.total).toBe(1);
        expect(stats.withoutCvssScore).toBe(1);
    });

    it("reads the same on the Overview tab as on the Vulnerabilities tab", async () => {
        await advisory({ severityLevel: "high", cvssScore: 7.5 });
        await advisory({ severityLevel: null, cvssScore: null });

        const [system, vulns] = await Promise.all([
            adminStatusRepository.getSystemStats(),
            adminRepository.getVulnerabilityStats(),
        ]);

        expect(system.vulnerabilities.withoutCvssScore).toBe(vulns.withoutCvssScore);
        expect(system.vulnerabilities.withoutCvssScore).toBe(1);
    });

    it("is zero, not absent, on an empty mirror", async () => {
        const stats = await adminRepository.getVulnerabilityStats();

        expect(stats.total).toBe(0);
        expect(stats.withoutCvssScore).toBe(0);
    });
});
