/**
 * `lib/base-image.ts` — where the base image ends. Pure, so this is the
 * contract: three synthetic images (annotated, prefix-matched, unknown), the
 * signals' order, and the rules that keep a boundary honest.
 */

import { describe, it, expect } from "vitest";
import {
    chainHash,
    chainOf,
    fromBase,
    historyBoundary,
    prefixHashes,
    resolveBase,
    type BaseInput,
    type BaseLayer,
} from "../../../src/lib/base-image.js";

const id = (n: number) => `sha256:${String(n).padStart(64, "0")}`;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

/** A layer that exists. */
const layer = (n: number, rootfsIndex: number, createdBy: string, builtAt = T0): BaseLayer => ({
    rootfsIndex,
    diffId: id(n),
    createdBy,
    builtAt: new Date(builtAt),
});
/** A history entry that made no layer. */
const empty = (createdBy: string, builtAt = T0): BaseLayer => ({
    rootfsIndex: null,
    diffId: null,
    createdBy,
    builtAt: new Date(builtAt),
});

/** debian (1 layer) ⊂ node (3 layers) ⊂ the app (5 layers), built three weeks after its base. */
const APP: BaseLayer[] = [
    layer(1, 0, "ADD rootfs.tar.xz /"),
    empty('CMD ["bash"]'),
    layer(2, 1, "RUN groupadd node"),
    layer(3, 2, "RUN curl -fsSLO node.tar.xz"),
    empty('CMD ["node"]'),
    layer(4, 3, "COPY . /app", T0 + 21 * DAY),
    layer(5, 4, "RUN npm ci", T0 + 21 * DAY + 60_000),
    empty('CMD ["node" "server.js"]', T0 + 21 * DAY + 60_000),
];

const input = (overrides: Partial<BaseInput> = {}): BaseInput => ({
    layers: APP,
    facts: null,
    knownChains: [],
    siblings: [],
    ...overrides,
});

describe("prefixHashes", () => {
    it("hashes every prefix the way a whole chain is hashed", () => {
        const chain = chainOf(APP);
        expect(chain).toEqual([id(1), id(2), id(3), id(4), id(5)]);
        const hashes = prefixHashes(chain);
        expect(hashes).toHaveLength(5);
        expect(hashes[2]).toBe(chainHash(chain.slice(0, 3)));
        expect(hashes[4]).toBe(chainHash(chain));
    });
});

describe("resolveBase — the three synthetic images", () => {
    it("annotated: names the base, and counts it when that name's chain is known", () => {
        const facts = { baseName: "node:20-bookworm-slim" };
        expect(resolveBase(input({ facts }))).toEqual({
            baseImageRef: "node:20-bookworm-slim",
            baseLayerCount: null,
            detectedBy: "annotation",
        });

        const known = [
            { depth: 1, imageRef: "debian:bookworm-slim" },
            { depth: 3, imageRef: "docker.io/library/node:20-bookworm-slim" },
        ];
        expect(resolveBase(input({ facts, knownChains: known }))).toEqual({
            baseImageRef: "node:20-bookworm-slim",
            baseLayerCount: 3,
            detectedBy: "annotation",
        });
    });

    it("prefix-matched: the longest known chain below the image's own length is the base", () => {
        const known = [
            { depth: 1, imageRef: "debian:bookworm-slim" },
            { depth: 3, imageRef: "node:20-bookworm-slim" },
            // The image itself is known too — that is not a base.
            { depth: 5, imageRef: "acme/app:1.0" },
        ];
        expect(resolveBase(input({ knownChains: known }))).toEqual({
            baseImageRef: "node:20-bookworm-slim",
            baseLayerCount: 3,
            detectedBy: "known-image",
        });
    });

    it("unknown: nothing fires, nothing is claimed", () => {
        const flat: BaseLayer[] = [layer(1, 0, "COPY a /"), layer(2, 1, "COPY b /"), empty('CMD ["x"]')];
        expect(resolveBase(input({ layers: flat }))).toBeNull();
        expect(resolveBase(input({ layers: [] }))).toBeNull();
    });
});

