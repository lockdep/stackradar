/**
 * The suggestion feed's ranking and collapse rules.
 *
 * The load-bearing rules, each with a test:
 * - an unmeasured suggestion never outranks a measured one, whatever the
 *   numbers say;
 * - within measured, clearing a KEV-listed finding outranks any risk delta
 *   that does not;
 * - EOL advisories rank last;
 * - a chart bump subsumes the image suggestions it covers — but the folded
 *   suggestion is carried whole, never discarded, so a tag override that is
 *   deliverable today is not hidden behind the bump.
 */

import { describe, it, expect } from "vitest";
import {
    assembleSuggestions,
    countFixesAtCandidateAppVersion,
    rankKey,
    type ChartUpgradeSuggestion,
    type EolSuggestion,
    type ImageSuggestion,
    type UnmeasuredChartSuggestion,
} from "../../../src/services/suggestion.service.js";
import type { ComparableFinding } from "../../../src/db/finding-delta.js";

const cluster = { id: "c1", name: "prod" };

const summary = (riskChange: number, resolvedKev = 0) => ({
    resolved: 1,
    introduced: 0,
    unchanged: 0,
    resolvedKev,
    introducedKev: 0,
    resolvedHigh: 0,
    riskBefore: 50,
    riskAfter: 50 + riskChange,
    riskChange,
});

function imageSuggestion(
    id: string,
    opts: { riskRemoved: number; clearsKev?: boolean; imageId?: string },
): ImageSuggestion {
    return {
        id,
        type: "image-tag-upgrade",
        measured: true,
        cluster,
        riskRemoved: opts.riskRemoved,
        clearsKev: opts.clearsKev ?? false,
        image: {
            id: opts.imageId ?? `img-${id}`,
            digest: "sha256:" + "a".repeat(64),
            repository: "library/nginx",
            currentTag: "1.25",
        },
        best: {
            tag: "1.26",
            imageId: "target",
            digest: "sha256:" + "b".repeat(64),
            bump: "minor",
            summary: summary(-opts.riskRemoved, opts.clearsKev ? 1 : 0),
            resolvedByScope: { application: 1, base: 0 },
        },
        workloadCount: 1,
        containerCount: 1,
        pinnedBy: null,
        deliveredBy: null,
        override: null,
    };
}

function chartSuggestion(
    id: string,
    opts: { riskRemoved: number; clearsKev?: boolean; movesImageIds?: string[] },
): ChartUpgradeSuggestion {
    return {
        id,
        type: "chart-upgrade",
        measured: true,
        cluster,
        riskRemoved: opts.riskRemoved,
        clearsKev: opts.clearsKev ?? false,
        release: {
            id: `rel-${id}`,
            name: "redis",
            namespace: "default",
            chartName: "redis",
            chartVersion: "18.0.0",
            appVersion: null,
            repoUrl: null,
            attributedRepoUrl: null,
            chartDeprecated: false,
        },
        target: { releaseId: "sibling", chartVersion: "18.2.0", cluster: "prod", namespace: "default" },
        evidence: "sibling-release",
        bump: "minor",
        matchKind: "chart-name",
        imageMoves: (opts.movesImageIds ?? []).map((fromImageId) => ({
            fromImageId,
            fromDigest: "sha256:" + "c".repeat(64),
            toImageId: "to",
            toDigest: "sha256:" + "d".repeat(64),
            repository: "library/redis",
            summary: summary(-opts.riskRemoved, opts.clearsKev ? 1 : 0),
            resolvedByScope: { application: 1, base: 0 },
        })),
        unmeasuredImages: 0,
        delivery: null,
        command: "helm upgrade redis -n default --reuse-values --version 18.2.0",
        kubeWarning: null,
        subsumes: [],
    };
}

function unmeasuredSuggestion(id: string, upperBoundRisk: number): UnmeasuredChartSuggestion {
    return {
        id,
        type: "chart-newer-unmeasured",
        measured: false,
        cluster,
        riskRemoved: null,
        clearsKev: false,
        release: {
            id: `rel-${id}`,
            name: "grafana",
            namespace: "default",
            chartName: "grafana",
            chartVersion: "7.0.0",
            appVersion: null,
            repoUrl: null,
            attributedRepoUrl: null,
            chartDeprecated: false,
        },
        targetVersion: "8.0.0",
        bump: "major",
        matchKind: "chart-name",
        source: "sibling-release",
        upperBoundRisk,
        fixableFindings: 3,
        appVersionMove: null,
        fixesAtCandidateAppVersion: null,
        kubeWarning: null,
    };
}

function eolSuggestion(id: string, impact: number): EolSuggestion {
    return {
        id,
        type: "eol-migration",
        measured: false,
        cluster,
        riskRemoved: null,
        clearsKev: false,
        image: {
            id: `img-${id}`,
            digest: "sha256:" + "e".repeat(64),
            repository: "library/alpine",
            currentTag: "3.16",
        },
        lines: [{ releaseLine: "Alpine 3.16", eolDate: "2024-05-23", findings: 4 }],
        findings: 4,
        impact,
    };
}

