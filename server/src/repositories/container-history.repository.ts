import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
import { PLAN_LIMITS, getPlanLimits, type PlanType } from "../config/plans.js";
import { comparableFindings, countByBucket, countByLens, countBySeverity, diffFindings, summariseDelta, type ComparableFinding, type DeltaSummary, type LensBreakdown, type SeverityBreakdown } from "../db/finding-delta.js";
import type { NewActivityEvent } from "../db/schema/remediation.js";
import type { NewWorkloadContainerHistory, WorkloadContainerHistory } from "../db/schema/workload-container-history.js";
import { diffSlots, isNoise, sidePayload, slotKey, type SlotChange, type SlotContainer } from "../lib/container-slots.js";

/**
 * Writing `workload_container_history` and the container events —
 * [activity-feed.md](../../../docs/proposals/activity-feed.md) §2, §4, §5, §8.
 *
 * Everything here runs inside the inventory transaction: the before-state is
 * read before the upsert destroys it, the diff runs in memory after the
 * prune, and the intervals and events commit with the report or not at all.
 * Reading the before-state and diffing in TypeScript is deliberate —
 * Postgres cannot return the pre-update row from `ON CONFLICT DO UPDATE`,
 * and the `xmax` trick is fragile.
 */

const BATCH = 500;

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

const intervalKey = (c: Pick<SlotContainer, "namespace" | "workloadName" | "containerName" | "digest">) =>
    `${slotKey(c)}@${c.digest}`;

/**
 * The cluster's containers as they are *now*, in slot form. One query; the
 * contract caps a cluster at ten thousand containers.
 */
export async function readSlotState(tx: Transaction, clusterId: string): Promise<SlotContainer[]> {
    const rows = await tx
        .select({
            namespace: schema.namespaces.name,
            workloadKind: schema.workloads.kind,
            workloadName: schema.workloads.name,
            containerName: schema.workloadContainers.name,
            init: schema.workloadContainers.init,
            imageId: schema.workloadContainers.imageId,
            digest: schema.images.digest,
            repository: schema.images.repository,
            imageTag: schema.workloadContainers.imageTag,
            imageRef: schema.workloadContainers.imageRef,
            firstSeenAt: schema.workloadContainers.firstSeenAt,
        })
        .from(schema.workloadContainers)
        .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
        .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
        .innerJoin(schema.images, eq(schema.workloadContainers.imageId, schema.images.id))
        .where(eq(schema.namespaces.clusterId, clusterId));
    return rows;
}

/**
 * Bring the interval table up to date with the report and append the events
 * the diff produced.
 *
 * Intervals are reconciled against the **open intervals**, not against the
 * diff: every (slot, digest) running after the report has exactly one open
 * interval afterwards, and every open interval whose pair no longer runs is
 * closed. The two agree whenever history has kept up, and when it has not —
 * the day this ships, a cluster whose rows predate the table — the
 * reconciliation opens intervals for what is already running, dated from the
 * container's `first_seen_at`, and emits nothing. That is the proposal's
 * one-off backfill of appearances (§5), done inline rather than by a script.
 *
 * Events come from the diff of the live table alone, so a backfilled interval
 * never reads as a deploy.
 */
