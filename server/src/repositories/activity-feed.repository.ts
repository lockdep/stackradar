import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { ActivityEvent, ActivityEventType } from "../db/schema/remediation.js";
import { isDigestLikeTag } from "../lib/image-ref.js";

/**
 * The activity feed's reader. One query over
 * `activity_events`, newest first on the `(org_id, created_at)` index,
 * cursor-paginated. Grouping into day blocks is a read-time choice made in
 * the view, in the viewer's timezone, exactly as the workloads list groups
 * by namespace at read time — the server hands back a flat page.
 *
 * Suppressed findings are **not** excluded here. The feed reports what
 * happened; suppression is a decision about the Fix surface.
 *
 * The page answers four questions about the workloads the org tracks — did
 * one start or stop being tracked, did one change image, what did that move
 * do to its findings, and did the advisory database change against one —
 * so only the events that answer them are served. Issue and suppression
 * events belong to the issue detail's lifecycle timeline, not the feed;
 * `scan.criticals-increased` is the coarser duplicate of
 * `scan.findings-changed`.
 */
export const FEED_EVENT_TYPES: readonly ActivityEventType[] = [
    "container.appeared",
    "container.removed",
    "container.image-changed",
    "container.rollout-started",
    "container.retagged",
    "scan.findings-changed",
];

export interface FeedEvent extends ActivityEvent {
    /** Joined at read time so a line can name its cluster without a payload copy. */
    clusterName: string | null;
}

export interface FeedPage {
    events: FeedEvent[];
    /** Opaque; pass back as `?cursor=` for the next page. Null when this was the last. */
    nextCursor: string | null;
}

/**
 * The cursor is the last row's `(created_at, id)` — the keyset the query
 * orders by — so a page boundary is stable while events keep landing at the
 * head. Base64 of the two joined by `|`, opaque to the client.
 */
function encodeCursor(event: ActivityEvent): string {
    return Buffer.from(`${event.createdAt.toISOString()}|${event.id}`).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
    let raw: string;
    try {
        raw = Buffer.from(cursor, "base64url").toString("utf8");
    } catch {
        return null;
    }
    const sep = raw.indexOf("|");
    if (sep < 0) return null;
    const createdAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt, id };
}

/**
 * Rows a summary folds: at most this many, newest first. A week of a large
 * fleet is hundreds of events; a cap keeps the digest and the Dashboard's
 * movement block bounded reads whatever the window, and a truncated week
 * under-counts rather than blocking either.
 */
const SINCE_MAX_EVENTS = 5_000;

/**
 * What a "since" summary reads: the Feed's types plus the KEV listing event,
 * which is not a Feed line but is the digest's "new on CISA KEV" when the
 * catalogue, not the mirror, changed (`lib/since-summary.ts`).
 */
const SINCE_EVENT_TYPES: readonly ActivityEventType[] = [...FEED_EVENT_TYPES, "finding.kev-listed"];

/** The two event types that carry findings arriving on a running image — `lib/recent-movement.ts`. */
const MOVEMENT_EVENT_TYPES: readonly ActivityEventType[] = ["scan.findings-changed", "container.image-changed"];

/** What the movement block needs to name an image that the events did not carry themselves. */
export interface ImageDescription {
    imageId: string;
    /** The registry host the repository is read from; the two together are the full path. */
    registry: string | null;
    repository: string | null;
    digest: string;
    /** Who controls the image — `built`, `third-party` or `unknown` (`lib/image-control.ts`). */
    control: string;
    clusterName: string | null;
    /** A real tag one of its running containers uses, if any — never a digest-shaped one. */
    tag: string | null;
    /** The containers running the image now, by namespace then name. Empty when nothing runs it. */
    runsIn: ImageContainer[];
}

