import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { getPlanLimits } from "../config/plans.js";
import { comparableFindings, identityOfKey, type ComparableFinding } from "../db/finding-delta.js";
import { containerHistoryRepository, scannedImages, slotRefKey, type SlotHistory, type SlotRef } from "../repositories/container-history.repository.js";
import { exposureRepository, type RunningSlot } from "../repositories/exposure.repository.js";
import {
    earliestPresence,
    exposureOf,
    presenceOnSlot,
    remediationWindows,
    type Exposure,
    type ImageFindingKeys,
    type LowerBoundReason,
    type Presence,
    type RemediationWindow,
    type SlotHistoryInput,
} from "../lib/exposure.js";

/**
 * The database half of exposure duration —
 * [exposure-duration-plan](../../../docs/exposure-duration-plan-2026-09-19.md).
 * `lib/exposure.ts` is the definition; this reads what it needs: each slot's
 * intervals, the finding keys of every image on them, when the cluster was
 * first observed and how far back the plan's retention reaches.
 *
 * One history read and one `comparableFindings` call per walk, whatever the
 * number of slots — and both are budgeted, because a vulnerability that
 * reaches a whole fleet must not make its page slow. Everything past a budget
 * degrades to a lower bound or to `truncated`, never to a wrong figure.
 */

/** Slots past this are not walked; the caller reports `exposureTruncated`. */
export const MAX_WALKED_SLOTS = 300;

/**
 * Images past this are left out of the findings read, oldest intervals first.
 * A left-out image reads as collected, so the walk stops at it with a lower
 * bound — which is exactly what "we did not look" means.
 */
export const MAX_WALKED_IMAGES = 600;

export interface SlotWalk {
    /** Slots were dropped to stay inside {@link MAX_WALKED_SLOTS}. */
    truncated: boolean;
    /** Comparable findings of every walked, scanned image. */
    findings: ReadonlyMap<string, ComparableFinding[]>;
    /** The finding keys on the slot's running digests. */
    runningKeys(slot: SlotRef): string[];
    /** The finding keys on any digest the slot has run, as far as the walk read. */
    everKeys(slot: SlotRef): string[];
    /** Since when `key` has been on the slot; null when no running digest carries it. */
    presence(slot: SlotRef, key: string): Presence | null;
    /** The earliest presence among the slot's running keys of one advisory identity. */
    presenceOfIdentity(slot: SlotRef, identity: string): Presence | null;
    /** Closed runs of `key` on the slot that ended in a clean digest. */
    remediations(slot: SlotRef, key: string, publishedAt: Date | null): RemediationWindow[];
}

async function retentionCutoff(orgId: string): Promise<Date> {
    const [org] = await db
        .select({ plan: schema.organizations.plan })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - getPlanLimits(org?.plan ?? "free").historyDays);
    return cutoff;
}

/**
 * Walk these slots' history. `identity` narrows the findings read to one
 * advisory — the vulnerability page asks about one, and has no use for the
 * thousands of other findings on the images it walks.
 */