export async function recordSlotHistory(
    tx: Transaction,
    orgId: string,
    clusterId: string,
    before: SlotContainer[],
    after: SlotContainer[],
    workloadIds: Map<string, string>,
    reportedAt: Date
): Promise<{ opened: number; closed: number; events: number }> {
    const open = await tx
        .select()
        .from(schema.workloadContainerHistory)
        .where(and(
            eq(schema.workloadContainerHistory.clusterId, clusterId),
            isNull(schema.workloadContainerHistory.endedAt)
        ));
    const openByKey = new Map<string, WorkloadContainerHistory>(open.map((row) => [intervalKey(row), row]));

    const toOpen: NewWorkloadContainerHistory[] = [];
    const toClose: string[] = [];
    const seen = new Set<string>();

    for (const c of after) {
        const key = intervalKey(c);
        if (seen.has(key)) continue;
        seen.add(key);
        const workloadId = workloadIds.get(slotKey(c)) ?? null;
        const existing = openByKey.get(key);
        if (!existing) {
            toOpen.push({
                orgId,
                clusterId,
                workloadId,
                namespace: c.namespace,
                workloadKind: c.workloadKind,
                workloadName: c.workloadName,
                containerName: c.containerName,
                init: c.init,
                imageId: c.imageId,
                digest: c.digest,
                repository: c.repository,
                imageTag: c.imageTag,
                imageRef: c.imageRef,
                startedAt: c.firstSeenAt,
            });
            continue;
        }
        // A retag, a workload recreated under a new id, a kind that resolved:
        // the open interval is the current fact and follows the report.
        if (
            existing.imageTag !== c.imageTag ||
            existing.imageRef !== c.imageRef ||
            existing.workloadId !== workloadId ||
            existing.workloadKind !== c.workloadKind ||
            existing.imageId !== c.imageId ||
            existing.init !== c.init
        ) {
            await tx
                .update(schema.workloadContainerHistory)
                .set({
                    imageTag: c.imageTag,
                    imageRef: c.imageRef,
                    workloadId,
                    workloadKind: c.workloadKind,
                    imageId: c.imageId,
                    init: c.init,
                })
                .where(eq(schema.workloadContainerHistory.id, existing.id));
        }
    }

    for (const [key, row] of openByKey) {
        if (!seen.has(key)) toClose.push(row.id);
    }

    for (const batch of chunk(toOpen, BATCH)) {
        await tx.insert(schema.workloadContainerHistory).values(batch);
    }
    for (const batch of chunk(toClose, BATCH)) {
        await tx
            .update(schema.workloadContainerHistory)
            .set({ endedAt: reportedAt })
            .where(inArray(schema.workloadContainerHistory.id, batch));
    }

    const changes = diffSlots(before, after).filter((change) => !isNoise(change));
    const events = await containerEvents(tx, orgId, clusterId, changes, reportedAt);
    for (const batch of chunk(events, BATCH)) {
        await tx.insert(schema.activityEvents).values(batch);
    }

    return { opened: toOpen.length, closed: toClose.length, events: events.length };
}

// The summary plus the per-band counts the feed's severity squares draw.
// Not on `DeltaSummary` itself: that shape is shared with the chart index
// through a byte-equal fixture, and only the feed needs the bands.
type MoveDelta = DeltaSummary & {
    resolvedBySeverity: SeverityBreakdown;
    introducedBySeverity: SeverityBreakdown;
    /** `introducedBySeverity` under each tier lens (`finding-tier.ts`). */
    introducedByLens: LensBreakdown;
    /** Scored arrivals per plain bucket — see `countByBucket`. */
    introducedByBucket: { application: number; base: number; unknown: number };
};

/**
 * The images among `imageIds` that have been scanned — a *successful* scan
 * run, not merely an SBOM. An SBOM whose scan failed has zero findings on
 * record, and measuring a move against it would report every finding of
 * the new digest as introduced.
 */
export async function scannedImages(executor: typeof db | Transaction, imageIds: string[]): Promise<Set<string>> {
    if (imageIds.length === 0) return new Set();
    const rows = await executor
        .selectDistinct({ imageId: schema.vulnerabilityScanRuns.imageId })
        .from(schema.vulnerabilityScanRuns)
        .where(and(
            inArray(schema.vulnerabilityScanRuns.imageId, imageIds),
            eq(schema.vulnerabilityScanRuns.status, "success")
        ));
    return new Set(rows.map((row) => row.imageId));
}

/**
 * What a move bought, or which side could not be measured. `scanned` is the
 * set of image ids with a successful scan; `findings` their comparable findings.
 */
function measureMove(
    fromId: string,
    toId: string,
    scanned: ReadonlySet<string>,
    findings: ReadonlyMap<string, ComparableFinding[]>
): { delta: MoveDelta | null; deltaUnavailable: string | null } {
    if (!scanned.has(fromId)) return { delta: null, deltaUnavailable: "from-unscanned" };
    if (!scanned.has(toId)) return { delta: null, deltaUnavailable: "to-unscanned" };
    const delta = diffFindings(fromId, toId, findings.get(fromId) ?? [], findings.get(toId) ?? []);
    return {
        delta: {
            ...summariseDelta(delta),
            resolvedBySeverity: countBySeverity(delta.resolved),
            introducedBySeverity: countBySeverity(delta.introduced),
            introducedByLens: countByLens(delta.introduced),
            introducedByBucket: countByBucket(delta.introduced),
        },
        deltaUnavailable: null,
    };
}

