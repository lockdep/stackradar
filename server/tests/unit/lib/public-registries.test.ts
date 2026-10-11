/**
 * The public-registry allowlist and pairing normalisation —
 * the chart-measurement design. The rule under test: only well-known cases
 * are normalised, and everything else degrades to a missed pair (lost
 * coverage), never to a wrong claim.
 */

import { describe, it, expect } from "vitest";
import {
    isPublicRegistry,
    normalizeRegistry,
    pairRepository,
    registryApiHost,
} from "../../../src/lib/public-registries.js";

describe("normalizeRegistry", () => {
    it("treats a missing registry as Docker Hub — the runtime's rule, not a guess", () => {
        expect(normalizeRegistry(null)).toBe("docker.io");
        expect(normalizeRegistry(undefined)).toBe("docker.io");
        expect(normalizeRegistry("")).toBe("docker.io");
    });

    it("collapses Docker Hub aliases", () => {
        expect(normalizeRegistry("index.docker.io")).toBe("docker.io");
        expect(normalizeRegistry("registry-1.docker.io")).toBe("docker.io");
        expect(normalizeRegistry("Docker.IO")).toBe("docker.io");
    });

    it("passes other registries through, lowercased", () => {
        expect(normalizeRegistry("Quay.io")).toBe("quay.io");
        expect(normalizeRegistry("registry.example.com:5000")).toBe("registry.example.com:5000");
    });
});

describe("isPublicRegistry", () => {
    it("allows the well-known public registries", () => {
        for (const registry of ["docker.io", "quay.io", "ghcr.io", "registry.k8s.io", null]) {
            expect(isPublicRegistry(registry)).toBe(true);
        }
    });

    it("refuses everything else — not listed means not contacted", () => {
        expect(isPublicRegistry("registry.internal.corp")).toBe(false);
        expect(isPublicRegistry("localhost:5000")).toBe(false);
    });
});

describe("pairRepository", () => {
    it("canonicalises Docker Hub official-image shorthand", () => {
        expect(pairRepository(null, "nginx")).toBe("library/nginx");
        expect(pairRepository("docker.io", "nginx")).toBe("library/nginx");
        expect(pairRepository("index.docker.io", "nginx")).toBe("library/nginx");
        expect(pairRepository("docker.io", "library/nginx")).toBe("library/nginx");
    });

    it("rewrites nothing outside Docker Hub — a mirror degrades to a missed pair", () => {
        expect(pairRepository("quay.io", "nginx")).toBe("nginx");
        expect(pairRepository("registry.example.com", "team/app")).toBe("team/app");
    });
});

describe("registryApiHost", () => {
    it("maps Docker Hub to its API host and leaves the rest alone", () => {
        expect(registryApiHost("docker.io")).toBe("registry-1.docker.io");
        expect(registryApiHost("quay.io")).toBe("quay.io");
    });
});