export async function walkSlots(
    orgId: string,
    slots: (SlotRef & { workloadFirstStartedAt?: Date | null })[],
    { identity, maxImages = MAX_WALKED_IMAGES }: {
        identity?: string;
        /** A walk that reads *every* finding of its images (no `identity`) should ask for far fewer of them. */
        maxImages?: number;
    } = {}
): Promise<SlotWalk> {
    const walked = slots.slice(0, MAX_WALKED_SLOTS);
    const clusterIds = [...new Set(walked.map((slot) => slot.clusterId))];

    const [histories, observationStarts, cutoff] = await Promise.all([
        containerHistoryRepository.findBySlots(orgId, walked),
        exposureRepository.observationStarts(orgId, clusterIds),
        retentionCutoff(orgId),
    ]);

    // Newest intervals first across every slot, so the budget spends itself
    // on the running digests and their nearest predecessors.
    const byRecency = [...histories.values()]
        .flatMap((history) => history.intervals)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const imageIds: string[] = [];
    const seen = new Set<string>();
    for (const interval of byRecency) {
        if (!interval.imageId || seen.has(interval.imageId)) continue;
        if (imageIds.length >= maxImages) break;
        seen.add(interval.imageId);
        imageIds.push(interval.imageId);
    }

    const scanned = await scannedImages(db, imageIds);
    const scannedIds = imageIds.filter((id) => scanned.has(id));
    const findings = await comparableFindings(scannedIds, db, identity);

    const keys: Map<string, ReadonlySet<string> | "unscanned"> = new Map();
    for (const id of imageIds) {
        keys.set(id, scanned.has(id) ? new Set((findings.get(id) ?? []).map((f) => f.key)) : "unscanned");
    }
    const findingKeys: ImageFindingKeys = keys;

    const firstStarted = new Map(walked.map((slot) => [slotRefKey(slot), slot.workloadFirstStartedAt ?? null]));
    const EMPTY: SlotHistory = { intervals: [], truncated: false };

    const inputFor = (slot: SlotRef, key: string): SlotHistoryInput => {
        const history = histories.get(slotRefKey(slot)) ?? EMPTY;
        return {
            intervals: history.intervals,
            findings: findingKeys,
            key,
            observationStart: observationStarts.get(slot.clusterId) ?? null,
            retentionCutoff: cutoff,
            workloadFirstStartedAt: firstStarted.get(slotRefKey(slot)) ?? null,
            truncated: history.truncated,
        };
    };

    const keysOn = (slot: SlotRef, runningOnly: boolean): string[] => {
        const history = histories.get(slotRefKey(slot)) ?? EMPTY;
        const out = new Set<string>();
        for (const interval of history.intervals) {
            if ((runningOnly && interval.endedAt !== null) || !interval.imageId) continue;
            const carried = findingKeys.get(interval.imageId);
            if (carried && carried !== "unscanned") for (const key of carried) out.add(key);
        }
        return [...out];
    };
    const runningKeys = (slot: SlotRef) => keysOn(slot, true);

    return {
        truncated: slots.length > walked.length,
        findings,
        runningKeys,
        everKeys: (slot) => keysOn(slot, false),
        presence: (slot, key) => presenceOnSlot(inputFor(slot, key)),
        presenceOfIdentity: (slot, wanted) =>
            earliestPresence(
                runningKeys(slot)
                    .filter((key) => identityOfKey(key) === wanted)
                    .map((key) => presenceOnSlot(inputFor(slot, key)))
            ),
        remediations: (slot, key, publishedAt) => remediationWindows({ ...inputFor(slot, key), publishedAt }),
    };
}

/**
 * The image budget of a walk that reads whole finding sets — a dashboard
 * unfold, a container page. Forty digests is a slot's weekly deploys for most
 * of a year; past it the walk stops at a lower bound.
 */
export const MAX_WALKED_IMAGES_ALL_FINDINGS = 40;

/** `clusterId/namespace/workload` — how an occurrences row, which has no workload id, finds its slots. */
export const workloadRefKey = (w: { clusterId: string; namespace: string; workloadName: string }) =>
    `${w.clusterId}/${w.namespace}/${w.workloadName}`;

export interface IdentityExposure {
    /** Presence per workload ({@link workloadRefKey}), folded across its slots: earliest wins, flag follows the winner. */
    byWorkload: Map<string, Presence>;
    detectedAt: Date | null;
    truncated: boolean;
    /** Every slot running an affected image, walked or not. */
    slots: RunningSlot[];
    walk: SlotWalk;
}

export interface ContainerExposure {
    /** By advisory id — the identity's CVE (or stand-alone id) and every record id that carries it here. */
    findings: Record<string, Exposure>;
    /** The container's one figure, and the finding it is about. Null when nothing qualifies — never zero. */
    longest: {
        kind: "exploited" | "exposed";
        vulnId: string;
        since: Date;
        isLowerBound: boolean;
        lowerBoundReason: LowerBoundReason | null;
    } | null;
}

/**
 * Time-to-remediate for one advisory: the containers where it ran and the
 * digest that replaced it is demonstrably clean. The definition is still
 * young — it is computed at read time and stored nowhere (plan item 6).
 */