/**
 * Finish the measurement a move could not make at the time. The inventory
 * report usually lands minutes before the new digest's first scan, so the
 * move is written as `to-unscanned`; when that scan completes, the moves
 * *to* this image are measured against their from-digest — the same
 * measurement, made late. The from side may be gone by now (image GC), in
 * which case the move stays unmeasured rather than reporting zero.
 *
 * Returns how many moves were filled in.
 */
export async function backfillMoveDeltas(imageId: string): Promise<number> {
    const e = schema.activityEvents;
    const pending = await db
        .select({ id: e.id, payload: e.payload })
        .from(e)
        .where(and(
            eq(e.type, "container.image-changed"),
            eq(e.imageId, imageId),
            sql`${e.payload}->>'deltaUnavailable' = 'to-unscanned'`
        ));
    if (pending.length === 0) return 0;

    const fromIds = [...new Set(pending.map((row) => (row.payload.from as { imageId?: string } | null)?.imageId).filter((id): id is string => Boolean(id)))];
    const imageIds = [...new Set([imageId, ...fromIds])];
    const scanned = await scannedImages(db, imageIds);
    if (!scanned.has(imageId)) return 0;
    const findings = await comparableFindings(imageIds);

    let filled = 0;
    for (const row of pending) {
        const fromId = (row.payload.from as { imageId?: string } | null)?.imageId;
        if (!fromId || !scanned.has(fromId)) continue;
        const measured = measureMove(fromId, imageId, scanned, findings);
        await db
            .update(e)
            .set({ payload: { ...row.payload, ...measured } })
            .where(eq(e.id, row.id));
        filled += 1;
    }
    return filled;
}

/**
 * The events, with each `image-changed` carrying the same measurement the
 * Fix tab makes for a *proposed* move — "resolves 12, introduces 2" — from
 * the same module (§4). When either digest has no SBOM the payload says
 * which, and the line shows no delta rather than a zero.
 */
async function containerEvents(
    tx: Transaction,
    orgId: string,
    clusterId: string,
    changes: SlotChange[],
    reportedAt: Date
): Promise<NewActivityEvent[]> {
    const moves = changes.filter((c): c is Extract<SlotChange, { kind: "image-changed" }> => c.kind === "image-changed");
    const imageIds = [...new Set(moves.flatMap((m) => [m.from.imageId, m.to.imageId]))];

    const scanned = await scannedImages(tx, imageIds);
    const findings = imageIds.length > 0 ? await comparableFindings(imageIds, tx) : new Map<string, ComparableFinding[]>();

    const deltaFor = (fromId: string, toId: string) => measureMove(fromId, toId, scanned, findings);

    return changes.map((change): NewActivityEvent => {
        const subject = change.kind === "removed" ? change.from : change.to;
        const base = {
            orgId,
            clusterId,
            createdAt: reportedAt,
            imageId: subject.imageId,
        };
        const slot = {
            namespace: subject.namespace,
            workloadKind: subject.workloadKind,
            workloadName: subject.workloadName,
            containerName: subject.containerName,
            init: subject.init,
            repository: subject.repository,
        };
        switch (change.kind) {
            case "appeared":
                return {
                    ...base,
                    type: "container.appeared",
                    payload: { ...slot, from: null, to: sidePayload(change.to), imageNew: change.imageNew },
                };
            case "removed":
                return {
                    ...base,
                    type: "container.removed",
                    payload: { ...slot, from: sidePayload(change.from), to: null, imageGone: change.imageGone },
                };
            case "image-changed":
                return {
                    ...base,
                    type: "container.image-changed",
                    payload: {
                        ...slot,
                        from: sidePayload(change.from),
                        to: sidePayload(change.to),
                        imageNew: change.imageNew,
                        imageGone: change.imageGone,
                        mutableTag: change.mutableTag,
                        ...deltaFor(change.from.imageId, change.to.imageId),
                    },
                };
            case "rollout-started":
                return {
                    ...base,
                    type: "container.rollout-started",
                    payload: {
                        ...slot,
                        from: sidePayload(change.from),
                        to: sidePayload(change.to),
                        imageNew: change.imageNew,
                    },
                };
            case "retagged":
                return {
                    ...base,
                    type: "container.retagged",
                    payload: { ...slot, from: sidePayload(change.from), to: sidePayload(change.to) },
                };
        }
    });
}

/** A slot as the history table keys it: the cluster plus the three durable names. */
export interface SlotRef {
    clusterId: string;
    namespace: string;
    workloadName: string;
    containerName: string;
}