describe("assembleSuggestions", () => {
    it("never lets an unmeasured suggestion outrank a measured one", () => {
        const out = assembleSuggestions({
            imageSuggestions: [imageSuggestion("tiny", { riskRemoved: 0.1 })],
            chartSuggestions: [],
            unmeasured: [unmeasuredSuggestion("huge", 99)],
            eol: [],
        });
        expect(out.map((s) => s.id)).toEqual(["tiny", "huge"]);
    });

    it("ranks a KEV-clearing move above a larger risk delta that clears none", () => {
        const out = assembleSuggestions({
            imageSuggestions: [
                imageSuggestion("big-no-kev", { riskRemoved: 40 }),
                imageSuggestion("small-kev", { riskRemoved: 5, clearsKev: true }),
            ],
            chartSuggestions: [],
            unmeasured: [],
            eol: [],
        });
        expect(out.map((s) => s.id)).toEqual(["small-kev", "big-no-kev"]);
    });

    it("orders measured by risk removed, unmeasured by upper bound, EOL last by impact", () => {
        const out = assembleSuggestions({
            imageSuggestions: [
                imageSuggestion("less", { riskRemoved: 10 }),
                imageSuggestion("more", { riskRemoved: 30 }),
            ],
            chartSuggestions: [],
            unmeasured: [unmeasuredSuggestion("low-bound", 5), unmeasuredSuggestion("high-bound", 50)],
            eol: [eolSuggestion("mild", 10), eolSuggestion("severe", 60)],
        });
        expect(out.map((s) => s.id)).toEqual(["more", "less", "high-bound", "low-bound", "severe", "mild"]);
    });

    it("collapses an image suggestion into the measured chart bump that moves it", () => {
        const chart = chartSuggestion("chart", { riskRemoved: 20, movesImageIds: ["img-x"] });
        const covered = imageSuggestion("covered", { riskRemoved: 8, imageId: "img-x" });
        const standalone = imageSuggestion("standalone", { riskRemoved: 8, imageId: "img-y" });

        const out = assembleSuggestions({
            imageSuggestions: [covered, standalone],
            chartSuggestions: [chart],
            unmeasured: [],
            eol: [],
        });

        expect(out.map((s) => s.id)).toEqual(["chart", "standalone"]);
        // Carried whole, not discarded — the deliverable-today override rule.
        expect(chart.subsumes.map((s) => s.id)).toEqual(["covered"]);
    });

    it("does not collapse into an unmeasured suggestion", () => {
        // An unmeasured suggestion has no image moves by construction, so an
        // image suggestion for the same release's image stays standalone.
        const out = assembleSuggestions({
            imageSuggestions: [imageSuggestion("override", { riskRemoved: 8, imageId: "img-x" })],
            chartSuggestions: [],
            unmeasured: [unmeasuredSuggestion("newer", 30)],
            eol: [],
        });
        expect(out.map((s) => s.id)).toEqual(["override", "newer"]);
    });
});

describe("rankKey", () => {
    it("puts the three bands in order regardless of magnitudes", () => {
        const measured = rankKey(imageSuggestion("m", { riskRemoved: 0 }));
        const unmeasured = rankKey(unmeasuredSuggestion("u", 1000));
        const eol = rankKey(eolSuggestion("e", 1000));
        expect(measured[0]).toBeLessThan(unmeasured[0]);
        expect(unmeasured[0]).toBeLessThan(eol[0]);
    });
});

// ---------------------------------------------------------------------------
// The phase-1 tightened bound.
// The rule under test: only findings on the application *itself* (package
// version equals the release's appVersion) count, only when the fix landed at
// or below the candidate's app version, and every doubtful comparison refuses.
// ---------------------------------------------------------------------------

function finding(overrides: Partial<ComparableFinding> & { key: string }): ComparableFinding {
    return {
        vulnId: "CVE-2024-1",
        packageName: "prometheus",
        packageType: "library",
        purlType: "golang",
        packageVersion: "2.51.0",
        severityLevel: "high",
        riskScore: 60,
        kevListed: false,
        epssScore: null,
        fixedVersion: null,
        bucket: "application",
        ...overrides,
    };
}

describe("countFixesAtCandidateAppVersion", () => {
    const move = { from: "v2.51.0", to: "v2.54.0" };

    it("counts a finding on the application whose fix is at or below the candidate app version", () => {
        const findings = [finding({ key: "a", fixedVersion: "2.52.0" }), finding({ key: "b", fixedVersion: "2.54.0" })];
        expect(countFixesAtCandidateAppVersion(findings, move)).toBe(2);
    });

    it("does not count a fix above the candidate's app version", () => {
        const findings = [finding({ key: "a", fixedVersion: "2.55.0" })];
        expect(countFixesAtCandidateAppVersion(findings, move)).toBe(0);
    });

    it("does not count library findings — package version must equal the appVersion", () => {
        // A library inside the app carrying its own version is the category
        // confusion the proposal warns about; it must never count.
        const findings = [
            finding({ key: "a", packageName: "golang.org/x/net", packageVersion: "0.19.0", fixedVersion: "0.23.0" }),
        ];
        expect(countFixesAtCandidateAppVersion(findings, move)).toBe(0);
    });

    it("tolerates a leading v on either side", () => {
        const findings = [finding({ key: "a", packageVersion: "v2.51.0", fixedVersion: "v2.52.0" })];
        expect(countFixesAtCandidateAppVersion(findings, { from: "2.51.0", to: "2.54.0" })).toBe(1);
    });

    it("refuses findings with no fixed version, no package version, or no comparator", () => {
        const findings = [
            finding({ key: "a", fixedVersion: null }),
            finding({ key: "b", packageVersion: null, fixedVersion: "2.52.0" }),
            // No parseable PURL means no version scheme — refusal, not fuzzy.
            finding({ key: "c", purlType: null, fixedVersion: "2.52.0" }),
        ];
        expect(countFixesAtCandidateAppVersion(findings, move)).toBe(0);
    });

    it("counts a finding once across images — the cross-image key dedupes", () => {
        const findings = [
            finding({ key: "same", fixedVersion: "2.52.0" }),
            finding({ key: "same", fixedVersion: "2.52.0" }),
        ];
        expect(countFixesAtCandidateAppVersion(findings, move)).toBe(1);
    });
});
