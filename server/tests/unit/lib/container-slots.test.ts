/**
 * The slot diff's outcome table — activity-feed.md §2. Each case here is a
 * row of that table, plus the rollout and mutable-tag cases the table
 * defers to §2.4 and §2.5. Pure, so no database.
 */

import { describe, it, expect } from "vitest";
import { diffSlots, isNoise, type SlotContainer } from "../../../src/lib/container-slots.js";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const C = `sha256:${"c".repeat(64)}`;

const T0 = new Date("2026-09-01T00:00:00Z");
const T1 = new Date("2026-09-02T00:00:00Z");

function slot(digest: string, overrides: Partial<SlotContainer> = {}): SlotContainer {
    return {
        namespace: "prod",
        workloadKind: "Deployment",
        workloadName: "web",
        containerName: "api",
        init: false,
        imageId: `image-${digest.slice(7, 9)}`,
        digest,
        repository: "acme/api",
        imageTag: "1.26",
        imageRef: `ghcr.io/acme/api@${digest}`,
        firstSeenAt: T0,
        ...overrides,
    };
}

describe("diffSlots", () => {
    it("reports nothing when nothing changed", () => {
        expect(diffSlots([slot(A)], [slot(A)])).toEqual([]);
    });

    it("— → A is appeared, and new to the cluster when no slot ran the digest", () => {
        const changes = diffSlots([], [slot(A)]);
        expect(changes).toEqual([{ kind: "appeared", to: slot(A), imageNew: true }]);
    });

    it("appeared is not imageNew when another slot already ran the digest", () => {
        const other = slot(A, { workloadName: "worker" });
        const changes = diffSlots([other], [other, slot(A)]);
        expect(changes).toEqual([{ kind: "appeared", to: slot(A), imageNew: false }]);
    });

    it("A → — is removed, and gone from the cluster when nothing else runs it", () => {
        expect(diffSlots([slot(A)], [])).toEqual([{ kind: "removed", from: slot(A), imageGone: true }]);
        const other = slot(A, { workloadName: "worker" });
        expect(diffSlots([slot(A), other], [other])).toEqual([{ kind: "removed", from: slot(A), imageGone: false }]);
    });

    it("A → B is image-changed", () => {
        const from = slot(A, { imageTag: "1.26" });
        const to = slot(B, { imageTag: "1.27", firstSeenAt: T1 });
        expect(diffSlots([from], [to])).toEqual([
            { kind: "image-changed", from, to, imageNew: true, imageGone: true, mutableTag: false },
        ]);
    });

    it("A → A with a new tag is retagged, never a deploy", () => {
        const from = slot(A, { imageTag: "1.26" });
        const to = slot(A, { imageTag: "1.27" });
        expect(diffSlots([from], [to])).toEqual([{ kind: "retagged", from, to }]);
    });

    it("a digest-pinned slot that gains a tag is a retag too", () => {
        const from = slot(A, { imageTag: null });
        const to = slot(A, { imageTag: "1.26" });
        expect(diffSlots([from], [to])).toMatchObject([{ kind: "retagged" }]);
    });

    it("a mutable tag re-pull is image-changed with mutableTag", () => {
        const from = slot(A, { imageTag: "latest" });
        const to = slot(B, { imageTag: "latest", firstSeenAt: T1 });
        expect(diffSlots([from], [to])).toMatchObject([{ kind: "image-changed", mutableTag: true }]);
    });

    it("two digest-pinned digests swapping is not a mutable tag", () => {
        const from = slot(A, { imageTag: null });
        const to = slot(B, { imageTag: null, firstSeenAt: T1 });
        expect(diffSlots([from], [to])).toMatchObject([{ kind: "image-changed", mutableTag: false }]);
    });

    describe("rollouts span reports", () => {
        it("A → {A, B} is rollout-started, not image-changed", () => {
            const a = slot(A);
            const b = slot(B, { firstSeenAt: T1 });
            expect(diffSlots([a], [a, b])).toEqual([{ kind: "rollout-started", from: a, to: b, imageNew: true }]);
        });

        it("{A, B} → B is image-changed A → B, emitted when A stops serving", () => {
            const a = slot(A);
            const b = slot(B, { firstSeenAt: T1 });
            expect(diffSlots([a, b], [b])).toEqual([
                { kind: "image-changed", from: a, to: b, imageNew: false, imageGone: true, mutableTag: true },
            ]);
        });

        it("a canary that never completes stays silent", () => {
            const a = slot(A);
            const b = slot(B, { firstSeenAt: T1 });
            expect(diffSlots([a, b], [a, b])).toEqual([]);
        });

        it("{A, B} → A (rollback) is image-changed B → A", () => {
            const a = slot(A);
            const b = slot(B, { firstSeenAt: T1 });
            expect(diffSlots([a, b], [a])).toMatchObject([{ kind: "image-changed", from: b, to: a }]);
        });

        it("{A, B} → C in one report is a move from each onto C", () => {
            const a = slot(A);
            const b = slot(B, { firstSeenAt: T1 });
            const c = slot(C, { firstSeenAt: new Date("2026-09-03T00:00:00Z") });
            const changes = diffSlots([a, b], [c]);
            expect(changes).toHaveLength(2);
            expect(changes).toMatchObject([
                { kind: "image-changed", from: b, to: c },
                { kind: "image-changed", from: a, to: c },
            ]);
        });

        it("a retag on the surviving digest is still reported mid-rollout", () => {
            const a = slot(A, { imageTag: "1.26" });
            const a2 = slot(A, { imageTag: "1.26-old" });
            const b = slot(B, { firstSeenAt: T1 });
            expect(diffSlots([a], [a2, b])).toMatchObject([
                { kind: "rollout-started", to: b },
                { kind: "retagged", from: a, to: a2 },
            ]);
        });
    });

    describe("slot identity", () => {
        it("keys on namespace, workload and container name — not kind", () => {
            const before = slot(A, { workloadKind: null });
            const after = slot(A, { workloadKind: "Deployment" });
            expect(diffSlots([before], [after])).toEqual([]);
        });

        it("the same container name in two workloads is two slots", () => {
            const web = slot(A);
            const worker = slot(B, { workloadName: "worker" });
            expect(diffSlots([web, worker], [web, slot(C, { workloadName: "worker" })])).toMatchObject([
                { kind: "image-changed", from: worker },
            ]);
        });

        it("the same workload name in two namespaces is two slots", () => {
            const prod = slot(A);
            const staging = slot(A, { namespace: "staging" });
            expect(diffSlots([prod, staging], [prod])).toMatchObject([
                { kind: "removed", from: staging, imageGone: false },
            ]);
        });
    });
});

