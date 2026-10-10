/**
 * `kubeCompatibility` against range strings from the real Artifact Hub dump
 * (2026-08-17) and real Kubernetes `gitVersion` shapes. The contract worth
 * pinning: node-semver parses Masterminds ranges after the comma rewrite,
 * distro suffixes coerce away, and everything unparseable is `unknown` —
 * never a guess in either direction.
 */

import { describe, it, expect } from "vitest";
import { kubeCompatibility } from "../../../src/lib/kube-constraint.js";

describe("kubeCompatibility", () => {
    it("handles the idiomatic -0 lower bound from real charts", () => {
        // kube-prometheus-stack, cert-manager: ">=1.25.0-0" / ">= 1.22.0-0"
        expect(kubeCompatibility("v1.29.4", ">=1.25.0-0")).toBe("ok");
        expect(kubeCompatibility("v1.22.9", ">=1.25.0-0")).toBe("excluded");
        expect(kubeCompatibility("v1.29.4", ">= 1.22.0-0")).toBe("ok");
    });

    it("normalises Masterminds comma-AND ranges", () => {
        expect(kubeCompatibility("v1.29.4", ">= 1.23.0, < 1.31.0")).toBe("ok");
        expect(kubeCompatibility("v1.31.2", ">= 1.23.0, < 1.31.0")).toBe("excluded");
        expect(kubeCompatibility("v1.20.0", ">= 1.23.0, < 1.31.0")).toBe("excluded");
    });

    it("coerces distro-suffixed gitVersions", () => {
        expect(kubeCompatibility("v1.29.4+k3s1", ">=1.25.0-0")).toBe("ok");
        expect(kubeCompatibility("v1.30.2-gke.1100", ">=1.25.0-0")).toBe("ok");
        expect(kubeCompatibility("v1.24.17-eks-e71965b", ">=1.25.0-0")).toBe("excluded");
    });

    it("handles space-AND, hyphen ranges and || from real dump entries", () => {
        // ">=1.30.0-0 <1.34.0-0"
        expect(kubeCompatibility("v1.31.0", ">=1.30.0-0 <1.34.0-0")).toBe("ok");
        expect(kubeCompatibility("v1.29.0", ">=1.30.0-0 <1.34.0-0")).toBe("excluded");
        // "1.19.0-0 - 1.25.0-0" (hyphen range)
        expect(kubeCompatibility("v1.22.0", "1.19.0-0 - 1.25.0-0")).toBe("ok");
        expect(kubeCompatibility("v1.26.0", "1.19.0-0 - 1.25.0-0")).toBe("excluded");
        // anchore-charts: "1.23.x - 1.36.x || 1.23.x-x - 1.36.x-x"
        expect(kubeCompatibility("v1.29.4", "1.23.x - 1.36.x || 1.23.x-x - 1.36.x-x")).toBe("ok");
    });

    it("inserts the missing patch in two-segment prerelease bounds", () => {
        // Real dump shapes Masterminds accepts and node-semver rejects raw:
        // `>=1.21-0` means `>=1.21.0-0`.
        expect(kubeCompatibility("v1.29.4", ">=1.21-0")).toBe("ok");
        expect(kubeCompatibility("v1.20.0", ">= 1.21-0")).toBe("excluded");
        expect(kubeCompatibility("v1.23.5", ">= 1.19.8-0, <= 1.24-0")).toBe("ok");
        // An upper `-0` bound excludes the final release it names — 1.24.0 is
        // greater than 1.24.0-0. Faithful to Masterminds, and to the author's
        // intent of "below 1.24 proper".
        expect(kubeCompatibility("v1.24.0", ">= 1.19.8-0, <= 1.24-0")).toBe("excluded");
        expect(kubeCompatibility("v1.29.4", ">= 1.23-0 <= 1.25-0")).toBe("excluded");
        expect(kubeCompatibility("v1.33.0", ">= 1.32-prerelease")).toBe("ok");
        // Three-segment bounds are untouched by the rewrite.
        expect(kubeCompatibility("v1.22.0", "1.19.0-0 - 1.25.0-0")).toBe("ok");
    });

    it("returns unknown for anything unparseable, on either side", () => {
        expect(kubeCompatibility(null, ">=1.25.0-0")).toBe("unknown");
        expect(kubeCompatibility("v1.29.4", null)).toBe("unknown");
        expect(kubeCompatibility("v1.29.4", "")).toBe("unknown");
        expect(kubeCompatibility("not-a-version", ">=1.25.0-0")).toBe("unknown");
        expect(kubeCompatibility("v1.29.4", "garbage !! range")).toBe("unknown");
    });

    it("never treats a plain range without -0 bounds as excluding a stable cluster", () => {
        // "> 1.9.0", ">= 1.12", ">=1.35" — bare Masterminds shapes from the dump.
        expect(kubeCompatibility("v1.29.4", "> 1.9.0")).toBe("ok");
        expect(kubeCompatibility("v1.29.4", ">= 1.12")).toBe("ok");
        expect(kubeCompatibility("v1.29.4", ">=1.35")).toBe("excluded");
    });
});
