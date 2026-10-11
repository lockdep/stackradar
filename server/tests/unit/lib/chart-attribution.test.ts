/**
 * The chart-attribution matcher. Pure, so these tests are the contract:
 * identity evidence is required, authority only separates, ties refuse.
 */

import { describe, it, expect } from "vitest";
import {
    artifactHubMatch,
    attributeChart,
    STARS_MARGIN_RATIO,
    STARS_MARGIN_FLOOR,
    type AttributionCandidate,
    type InstalledChartVersion,
} from "../../../src/lib/chart-attribution.js";

let nextId = 0;
function candidate(overrides: Partial<AttributionCandidate> = {}): AttributionCandidate {
    return {
        packageId: `pkg-${nextId++}`,
        repoName: `repo-${nextId}`,
        repoUrl: `https://charts.example.com/${nextId}`,
        stars: 0,
        repoVerified: false,
        repoOfficial: false,
        versions: [],
        ...overrides,
    };
}

const install = (chartVersion: string | null, appVersion: string | null = null): InstalledChartVersion => ({
    chartVersion,
    appVersion,
});

describe("attributeChart", () => {
    it("matches when exactly one candidate lists the installed version", () => {
        const winner = candidate({
            repoName: "bitnami",
            versions: [{ pkg: "19.3.0", app: "7.2.4", kube: null, deprecated: false }],
        });
        const other = candidate({
            repoName: "groundhog2k",
            versions: [{ pkg: "2.4.6", app: "8.10.0", kube: null, deprecated: false }],
        });

        const decision = attributeChart([install("19.3.0")], [other, winner]);
        expect(decision.outcome).toBe("matched");
        if (decision.outcome === "matched") {
            expect(decision.candidate.repoName).toBe("bitnami");
            expect(decision.evidence.scores).toHaveLength(2);
        }
    });

    it("refuses when no candidate lists the installed version", () => {
        const c = candidate({ versions: [{ pkg: "1.0.0", app: null, kube: null, deprecated: false }] });
        expect(attributeChart([install("9.9.9")], [c])).toMatchObject({
            outcome: "refused",
            reason: "no-version-match",
        });
    });

    it("refuses a null installed version — authority is not evidence", () => {
        // A single candidate with maximal authority still cannot win without
        // the installed version appearing in its list. This is the zero-score
        // accept Nova gets wrong.
        const authoritative = candidate({ repoVerified: true, repoOfficial: true, stars: 10_000 });
        expect(attributeChart([install(null)], [authoritative])).toMatchObject({
            outcome: "refused",
            reason: "no-version-evidence",
        });
    });

    it("refuses with no candidates", () => {
        expect(attributeChart([install("1.0.0")], [])).toMatchObject({
            outcome: "refused",
            reason: "no-candidates",
        });
    });

    it("app-version agreement separates two version-matching candidates", () => {
        const right = candidate({
            repoName: "right",
            versions: [{ pkg: "1.2.3", app: "7.0.0", kube: null, deprecated: false }],
        });
        const wrong = candidate({
            repoName: "wrong",
            stars: 10_000,
            repoVerified: true,
            versions: [{ pkg: "1.2.3", app: "3.0.0", kube: null, deprecated: false }],
        });

        // Evidence tier beats authority: the app-version match wins over the
        // verified, starred repo whose app version disagrees.
        const decision = attributeChart([install("1.2.3", "7.0.0")], [wrong, right]);
        expect(decision).toMatchObject({ outcome: "matched" });
        if (decision.outcome === "matched") expect(decision.candidate.repoName).toBe("right");
    });

    it("verified beats stars among equal evidence", () => {
        const verified = candidate({
            repoName: "small-but-verified",
            repoVerified: true,
            stars: 0,
            versions: [{ pkg: "1.2.3", app: null, kube: null, deprecated: false }],
        });
        const starred = candidate({
            repoName: "huge-but-unverified",
            stars: 10_000,
            versions: [{ pkg: "1.2.3", app: null, kube: null, deprecated: false }],
        });

        const decision = attributeChart([install("1.2.3")], [starred, verified]);
        expect(decision).toMatchObject({ outcome: "matched" });
        if (decision.outcome === "matched") {
            expect(decision.candidate.repoName).toBe("small-but-verified");
        }
    });

    it("stars decide only with a clear margin", () => {
        const versions = [{ pkg: "1.2.3", app: null, kube: null, deprecated: false }];
        const big = candidate({ repoName: "big", stars: 500, versions });
        const tiny = candidate({ repoName: "tiny", stars: 3, versions });
        // 500 ≥ 50 and 500 ≥ 5×3 → accept.
        const clear = attributeChart([install("1.2.3")], [tiny, big]);
        expect(clear).toMatchObject({ outcome: "matched" });
        if (clear.outcome === "matched") expect(clear.candidate.repoName).toBe("big");

        // 100 vs 40: floor met, ratio not — refuse rather than guess.
        const near = attributeChart(
            [install("1.2.3")],
            [candidate({ repoName: "a", stars: 100, versions }), candidate({ repoName: "b", stars: 40, versions })],
        );
        expect(near).toMatchObject({ outcome: "refused", reason: "indistinguishable" });

        // 20 vs 0: ratio infinite, floor unmet — 20 stars is not authority.
        const small = attributeChart(
            [install("1.2.3")],
            [candidate({ repoName: "c", stars: 20, versions }), candidate({ repoName: "d", stars: 0, versions })],
        );
        expect(small).toMatchObject({ outcome: "refused", reason: "indistinguishable" });

        // Pin the exported constants so a tweak is a visible decision.
        expect(STARS_MARGIN_RATIO).toBe(5);
        expect(STARS_MARGIN_FLOOR).toBe(50);
    });

    it("is deterministic under shuffled candidate order, and a tie stays a refusal", () => {
        const versions = [{ pkg: "1.2.3", app: null, kube: null, deprecated: false }];
        const twins = [candidate({ repoName: "alpha", versions }), candidate({ repoName: "beta", versions })];

        const forward = attributeChart([install("1.2.3")], twins);
        const reversed = attributeChart([install("1.2.3")], [...twins].reverse());
        // Indistinguishable twins refuse in either order — iteration order
        // never converts a tie into an accept (Nova's map-order bug).
        expect(forward).toMatchObject({ outcome: "refused", reason: "indistinguishable" });
        expect(reversed).toMatchObject({ outcome: "refused", reason: "indistinguishable" });
        // …and the score breakdown comes out in the same (sorted) order.
        if (forward.outcome === "refused" && reversed.outcome === "refused") {
            expect(forward.scores?.map((s) => s.repoName)).toEqual(reversed.scores?.map((s) => s.repoName));
        }
    });

    it("counts a deprecated version as identity evidence", () => {
        // Deprecation affects what we recommend, not where the chart came from.
        const c = candidate({
            repoName: "newrelic",
            versions: [{ pkg: "0.3.2", app: "0.2.0", kube: null, deprecated: true }],
        });
        const decision = attributeChart([install("0.3.2")], [c]);
        expect(decision).toMatchObject({ outcome: "matched" });
    });

    it("refuses when installed versions disagree on the winner", () => {
        const a = candidate({
            repoName: "repo-a",
            versions: [{ pkg: "1.0.0", app: null, kube: null, deprecated: false }],
        });
        const b = candidate({
            repoName: "repo-b",
            versions: [{ pkg: "2.0.0", app: null, kube: null, deprecated: false }],
        });

        expect(attributeChart([install("1.0.0"), install("2.0.0")], [a, b])).toMatchObject({
            outcome: "refused",
            reason: "conflicting-installs",
        });
    });

    it("requires every evidenced install to match, not just one", () => {
        const a = candidate({
            repoName: "repo-a",
            versions: [{ pkg: "1.0.0", app: null, kube: null, deprecated: false }],
        });
        // Second install's version is unknown to every candidate: the group's
        // identity evidence is broken, so the group refuses.
        expect(attributeChart([install("1.0.0"), install("9.9.9")], [a])).toMatchObject({
            outcome: "refused",
            reason: "no-version-match",
        });
    });
});

