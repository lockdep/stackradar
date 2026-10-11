import { describe, it, expect } from "vitest";
import { communityConfigProblems } from "../../../src/config/index.js";

/**
 * The community edition's readiness check: an install without the
 * bootstrap credential serves but scans nothing — and, since the edition
 * refuses to add a cluster, has no way out but configuration. Reported as
 * a warning, never blocking: a dashboard with nothing in it is still a
 * dashboard.
 */
describe("communityConfigProblems", () => {
    const pair = {
        BOOTSTRAP_CLUSTER_ID: "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
        BOOTSTRAP_CLUSTER_API_KEY: "abcdefghijklmnopqrstuvwxyz012345",
    };

    it("warns when the community edition has no bootstrap cluster", () => {
        const problems = communityConfigProblems({}, { multiCluster: false });
        expect(problems.blocking).toEqual([]);
        expect(problems.warnings).toHaveLength(1);
        expect(problems.warnings[0]).toMatch(/BOOTSTRAP_CLUSTER_ID/);
        expect(problems.warnings[0]).toMatch(/no cluster/);
    });

    it("is clean when the pair is set", () => {
        expect(communityConfigProblems(pair, { multiCluster: false })).toEqual({ blocking: [], warnings: [] });
    });

    it("is empty on the cloud, whatever the environment says", () => {
        expect(communityConfigProblems({}, { multiCluster: true })).toEqual({ blocking: [], warnings: [] });
        expect(communityConfigProblems(pair, { multiCluster: true })).toEqual({ blocking: [], warnings: [] });
    });

    it("never names the key's value", () => {
        const problems = communityConfigProblems(
            { BOOTSTRAP_CLUSTER_API_KEY: pair.BOOTSTRAP_CLUSTER_API_KEY },
            { multiCluster: false },
        );
        for (const line of problems.warnings) expect(line).not.toContain(pair.BOOTSTRAP_CLUSTER_API_KEY);
    });
});
