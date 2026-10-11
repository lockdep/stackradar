/**
 * The slot diff behind the activity feed.
 *
 * An inventory report is a full set replacement, and `workload_containers`
 * is keyed on the digest, so `api` moving from digest A to digest B is one
 * row deleted and one inserted with nothing naming the thing that moved.
 * This module names it. A **slot** is a workload plus a container name —
 * `prod/web` × `api` — and the diff is computed per slot over the set of
 * digests it ran before the report and the set it runs after.
 *
 * Pure: the repository reads the before-state, writes the after-state and
 * feeds both in here, so every outcome in the proposal's table is a case a
 * unit test can spell out without a database.
 *
 * The slot key deliberately leaves the workload **kind** out. A kind that
 * flips between `null` and `Deployment` when RBAC changes is the same
 * running thing, and treating it as a remove-and-appear would report a
 * permissions change as a deploy.
 */

export interface SlotContainer {
    namespace: string;
    /** `null` = unknown — never guessed. Carried, not keyed on. */
    workloadKind: string | null;
    workloadName: string;
    containerName: string;
    init: boolean;
    imageId: string;
    digest: string;
    repository: string | null;
    /** `null` = digest-pinned. */
    imageTag: string | null;
    imageRef: string;
    /**
     * When this (slot, digest) was first seen. On the before side it is the
     * container row's `first_seen_at`; on the after side it is the report
     * time for a new pair and the before value for a surviving one. Orders
     * the digests of a mid-rollout slot, so a rollout that completes can
     * name the digest it completed *to*.
     */
    firstSeenAt: Date;
}

export type SlotChange =
    /** Nothing ran in the slot before; digest `to` runs now. */
    | { kind: "appeared"; to: SlotContainer; imageNew: boolean }
    /** Digest `from` ran; nothing in the slot runs now. */
    | { kind: "removed"; from: SlotContainer; imageGone: boolean }
    /**
     * `from` stopped serving and `to` runs — a clean swap in one report, or
     * the close of a rollout that `rollout-started` opened earlier.
     * `mutableTag`: equal, non-null tags on both sides, so the tag was never
     * the thing that changed — a `:latest` that silently re-pulled.
     */
    | {
          kind: "image-changed";
          from: SlotContainer;
          to: SlotContainer;
          imageNew: boolean;
          imageGone: boolean;
          mutableTag: boolean;
      }
    /** `to` started running beside `from`, which is still serving. */
    | { kind: "rollout-started"; from: SlotContainer; to: SlotContainer; imageNew: boolean }
    /** Same digest, different tag. The running bytes did not change. */
    | { kind: "retagged"; from: SlotContainer; to: SlotContainer };

/** `namespace/workload/container` — the three names are DNS labels, so `/` cannot occur in any of them. */
export const slotKey = (c: Pick<SlotContainer, "namespace" | "workloadName" | "containerName">) =>
    `${c.namespace}/${c.workloadName}/${c.containerName}`;

/** Newest first, so `[0]` of a mid-rollout slot is the digest being rolled *to*. */
const newestFirst = (a: SlotContainer, b: SlotContainer) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime();

/**
 * Diff a cluster's containers before and after one report, per slot.
 *
 * `imageNew` / `imageGone` are cluster-level facts — was the digest running
 * *anywhere* in the cluster before, does it run anywhere after — computed
 * here because the caller has both sets in hand and the feed's "images
 * appeared / went away" summary folds out of them (§5) with no extra write.
 */
export function diffSlots(before: SlotContainer[], after: SlotContainer[]): SlotChange[] {
    const digestsBefore = new Set(before.map((c) => c.digest));
    const digestsAfter = new Set(after.map((c) => c.digest));
    const imageNew = (c: SlotContainer) => !digestsBefore.has(c.digest);
    const imageGone = (c: SlotContainer) => !digestsAfter.has(c.digest);

    const bySlot = new Map<string, { before: SlotContainer[]; after: SlotContainer[] }>();
    const slot = (c: SlotContainer) => {
        const key = slotKey(c);
        let entry = bySlot.get(key);
        if (!entry) bySlot.set(key, (entry = { before: [], after: [] }));
        return entry;
    };
    for (const c of before) slot(c).before.push(c);
    for (const c of after) slot(c).after.push(c);

    const changes: SlotChange[] = [];

    for (const { before: b, after: a } of bySlot.values()) {
        const beforeByDigest = new Map(b.map((c) => [c.digest, c]));
        const afterByDigest = new Map(a.map((c) => [c.digest, c]));

        const stayed = a.filter((c) => beforeByDigest.has(c.digest)).sort(newestFirst);
        const added = a.filter((c) => !beforeByDigest.has(c.digest)).sort(newestFirst);
        const removed = b.filter((c) => !afterByDigest.has(c.digest)).sort(newestFirst);

        if (b.length === 0) {
            for (const to of added) changes.push({ kind: "appeared", to, imageNew: imageNew(to) });
        } else if (a.length === 0) {
            for (const from of removed) changes.push({ kind: "removed", from, imageGone: imageGone(from) });
        } else if (added.length === 1 && removed.length === 1 && stayed.length === 0) {
            changes.push(imageChanged(removed[0]!, added[0]!, imageNew, imageGone));
        } else {
            /*
             * Mixed: something survived the report. Anything that left has
             * stopped serving in favour of what arrived (or what survived) —
             * a rollout completing — and anything that arrived beside a
             * survivor is a rollout starting.
             */
            const target = added[0] ?? stayed[0]!;
            for (const from of removed) changes.push(imageChanged(from, target, imageNew, imageGone));
            for (const to of added) {
                if (removed.length > 0 && to === target) continue;
                changes.push({ kind: "rollout-started", from: stayed[0] ?? target, to, imageNew: imageNew(to) });
            }
        }

        for (const to of stayed) {
            const from = beforeByDigest.get(to.digest)!;
            if (from.imageTag !== to.imageTag) changes.push({ kind: "retagged", from, to });
        }
    }

    return changes;
}

function imageChanged(
    from: SlotContainer,
    to: SlotContainer,
    imageNew: (c: SlotContainer) => boolean,
    imageGone: (c: SlotContainer) => boolean,
): SlotChange {
    return {
        kind: "image-changed",
        from,
        to,
        imageNew: imageNew(to),
        imageGone: imageGone(from),
        mutableTag: from.imageTag !== null && from.imageTag === to.imageTag,
    };
}

/**
 * Kinds whose pods come and go on a schedule. Their appear/remove churn is
 * elided from the feed unless the *image* is new to (or gone from) the
 * cluster — §8. History rows are still written; only the event is skipped.
 * `image-changed` and `retagged` are never elided: they are what the feed
 * exists for.
 */
const SCHEDULED_KINDS = new Set(["cronjob", "job"]);

export function isNoise(change: SlotChange): boolean {
    if (change.kind === "appeared") {
        return SCHEDULED_KINDS.has((change.to.workloadKind ?? "").toLowerCase()) && !change.imageNew;
    }
    if (change.kind === "removed") {
        return SCHEDULED_KINDS.has((change.from.workloadKind ?? "").toLowerCase()) && !change.imageGone;
    }
    return false;
}

/** The half of a container event's payload that names one side of a move. */
export interface ContainerSidePayload {
    imageId: string;
    digest: string;
    tag: string | null;
    ref: string;
}

export function sidePayload(c: SlotContainer): ContainerSidePayload {
    return { imageId: c.imageId, digest: c.digest, tag: c.imageTag, ref: c.imageRef };
}
