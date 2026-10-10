/**
 * `lib/image-layers.ts` — reading the image metadata an upload carries, and
 * the rule that attributes a component to a layer. Pure.
 */

import { describe, it, expect } from "vitest";
import {
    layerIndexByDiffId,
    parseImageMetadata,
    resolveLayerIndex,
    scannerVersionAtLeast,
} from "../../../src/lib/image-layers.js";

const prop = (name: string, value: string) => ({ name, value });
const bom = (properties: unknown) => ({ metadata: { component: { type: "container", name: "x", properties } } });

describe("parseImageMetadata", () => {
    it("orders layers by history index and numbers only the ones that exist", () => {
        const parsed = parseImageMetadata(bom([
            prop("stackradar:layer:2:diffId", "sha256:bb"),
            prop("stackradar:layer:2:emptyLayer", "false"),
            prop("stackradar:layer:2:createdBy", "RUN npm ci"),
            prop("stackradar:layer:2:size", "1234"),
            prop("stackradar:layer:2:created", "2026-01-02T03:04:05Z"),
            prop("stackradar:layer:0:diffId", "sha256:aa"),
            prop("stackradar:layer:1:emptyLayer", "true"),
            prop("stackradar:layer:1:createdBy", 'CMD ["node"]'),
            prop("stackradar:image:baseName", "node:20-bookworm-slim"),
            prop("stackradar:image:env:NODE_VERSION", "20.11.1"),
            prop("syft:image:labels:maintainer", "someone"),
        ]));

        expect(parsed.layers.map((l) => [l.index, l.rootfsIndex, l.diffId, l.emptyLayer])).toEqual([
            [0, 0, "sha256:aa", false],
            [1, null, null, true],
            [2, 1, "sha256:bb", false],
        ]);
        expect(parsed.layers[2]).toMatchObject({ createdBy: "RUN npm ci", size: 1234 });
        expect(parsed.layers[2]!.created?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
        expect(parsed.facts).toEqual({ baseName: "node:20-bookworm-slim", "env:NODE_VERSION": "20.11.1" });
    });

    it("is empty, not an error, for an upload from an older scanner", () => {
        for (const doc of [null, {}, { metadata: {} }, bom(undefined), bom([{ name: 1, value: 2 }])]) {
            expect(parseImageMetadata(doc)).toEqual({ layers: [], facts: {} });
        }
    });

    it("ignores malformed values rather than storing them", () => {
        const parsed = parseImageMetadata(bom([
            prop("stackradar:layer:0:diffId", "sha256:aa"),
            prop("stackradar:layer:0:size", "lots"),
            prop("stackradar:layer:0:created", "yesterday"),
            prop("stackradar:layer:99999:diffId", "sha256:zz"),
        ]));
        expect(parsed.layers).toHaveLength(1);
        expect(parsed.layers[0]).toMatchObject({ size: null, created: null });
    });
});

describe("resolveLayerIndex", () => {
    const byDiffId = layerIndexByDiffId([
        { diffId: "sha256:base", rootfsIndex: 0 },
        { diffId: null, rootfsIndex: null },
        { diffId: "sha256:apt", rootfsIndex: 1 },
    ]);

    it("takes the minimum over every location, never location 0 alone", () => {
        // A deb package under squashed scope: location 0 is dpkg's status file,
        // rewritten by the customer's apt-get; the copyright file kept the base.
        expect(resolveLayerIndex([
            prop("syft:location:0:layerID", "sha256:apt"),
            prop("syft:location:0:path", "/var/lib/dpkg/status"),
            prop("syft:location:1:layerID", "sha256:base"),
            prop("syft:location:1:path", "/usr/share/doc/libc6/copyright"),
        ], byDiffId)).toBe(0);
    });

    it("is null when no id resolves, or there is no layer list", () => {
        expect(resolveLayerIndex([prop("syft:location:0:layerID", "sha256:other")], byDiffId)).toBeNull();
        expect(resolveLayerIndex([prop("syft:location:0:layerID", "sha256:base")], new Map())).toBeNull();
        expect(resolveLayerIndex([], byDiffId)).toBeNull();
    });
});

describe("scannerVersionAtLeast", () => {
    it("compares numerically and refuses what it cannot read", () => {
        expect(scannerVersionAtLeast("0.4.0", "0.4.0")).toBe(true);
        expect(scannerVersionAtLeast("v0.10.1-rc.1", "0.4.0")).toBe(true);
        expect(scannerVersionAtLeast("0.3.9", "0.4.0")).toBe(false);
        expect(scannerVersionAtLeast("unknown", "0.4.0")).toBe(false);
        expect(scannerVersionAtLeast(null, "0.4.0")).toBe(false);
    });
});

describe("layersFromConfig (the registry backfill's reading of a config blob)", () => {
    it("walks history, giving the empty entries no layer", async () => {
        const { layersFromConfig } = await import("../../../src/services/image-layer-backfill.service.js");
        const layers = layersFromConfig({
            rootfs: { diff_ids: ["sha256:aa", "sha256:bb"] },
            history: [
                { created_by: "ADD rootfs.tar /", created: "2026-01-01T00:00:00Z" },
                { created_by: 'CMD ["sh"]', empty_layer: true },
                { created_by: `RUN ${"x".repeat(500)}` },
            ],
        })!;
        expect(layers.map((l) => [l.index, l.rootfsIndex, l.diffId])).toEqual([
            [0, 0, "sha256:aa"],
            [1, null, null],
            [2, 1, "sha256:bb"],
        ]);
        expect(layers[2]!.createdBy).toHaveLength(200);
    });

    it("falls back to bare layers when history does not account for them, and refuses no layers", async () => {
        const { layersFromConfig } = await import("../../../src/services/image-layer-backfill.service.js");
        expect(layersFromConfig({ rootfs: { diff_ids: ["sha256:aa"] }, history: [] })).toEqual([
            { index: 0, rootfsIndex: 0, diffId: "sha256:aa", createdBy: null, emptyLayer: false, size: null, created: null },
        ]);
        expect(layersFromConfig({ history: [{ created_by: "x" }] })).toBeNull();
    });
});
