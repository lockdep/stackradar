/**
 * Parsing a Helm repository's `index.yaml` — docs/proposals/fix-tab-suggestions.md
 * phase 2. The rules that matter: trim to the charts the org runs, survive
 * malformed entries at the cost of the entry rather than the document, and
 * refuse protocols that cannot serve an index.
 */

import { describe, it, expect } from "vitest";
import {
    indexUrl,
    isIndexableRepoUrl,
    parseIndexYaml,
    resolveTarballUrl,
    readBodyWithCeiling,
    MAX_INDEX_BYTES,
    MAX_VERSIONS_PER_CHART,
} from "../../../src/lib/chart-repo.js";

const INDEX = `
apiVersion: v1
entries:
  redis:
    - version: 18.2.1
      appVersion: 7.2.4
      urls:
        - https://charts.example.com/redis-18.2.1.tgz
        - https://mirror.example.com/redis-18.2.1.tgz
    - version: 18.2.0
      appVersion: 7.2.4
      urls:
        - charts/redis-18.2.0.tgz
    - version: 18.1.0
  grafana:
    - version: 7.3.0
      appVersion: "10.1.0"
  broken: not-a-list
  no-versions:
    - appVersion: only
generated: "2026-08-17T00:00:00Z"
`;

describe("parseIndexYaml", () => {
    it("parses chart entries with their versions in listed order", () => {
        const entries = parseIndexYaml(INDEX, null, "https://charts.example.com");
        const redis = entries.find((e) => e.chartName === "redis");
        expect(redis?.versions).toEqual([
            {
                version: "18.2.1",
                appVersion: "7.2.4",
                // First URL wins — the rest are mirrors of the same artifact.
                tarballUrl: "https://charts.example.com/redis-18.2.1.tgz",
            },
            {
                version: "18.2.0",
                appVersion: "7.2.4",
                // Relative URLs resolve against the repo root, as helm does.
                tarballUrl: "https://charts.example.com/charts/redis-18.2.0.tgz",
            },
            { version: "18.1.0", appVersion: null, tarballUrl: null },
        ]);
    });

    it("trims to the charts the org runs", () => {
        const entries = parseIndexYaml(INDEX, new Set(["grafana"]));
        expect(entries.map((e) => e.chartName)).toEqual(["grafana"]);
    });

    it("skips malformed entries without losing the document", () => {
        const names = parseIndexYaml(INDEX, null).map((e) => e.chartName);
        expect(names).toContain("redis");
        expect(names).not.toContain("broken");
        expect(names).not.toContain("no-versions");
    });

    it("caps versions per chart, keeping the head of the list", () => {
        const versions = Array.from({ length: MAX_VERSIONS_PER_CHART + 50 }, (_, i) => `    - version: 1.0.${i}`);
        const big = `entries:\n  huge:\n${versions.join("\n")}\n`;
        const [entry] = parseIndexYaml(big, null);
        expect(entry!.versions).toHaveLength(MAX_VERSIONS_PER_CHART);
        expect(entry!.versions[0]!.version).toBe("1.0.0");
    });

    it("throws on a document with no entries mapping", () => {
        expect(() => parseIndexYaml("apiVersion: v1\n", null)).toThrow(/entries/);
        expect(() => parseIndexYaml("- just\n- a\n- list\n", null)).toThrow();
    });
});

describe("resolveTarballUrl", () => {
    it("keeps absolute http(s) URLs and resolves relative ones against the repo root", () => {
        expect(resolveTarballUrl("https://cdn.example.com/a.tgz", "https://charts.example.com")).toBe(
            "https://cdn.example.com/a.tgz"
        );
        expect(resolveTarballUrl("charts/a.tgz", "https://charts.example.com/repo/")).toBe(
            "https://charts.example.com/repo/charts/a.tgz"
        );
    });

    it("refuses what it cannot fetch — non-strings, non-http schemes, unresolvable relatives", () => {
        expect(resolveTarballUrl(null, "https://charts.example.com")).toBeNull();
        expect(resolveTarballUrl(42, "https://charts.example.com")).toBeNull();
        expect(resolveTarballUrl("oci://ghcr.io/acme/a.tgz", "https://charts.example.com")).toBeNull();
        expect(resolveTarballUrl("charts/a.tgz", null)).toBeNull();
    });
});

describe("indexUrl", () => {
    it("appends index.yaml, tolerating trailing slashes", () => {
        expect(indexUrl("https://charts.example.com")).toBe("https://charts.example.com/index.yaml");
        expect(indexUrl("https://charts.example.com/repo/")).toBe(
            "https://charts.example.com/repo/index.yaml"
        );
    });
});

describe("isIndexableRepoUrl", () => {
    it("accepts http(s) and refuses everything else", () => {
        expect(isIndexableRepoUrl("https://charts.bitnami.com/bitnami")).toBe(true);
        expect(isIndexableRepoUrl("http://chartmuseum.internal:8080")).toBe(true);
        // OCI speaks the registry tags API, not index.yaml — a fast-follow,
        // and until then a row nothing could refresh must not be created.
        expect(isIndexableRepoUrl("oci://ghcr.io/acme/charts")).toBe(false);
        expect(isIndexableRepoUrl("git@github.com:acme/charts.git")).toBe(false);
    });
});

describe("readBodyWithCeiling", () => {
    it("returns the body when it fits", async () => {
        const res = new Response("hello");
        expect(await readBodyWithCeiling(res, 10)).toBe("hello");
    });

    it("aborts a chunked body the moment the ceiling is crossed", async () => {
        // An endless stream: without the ceiling this would never resolve.
        // The server's content-length check cannot catch it (there is none).
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                controller.enqueue(new Uint8Array(1024));
            },
        });
        const res = new Response(stream);
        expect(await readBodyWithCeiling(res, 4096)).toBeNull();
        expect(pulls).toBeLessThan(20);
    });

    it("defaults the ceiling well under the old 50 MB", () => {
        // security-review-2026-08-22.md § S1: the ceiling is the parse budget.
        expect(MAX_INDEX_BYTES).toBeLessThanOrEqual(5 * 1024 * 1024);
    });
});