describe("resolveBase — the other signals", () => {
    it("finds a golden base shared inside the org, named when a sibling is the prefix", () => {
        const golden = { imageRef: "registry.corp.example/base/node", diffIds: [id(1), id(2), id(3)] };
        const cousin = { imageRef: "registry.corp.example/team/other", diffIds: [id(1), id(2), id(3), id(9)] };
        expect(resolveBase(input({ siblings: [cousin] }))).toEqual({
            baseImageRef: null,
            baseLayerCount: 3,
            detectedBy: "org-prefix",
        });
        expect(resolveBase(input({ siblings: [cousin, golden] }))).toEqual({
            baseImageRef: golden.imageRef,
            baseLayerCount: 3,
            detectedBy: "org-prefix",
        });
        // One shared layer is a distro, not a golden base; an identical sibling is another tag of the same image.
        expect(
            resolveBase(
                input({
                    layers: APP.slice(0, 1).concat(layer(7, 1, "COPY")),
                    siblings: [{ imageRef: "x", diffIds: [id(1), id(8)] }],
                }),
            ),
        ).toBeNull();
    });

    it("reads the buildpacks run image's top layer", () => {
        const layers: BaseLayer[] = [1, 2, 3, 4].map((n) => ({
            rootfsIndex: n - 1,
            diffId: id(n),
            createdBy: null,
            builtAt: null,
        }));
        const facts = { buildpackRunImage: "paketobuildpacks/run-jammy-base", buildpackTopLayer: id(2) };
        expect(resolveBase(input({ layers, facts }))).toEqual({
            baseImageRef: "paketobuildpacks/run-jammy-base",
            baseLayerCount: 2,
            detectedBy: "buildpacks",
        });
    });

    it("history: a stage-ending CMD where the build times jump", () => {
        expect(historyBoundary(APP)).toBe(3);
        expect(resolveBase(input())).toEqual({ baseImageRef: null, baseLayerCount: 3, detectedBy: "history" });
    });

    it("history: no boundary when the two sub-signals disagree, or the times say nothing", () => {
        // The jump falls between two layers of one stage — no CMD ends anything there.
        const late = new Set([id(3), id(4), id(5)]);
        const disagree = APP.map((l) =>
            l.diffId !== null && late.has(l.diffId) ? { ...l, builtAt: new Date(T0 + 400 * DAY) } : l,
        );
        expect(historyBoundary(disagree)).toBeNull();
        // A reproducible build stamps every layer with one time.
        expect(historyBoundary(APP.map((l) => ({ ...l, builtAt: new Date(T0) })))).toBeNull();
        expect(historyBoundary(APP.map((l) => ({ ...l, builtAt: null })))).toBeNull();
    });

    it("prefers the stronger signal", () => {
        const known = [{ depth: 3, imageRef: "node:20-bookworm-slim" }];
        const sibling = { imageRef: "corp/base", diffIds: [id(1), id(2)] };
        expect(resolveBase(input({ knownChains: known, siblings: [sibling] }))?.detectedBy).toBe("known-image");
        expect(resolveBase(input({ siblings: [sibling] }))?.detectedBy).toBe("org-prefix");
    });
});

describe("fromBase", () => {
    it("cuts at the boundary", () => {
        expect(fromBase({ layerIndex: 2, tier: "application" }, 3, true)).toBe(true);
        expect(fromBase({ layerIndex: 3, tier: "application" }, 3, true)).toBe(false);
    });

    it("puts an apt-get install in the customer's own layer on their side", () => {
        expect(fromBase({ layerIndex: 4, tier: "os" }, 3, true)).toBe(false);
    });

    it("stays null without a boundary, without a layer, or for an OS package whose layer cannot be trusted", () => {
        expect(fromBase({ layerIndex: 2, tier: "application" }, null, true)).toBeNull();
        expect(fromBase({ layerIndex: null, tier: "application" }, 3, true)).toBeNull();
        expect(fromBase({ layerIndex: 4, tier: "os" }, 3, false)).toBeNull();
        expect(fromBase({ layerIndex: 4, tier: "application" }, 3, false)).toBe(false);
    });
});

describe("guessBaseRefs — names to verify, never to believe", () => {
    it("proposes the official tags a _VERSION env and the distro suggest", async () => {
        const { guessBaseRefs } = await import("../../../src/services/base-image.service.js");
        expect(guessBaseRefs({ "env:NODE_VERSION": "20.11.1" }, { id: "debian", version: "12.5" })).toEqual([
            "node:20.11.1-bookworm-slim",
            "node:20.11.1-slim-bookworm",
            "node:20.11.1-bookworm",
            "node:20.11.1-slim",
            "node:20.11.1",
        ]);
        expect(guessBaseRefs({ "env:PYTHON_VERSION": "3.12.4" }, { id: "alpine", version: "3.20.1" })).toEqual([
            "python:3.12.4-alpine3.20",
            "python:3.12.4-alpine",
        ]);
    });

    it("proposes nothing it cannot spell", async () => {
        const { guessBaseRefs } = await import("../../../src/services/base-image.service.js");
        expect(guessBaseRefs(null, { id: "debian", version: "12" })).toEqual([]);
        expect(guessBaseRefs({ "env:NODE_VERSION": "20.11.1" }, null)).toEqual([]);
        expect(guessBaseRefs({ "env:NODE_VERSION": "$(curl evil)" }, { id: "debian", version: "12" })).toEqual([]);
        expect(guessBaseRefs({ "env:JAVA_VERSION": "jdk-21.0.2+13" }, { id: "debian", version: "12" })).toEqual([]);
    });
});