describe("isNoise", () => {
    it("elides appear/remove for CronJob and Job pods whose image the cluster already knows", () => {
        const cron = slot(A, { workloadKind: "CronJob", workloadName: "nightly" });
        expect(isNoise({ kind: "appeared", to: cron, imageNew: false })).toBe(true);
        expect(isNoise({ kind: "removed", from: cron, imageGone: false })).toBe(true);
        const job = slot(A, { workloadKind: "Job", workloadName: "migrate" });
        expect(isNoise({ kind: "appeared", to: job, imageNew: false })).toBe(true);
    });

    it("keeps them when the image is new to, or gone from, the cluster", () => {
        const cron = slot(A, { workloadKind: "CronJob", workloadName: "nightly" });
        expect(isNoise({ kind: "appeared", to: cron, imageNew: true })).toBe(false);
        expect(isNoise({ kind: "removed", from: cron, imageGone: true })).toBe(false);
    });

    it("never elides a Deployment, an unknown kind, a move or a retag", () => {
        expect(isNoise({ kind: "appeared", to: slot(A), imageNew: false })).toBe(false);
        expect(isNoise({ kind: "appeared", to: slot(A, { workloadKind: null }), imageNew: false })).toBe(false);
        const cron = slot(A, { workloadKind: "CronJob" });
        const cronB = slot(B, { workloadKind: "CronJob" });
        expect(
            isNoise({
                kind: "image-changed",
                from: cron,
                to: cronB,
                imageNew: false,
                imageGone: false,
                mutableTag: false,
            }),
        ).toBe(false);
        expect(isNoise({ kind: "retagged", from: cron, to: { ...cron, imageTag: "2" } })).toBe(false);
    });
});
