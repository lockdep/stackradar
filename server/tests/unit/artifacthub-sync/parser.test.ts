/**
 * The Artifact Hub dump parser, against the fixture trimmed from the real
 * dump (2026-08-17). The fixture keeps the dump's omitted-optionals shape —
 * `verified`, `official`, `home`, `app`, `kube`, `deprecated` appear only
 * when set — so these tests pin the defensive defaults.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackages } from "../../../src/artifacthub-sync/parser.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/artifact-hub/nova-slice.json");
const fixture = (): unknown => JSON.parse(readFileSync(fixturePath, "utf-8"));

describe("Artifact Hub parser", () => {
    it("parses the fixture with nothing malformed", () => {
        const { packages, malformed, duplicates } = parsePackages(fixture());
        expect(packages).toHaveLength(10);
        expect(malformed).toBe(0);
        expect(duplicates).toBe(0);
    });

    it("keeps name collisions as separate packages keyed by repository", () => {
        const { packages } = parsePackages(fixture());
        const redis = packages.filter((p) => p.name === "redis");
        expect(redis.map((p) => p.repoName).sort()).toEqual(["bitnami", "groundhog2k", "vks-helm-charts"]);
    });

    it("defaults the omitted optionals instead of failing on them", () => {
        const { packages } = parsePackages(fixture());
        // groundhog2k/redis omits `verified`, `official` and `home` entirely.
        const groundhog = packages.find((p) => p.repoName === "groundhog2k")!;
        expect(groundhog.repoVerified).toBe(false);
        expect(groundhog.repoOfficial).toBe(false);
        expect(groundhog.official).toBe(false);
        expect(groundhog.homeUrl).toBeNull();

        const bitnami = packages.find((p) => p.repoName === "bitnami" && p.name === "redis")!;
        expect(bitnami.repoVerified).toBe(true);
        expect(bitnami.stars).toBe(511);
    });

    it("normalises versions to {pkg, app, kube, deprecated}", () => {
        const { packages } = parsePackages(fixture());
        const newrelic = packages.find((p) => p.repoName === "newrelic")!;
        const deprecated = newrelic.versions.filter((v) => v.deprecated);
        expect(deprecated.map((v) => v.pkg)).toEqual(["0.3.2", "0.3.3"]);
        // Non-deprecated entries get an explicit false, not undefined.
        expect(newrelic.versions.find((v) => v.pkg === "0.2.0")).toEqual({
            pkg: "0.2.0",
            app: "0.2.0",
            kube: null,
            deprecated: false,
        });

        const certManager = packages.find((p) => p.name === "cert-manager")!;
        expect(certManager.versions[0]!.kube).toBe(">= 1.22.0-0");
    });

    it("skips entries missing identity fields, counting them malformed", () => {
        const { packages, malformed } = parsePackages([
            { name: "ok", repository: { name: "repo", url: "https://x" }, versions: [] },
            { repository: { name: "repo", url: "https://x" } }, // no name
            { name: "no-repo-url", repository: { name: "repo" } },
            { name: "no-repo-at-all" },
            null,
            "not-an-object",
        ]);
        expect(packages.map((p) => p.name)).toEqual(["ok"]);
        expect(malformed).toBe(5);
    });

    it("dedupes on (repo_name, name), keeping the first occurrence", () => {
        // Load-bearing: the batched ON CONFLICT DO UPDATE aborts if one
        // statement touches the same row twice.
        const { packages, duplicates } = parsePackages([
            { name: "redis", repository: { name: "r", url: "https://first" }, stars: 1 },
            { name: "redis", repository: { name: "r", url: "https://second" }, stars: 2 },
            { name: "redis", repository: { name: "other", url: "https://third" } },
        ]);
        expect(packages).toHaveLength(2);
        expect(packages[0]!.repoUrl).toBe("https://first");
        expect(duplicates).toBe(1);
    });

    it("throws on a payload that is not an array at all", () => {
        expect(() => parsePackages({ packages: [] })).toThrow(/not a JSON array/);
        expect(() => parsePackages(null)).toThrow(/not a JSON array/);
    });
});