describe("artifactHubMatch", () => {
    const pkg = (overrides: Partial<Parameters<typeof artifactHubMatch>[1]> = {}) => ({
        chartName: "redis",
        repoName: "bitnami",
        repoUrl: "https://charts.bitnami.com/bitnami",
        latestVersion: "19.5.0",
        versions: [
            { pkg: "19.5.0", app: "7.2.5", kube: null, deprecated: false },
            { pkg: "19.4.0", app: "7.2.5", kube: null, deprecated: true },
            { pkg: "19.3.0", app: "7.2.4", kube: null, deprecated: false },
        ],
        ...overrides,
    });

    it("confirms the match when the observed repo is the attributed one", () => {
        const match = artifactHubMatch(
            { chartName: "redis", chartVersion: "19.3.0", repoUrl: "https://charts.bitnami.com/bitnami" },
            pkg(),
        );
        expect(match).toMatchObject({
            repoName: "bitnami",
            inferred: false,
            newerVersion: "19.5.0",
            latestVersion: "19.5.0",
            deprecated: false,
            url: "https://artifacthub.io/packages/helm/bitnami/redis",
        });
    });

    /** An attribution is per `(org, chart)`. A release whose observed repo
        disagrees is a different chart with the same name — the collision
        `chartNameAmbiguous` exists to prevent, and claiming the match here
        would be that same error with a link on it. */
    it("refuses to speak for a release whose observed repo is a different one", () => {
        expect(
            artifactHubMatch(
                { chartName: "redis", chartVersion: "19.3.0", repoUrl: "https://charts.example.com" },
                pkg(),
            ),
        ).toBeNull();
    });

    it("labels the match as inferred when the scanner observed no repo", () => {
        expect(artifactHubMatch({ chartName: "redis", chartVersion: "19.3.0", repoUrl: null }, pkg())).toMatchObject({
            inferred: true,
        });
    });

    it("never offers a deprecated version as the newer one", () => {
        const match = artifactHubMatch(
            { chartName: "redis", chartVersion: "19.3.0", repoUrl: null },
            pkg({
                latestVersion: "19.4.0",
                versions: [
                    { pkg: "19.4.0", app: null, kube: null, deprecated: true },
                    { pkg: "19.3.0", app: null, kube: null, deprecated: false },
                ],
            }),
        );
        expect(match?.newerVersion).toBeNull();
    });

    it("says nothing newer exists when the installed version is the latest", () => {
        expect(
            artifactHubMatch({ chartName: "redis", chartVersion: "19.5.0", repoUrl: null }, pkg())?.newerVersion,
        ).toBeNull();
    });

    it("is null without an attribution — a name is not a match", () => {
        expect(artifactHubMatch({ chartName: "redis", chartVersion: "19.3.0", repoUrl: null }, undefined)).toBeNull();
    });
});