export interface IdentityRemediation {
    /** Containers (slots) with at least one closed, remediated window. */
    containers: number;
    /** Median of each container's most recent window, in whole days. Null when `containers` is 0. */
    medianDays: number | null;
    /** Some window's start is a lower bound that won the `max`: the median is "at least". */
    medianIsLowerBound: boolean;
    /** More former slots exist than were walked. */
    truncated: boolean;
}

export const exposureService = {
    async remediationForIdentity(orgId: string, identity: string): Promise<IdentityRemediation> {
        const [slots, { publishedAt }] = await Promise.all([
            exposureRepository.formerSlotsForIdentity(orgId, identity, MAX_WALKED_SLOTS + 1),
            exposureRepository.datesOfIdentity(identity),
        ]);
        const none: IdentityRemediation = { containers: 0, medianDays: null, medianIsLowerBound: false, truncated: false };
        if (slots.length === 0) return none;
        const walk = await walkSlots(orgId, slots, { identity });

        const latest: RemediationWindow[] = [];
        for (const slot of slots.slice(0, MAX_WALKED_SLOTS)) {
            const windows = walk
                .everKeys(slot)
                .filter((key) => identityOfKey(key) === identity)
                .flatMap((key) => walk.remediations(slot, key, publishedAt));
            // A slot still running the advisory through another package has not fixed it.
            if (windows.length === 0 || walk.presenceOfIdentity(slot, identity)) continue;
            latest.push(windows.reduce((a, b) => (b.remediatedAt > a.remediatedAt ? b : a)));
        }
        if (latest.length === 0) return { ...none, truncated: walk.truncated };

        const sorted = latest.map((w) => w.timeToRemediateMs).sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const medianMs = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
        return {
            containers: latest.length,
            medianDays: Math.floor(medianMs / 86_400_000),
            medianIsLowerBound: latest.some((w) => w.timeToRemediateIsLowerBound),
            truncated: walk.truncated,
        };
    },

    /**
     * One advisory identity on each container running one image — the
     * dashboard's containers table under an affected image. Per container
     * and stitched across digests, which is the point: a container that
     * rolled onto this image last week may have carried the advisory, on
     * the image before it, for months. Keyed by container id; a container
     * with no history yet is absent, never zero.
     */
    async forIdentityOnImage(orgId: string, identity: string, imageId: string): Promise<Record<string, Exposure>> {
        const [slots, dates] = await Promise.all([
            exposureRepository.runningSlotsOfImages(orgId, [imageId]),
            exposureRepository.datesOfIdentity(identity),
        ]);
        if (slots.length === 0) return {};
        const walk = await walkSlots(orgId, slots, { identity });
        const out: Record<string, Exposure> = {};
        for (const slot of slots.slice(0, MAX_WALKED_SLOTS)) {
            const presence = walk.presenceOfIdentity(slot, identity);
            if (presence) out[slot.containerId] = exposureOf(presence, dates.publishedAt, dates.kevListedAt);
        }
        return out;
    },

    /**
     * One advisory identity on every container running an affected image —
     * the dashboard's flat containers table. The occurrences rows it sits
     * beside are per workload and name one container each, so every
     * container answers with its workload's figure ({@link forIdentity}'s
     * fold), whichever of them the row happens to name.
     */
    async forIdentityByContainer(orgId: string, identity: string): Promise<{ containers: Record<string, Exposure>; truncated: boolean }> {
        const [exposed, dates] = await Promise.all([
            exposureService.forIdentity(orgId, identity),
            exposureRepository.datesOfIdentity(identity),
        ]);
        const containers: Record<string, Exposure> = {};
        for (const slot of exposed.slots) {
            const presence = exposed.byWorkload.get(workloadRefKey(slot));
            if (presence) containers[slot.containerId] = exposureOf(presence, dates.publishedAt, dates.kevListedAt);
        }
        return { containers, truncated: exposed.truncated };
    },

    /**
     * Every finding key on one running image, folded across the slots that
     * run it (earliest wins) — the dashboard's "in this image for". One
     * history read and one findings read, shared by all the keys.
     */
    async forImage(orgId: string, imageId: string): Promise<(key: string) => Presence | null> {
        const slots = await exposureRepository.runningSlotsOfImages(orgId, [imageId]);
        if (slots.length === 0) return () => null;
        const walk = await walkSlots(orgId, slots, { maxImages: MAX_WALKED_IMAGES_ALL_FINDINGS });
        return (key) => earliestPresence(slots.slice(0, MAX_WALKED_SLOTS).map((slot) => walk.presence(slot, key)));
    },

    /**
     * Every advisory on one container, scoped to its slot — the container
     * page's Exposed column — plus the container's one headline figure.
     *
     * A container has hundreds of findings, so "its exposure" needs a
     * definition: **the longest `exploitedSince`, else the longest
     * `exposedSince` among critical and high findings**, naming the finding.
     * Per identity, as on the vulnerability page: an advisory that reaches
     * the slot through several packages is exposed since the earliest.
     */
    async forContainer(orgId: string, containerId: string): Promise<ContainerExposure> {
        const slot = await exposureRepository.runningSlotOfContainer(orgId, containerId);
        if (!slot) return { findings: {}, longest: null };
        const walk = await walkSlots(orgId, [slot], { maxImages: MAX_WALKED_IMAGES_ALL_FINDINGS });

        const running = walk.findings.get(slot.imageId) ?? [];
        const dates = await exposureRepository.advisoryDatesByVulnId(running.map((f) => f.vulnId));

        const findings: ContainerExposure["findings"] = {};
        const byIdentity = new Map<string, ComparableFinding[]>();
        for (const f of running) {
            const identity = identityOfKey(f.key);
            byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), f]);
        }

        let longest: ContainerExposure["longest"] = null;
        const consider = (candidate: NonNullable<ContainerExposure["longest"]>) => {
            // Any exploited figure outranks any exposed one; within a kind the earliest wins.
            if (!longest || (candidate.kind === "exploited" && longest.kind === "exposed")) longest = candidate;
            else if (candidate.kind === longest.kind && candidate.since < longest.since) longest = candidate;
        };

        for (const [identity, members] of byIdentity) {
            const presence = earliestPresence(members.map((f) => walk.presence(slot, f.key)));
            if (!presence) continue;
            const head = members[0]!;
            const when = dates.get(head.vulnId);
            const exposure = exposureOf(presence, when?.publishedAt ?? null, when?.kevListedAt ?? null);
            // Under every id a finding row may show for it: the identity
            // (a CVE, or a stand-alone id behind its `#`) and each member's own.
            for (const id of new Set([identity.replace(/^#/, ""), ...members.map((f) => f.vulnId)])) findings[id] = exposure;

            if (exposure.exploitedSince) {
                consider({ kind: "exploited", vulnId: head.vulnId, since: exposure.exploitedSince, isLowerBound: exposure.exploitedSinceIsLowerBound, lowerBoundReason: exposure.exploitedSinceIsLowerBound ? exposure.lowerBoundReason : null });
            } else if (exposure.exposedSince && members.some((f) => ["critical", "high"].includes((f.severityLevel ?? "").toLowerCase()))) {
                consider({ kind: "exposed", vulnId: head.vulnId, since: exposure.exposedSince, isLowerBound: exposure.exposedSinceIsLowerBound, lowerBoundReason: exposure.exposedSinceIsLowerBound ? exposure.lowerBoundReason : null });
            }
        }

        return { findings, longest };
    },

    /** One advisory identity across the org — the vulnerability page's exposure. */
    async forIdentity(orgId: string, identity: string): Promise<IdentityExposure> {
        const [slots, detectedAt] = await Promise.all([
            exposureRepository.runningSlotsForIdentity(orgId, identity),
            exposureRepository.detectedAt(orgId, identity),
        ]);
        const walk = await walkSlots(orgId, slots, { identity });

        const perWorkload = new Map<string, (Presence | null)[]>();
        for (const slot of slots.slice(0, MAX_WALKED_SLOTS)) {
            const key = workloadRefKey(slot);
            const list = perWorkload.get(key) ?? [];
            list.push(walk.presenceOfIdentity(slot, identity));
            perWorkload.set(key, list);
        }
        const byWorkload = new Map<string, Presence>();
        for (const [key, list] of perWorkload) {
            const presence = earliestPresence(list);
            if (presence) byWorkload.set(key, presence);
        }

        return { byWorkload, detectedAt, truncated: walk.truncated, slots, walk };
    },
};