/** One container running an image — the live inventory's answer, not the events'. */
export interface ImageContainer {
    containerId: string;
    /** The container's own name; usually its workload's, and only worth showing when it differs. */
    name: string;
    namespace: string;
    /** Null is "could not look", never "none" — see the inventory contract. */
    workloadKind: string | null;
    workloadName: string;
    /** The Helm release that packaged the workload; all null when none claims it. */
    releaseId: string | null;
    releaseName: string | null;
    /** Null on a release whose chart metadata the scanner could not read. */
    chartName: string | null;
    chartVersion: string | null;
    /**
     * Since when this container has run *this digest* — its open
     * `workload_container_history` interval, the same figure as the
     * containers list's "Running this image for". Per container, so it cannot be "exposed
     * to the vulnerability": the row is an image with several arrivals, and
     * each finding row carries its own stitched figure. Null = no interval
     * recorded yet, never zero.
     */
    onImageSince: Date | null;
    /** The interval began with the cluster's first report: "this long, or longer". */
    onImageSinceIsLowerBound: boolean;
}

export const activityFeedRepository = {
    /**
     * Every feed event of the org after `since` — the input to
     * `summariseSince`. Same event types as the page, no pagination.
     */
    async listSince(orgId: string, since: Date): Promise<ActivityEvent[]> {
        const e = schema.activityEvents;
        return db
            .select()
            .from(e)
            .where(and(eq(e.orgId, orgId), inArray(e.type, SINCE_EVENT_TYPES), gte(e.createdAt, since)))
            .orderBy(desc(e.createdAt), desc(e.id))
            .limit(SINCE_MAX_EVENTS);
    },

    /**
     * The scan and move events of the org after `since` — the input to
     * `foldMovement`. Narrower than `listSince` because the block never
     * counts containers appearing or leaving.
     */
    async listMovementEvents(orgId: string, since: Date): Promise<ActivityEvent[]> {
        const e = schema.activityEvents;
        return db
            .select()
            .from(e)
            .where(and(eq(e.orgId, orgId), inArray(e.type, MOVEMENT_EVENT_TYPES), gte(e.createdAt, since)))
            .orderBy(desc(e.createdAt), desc(e.id))
            .limit(SINCE_MAX_EVENTS);
    },

    /** The same events, for one image — the expanded movement row. */
    async listMovementEventsForImage(orgId: string, imageId: string, since: Date): Promise<ActivityEvent[]> {
        const e = schema.activityEvents;
        return db
            .select()
            .from(e)
            .where(
                and(
                    eq(e.orgId, orgId),
                    eq(e.imageId, imageId),
                    inArray(e.type, MOVEMENT_EVENT_TYPES),
                    gte(e.createdAt, since),
                ),
            )
            .orderBy(desc(e.createdAt), desc(e.id))
            .limit(SINCE_MAX_EVENTS);
    },

    /**
     * Registry, repository, digest, cluster name, a running tag and the
     * containers running each image now, so a movement row can be labelled even
     * when its events predate the payload fields that carry them. An image the GC has since removed is simply
     * absent; the caller keeps the event's own naming for it.
     */
    /**
     * Which of the images are third-party, for the movement block's
     * `?control=` — asked of every folded image, before the cap, so the cap
     * counts what matches. An image that is gone is in neither set.
     */
    async thirdPartyImageIds(
        orgId: string,
        imageIds: string[],
    ): Promise<{ known: Set<string>; thirdParty: Set<string> }> {
        if (imageIds.length === 0) return { known: new Set(), thirdParty: new Set() };
        const rows = await db
            .select({ imageId: schema.images.id, control: schema.images.control })
            .from(schema.images)
            .where(and(eq(schema.images.orgId, orgId), inArray(schema.images.id, imageIds)));
        return {
            known: new Set(rows.map((r) => r.imageId)),
            thirdParty: new Set(rows.filter((r) => r.control === "third-party").map((r) => r.imageId)),
        };
    },

    async describeImages(orgId: string, imageIds: string[]): Promise<Map<string, ImageDescription>> {
        if (imageIds.length === 0) return new Map();
        const rows = await db
            .select({
                imageId: schema.images.id,
                registry: schema.images.registry,
                repository: schema.images.repository,
                digest: schema.images.digest,
                control: schema.images.control,
                clusterName: schema.clusters.name,
            })
            .from(schema.images)
            .leftJoin(schema.clusters, eq(schema.images.clusterId, schema.clusters.id))
            .where(and(eq(schema.images.orgId, orgId), inArray(schema.images.id, imageIds)));
        const tags = await db
            .selectDistinct({ imageId: schema.workloadContainers.imageId, tag: schema.workloadContainers.imageTag })
            .from(schema.workloadContainers)
            .where(
                and(eq(schema.workloadContainers.orgId, orgId), inArray(schema.workloadContainers.imageId, imageIds)),
            );
        const tagFor = new Map<string, string>();
        for (const t of tags) {
            if (t.tag && !isDigestLikeTag(t.tag) && !tagFor.has(t.imageId)) tagFor.set(t.imageId, t.tag);
        }
        const h = schema.workloadContainerHistory;
        const containers = await db
            .select({
                imageId: schema.workloadContainers.imageId,
                containerId: schema.workloadContainers.id,
                name: schema.workloadContainers.name,
                namespace: schema.namespaces.name,
                workloadKind: schema.workloads.kind,
                workloadName: schema.workloads.name,
                releaseId: schema.helmReleases.id,
                releaseName: schema.helmReleases.name,
                chartName: schema.helmReleases.chartName,
                chartVersion: schema.helmReleases.chartVersion,
                onImageSince: h.startedAt,
                // Unknown first observation proves nothing, so it reads as a
                // lower bound too; the slack is `CONTIGUITY_TOLERANCE_MS`.
                onImageSinceIsLowerBound: sql<boolean>`coalesce((${h.startedAt} <= ${schema.clusters.firstInventoryAt} + interval '10 minutes') IS NOT FALSE AND ${h.id} IS NOT NULL, false)`,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
            .innerJoin(schema.images, eq(schema.workloadContainers.imageId, schema.images.id))
            .innerJoin(schema.clusters, eq(schema.namespaces.clusterId, schema.clusters.id))
            .leftJoin(schema.helmReleases, eq(schema.workloads.releaseId, schema.helmReleases.id))
            // At most one row: `wc_history_open_slot_unique` is on exactly these columns.
            .leftJoin(
                h,
                and(
                    eq(h.clusterId, schema.namespaces.clusterId),
                    eq(h.namespace, schema.namespaces.name),
                    eq(h.workloadName, schema.workloads.name),
                    eq(h.containerName, schema.workloadContainers.name),
                    eq(h.digest, schema.images.digest),
                    isNull(h.endedAt),
                ),
            )
            .where(
                and(eq(schema.workloadContainers.orgId, orgId), inArray(schema.workloadContainers.imageId, imageIds)),
            )
            .orderBy(schema.namespaces.name, schema.workloads.name, schema.workloadContainers.name);
        const runsIn = new Map<string, ImageContainer[]>();
        for (const { imageId, ...container } of containers) {
            const list = runsIn.get(imageId) ?? [];
            list.push(container);
            runsIn.set(imageId, list);
        }
        return new Map(
            rows.map((r) => [
                r.imageId,
                { ...r, tag: tagFor.get(r.imageId) ?? null, runsIn: runsIn.get(r.imageId) ?? [] },
            ]),
        );
    },

    async listPage(
        orgId: string,
        options: {
            since: Date;
            limit: number;
            cursor?: { createdAt: Date; id: string } | null;
            clusterId?: string | null;
        },
    ): Promise<FeedPage> {
        const { since, limit, cursor, clusterId } = options;
        const e = schema.activityEvents;

        const rows = await db
            .select({
                id: e.id,
                orgId: e.orgId,
                clusterId: e.clusterId,
                type: e.type,
                imageId: e.imageId,
                issueId: e.issueId,
                payload: e.payload,
                createdAt: e.createdAt,
                clusterName: schema.clusters.name,
            })
            .from(e)
            .leftJoin(schema.clusters, eq(e.clusterId, schema.clusters.id))
            .where(
                and(
                    eq(e.orgId, orgId),
                    inArray(e.type, FEED_EVENT_TYPES),
                    gte(e.createdAt, since),
                    clusterId ? eq(e.clusterId, clusterId) : undefined,
                    cursor
                        ? or(
                              lt(e.createdAt, cursor.createdAt),
                              and(eq(e.createdAt, cursor.createdAt), sql`${e.id} < ${cursor.id}::uuid`),
                          )
                        : undefined,
                ),
            )
            .orderBy(desc(e.createdAt), desc(e.id))
            .limit(limit + 1);

        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
            events: page,
            nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
        };
    },
};