/** `clusterId/namespace/workload/container` — {@link slotKey} with the cluster in front. */
export const slotRefKey = (slot: SlotRef) => `${slot.clusterId}/${slotKey(slot)}`;

/**
 * How many intervals of one slot the exposure walk reads. A crash-looping
 * retag must not make a page slow; a slot cut off here reports a lower
 * bound, which is what "we did not look further" is.
 */
export const SLOT_HISTORY_CAP = 50;

export interface SlotHistory {
    /** Newest first, at most {@link SLOT_HISTORY_CAP}. */
    intervals: WorkloadContainerHistory[];
    /** Older rows exist that were not read. */
    truncated: boolean;
}

export const containerHistoryRepository = {
    /**
     * Every interval of each of these slots, open and closed, newest first —
     * the input to `lib/exposure.ts`. The slot columns are denormalised on
     * the table, so this needs no join to `workloads` and survives a
     * prune-and-recreate. `org_id` is in the predicate: a slot ref is names,
     * and names are not authorisation.
     */
    async findBySlots(orgId: string, slots: SlotRef[]): Promise<Map<string, SlotHistory>> {
        const out = new Map<string, SlotHistory>();
        const h = schema.workloadContainerHistory;
        const distinct = [...new Map(slots.map((slot) => [slotRefKey(slot), slot])).values()];

        for (const batch of chunk(distinct, 1000)) {
            const tuples = sql.join(
                batch.map((slot) => sql`(${slot.clusterId}::uuid, ${slot.namespace}, ${slot.workloadName}, ${slot.containerName})`),
                sql`, `
            );
            const ranked = db
                .select({
                    id: h.id,
                    rank: sql<number>`row_number() OVER (
                        PARTITION BY ${h.clusterId}, ${h.namespace}, ${h.workloadName}, ${h.containerName}
                        ORDER BY ${h.startedAt} DESC
                    )`.as("rank"),
                })
                .from(h)
                .where(and(
                    eq(h.orgId, orgId),
                    sql`(${h.clusterId}, ${h.namespace}, ${h.workloadName}, ${h.containerName}) IN (${tuples})`
                ))
                .as("ranked");
            const rows = await db
                .select({ interval: h, rank: ranked.rank })
                .from(ranked)
                .innerJoin(h, eq(h.id, ranked.id))
                .where(sql`${ranked.rank} <= ${SLOT_HISTORY_CAP + 1}`)
                .orderBy(sql`${h.startedAt} DESC`);

            for (const { interval, rank } of rows) {
                const key = slotRefKey(interval);
                let entry = out.get(key);
                if (!entry) out.set(key, (entry = { intervals: [], truncated: false }));
                if (Number(rank) > SLOT_HISTORY_CAP) entry.truncated = true;
                else entry.intervals.push(interval);
            }
        }
        return out;
    },

    /**
     * Every interval a digest has run in, newest first — the image page's
     * deployment history, and what gives issue verification a timestamp.
     */
    async findByImageId(imageId: string, orgId: string): Promise<WorkloadContainerHistory[]> {
        return db
            .select()
            .from(schema.workloadContainerHistory)
            .where(and(
                eq(schema.workloadContainerHistory.imageId, imageId),
                eq(schema.workloadContainerHistory.orgId, orgId)
            ))
            .orderBy(sql`${schema.workloadContainerHistory.startedAt} DESC`);
    },

    /**
     * The retention sweep (§9): closed intervals older than the org's plan
     * window go. `ended_at`, not `started_at`, is what ages out — an open
     * interval is current and is never swept, however long it has run. Same
     * per-plan loop and same fail-safe as the other history tables: an
     * unrecognised plan value deletes nothing.
     */
    async deleteBeyondPlanWindows(): Promise<number> {
        let deleted = 0;
        for (const plan of Object.keys(PLAN_LIMITS) as PlanType[]) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - getPlanLimits(plan).historyDays);
            const orgsOnPlan = db
                .select({ id: schema.organizations.id })
                .from(schema.organizations)
                .where(eq(schema.organizations.plan, plan));
            const result = await db
                .delete(schema.workloadContainerHistory)
                .where(and(
                    lt(schema.workloadContainerHistory.endedAt, cutoff),
                    inArray(schema.workloadContainerHistory.orgId, orgsOnPlan)
                ))
                .returning({ id: schema.workloadContainerHistory.id });
            deleted += result.length;
        }
        return deleted;
    },
};
