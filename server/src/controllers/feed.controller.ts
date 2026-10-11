import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import { getPlanLimits } from "../config/plans.js";
import { feedQuerySchema, feedMovementQuerySchema, feedMovementFindingsParamsSchema } from "../schemas/feed.schema.js";
import { activityFeedRepository, decodeCursor } from "../repositories/activity-feed.repository.js";
import { scannedImages } from "../repositories/container-history.repository.js";
import { comparableFindings, diffFindings } from "../db/finding-delta.js";
import { db } from "../db/index.js";
import {
    foldMovement,
    collectArrivals,
    byArrivalOrder,
    lensArrivals,
    type ArrivalExposure,
    type ArrivedFinding,
} from "../lib/recent-movement.js";
import { exposureService } from "../services/exposure.service.js";
import { exposureRepository } from "../repositories/exposure.repository.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { parseTierParam, passesLens } from "../db/finding-tier.js";
import { asAuthed } from "../middleware/auth.js";

const log = createLogger("feed.controller");

/**
 * How many images the movement block is handed. The block shows three and
 * expands to these; a fleet with more than fifty images gaining findings in
 * a week reads the Feed, and `totalImages` says the cut was made.
 */
const MOVEMENT_MAX_IMAGES = 50;

/**
 * How many findings an unfolded movement row is handed. The scan payloads
 * carry a hundred each and a move diff is unbounded; the row shows a few
 * and the image page has them all.
 */
const MOVEMENT_MAX_FINDINGS = 100;

/**
 * The activity feed — what changed in the org's fleet, newest first.
 * Grouping by day is the view's job; this hands back a flat page.
 */
export const feedController = {
    /**
     * @route GET /api/feed?days=&limit=&cursor=&cluster=
     */
    async getFeed(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const query = feedQuerySchema.parse(req.query);
            const cursor = query.cursor ? decodeCursor(query.cursor) : null;
            if (query.cursor && !cursor) throw new AppError(400, "Invalid cursor");

            // Windowed to the plan's history, same as trends and scan runs:
            // history depth is what the paid tiers sell, and the retention
            // sweep deletes beyond it anyway.
            const { historyDays } = getPlanLimits(auth.org.plan);
            const days = Math.min(query.days, historyDays);
            const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

            const page = await activityFeedRepository.listPage(auth.orgId, {
                since,
                limit: query.limit,
                cursor,
                clusterId: query.cluster ?? null,
            });
            res.json({ ...page, days, historyDays });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Findings that arrived on running images in the window, one row per
     * image, newest first — the Dashboard's "New on running images" block.
     * The events carry their own naming; the images table fills what older
     * payloads lack (tag, cluster name) and wins for the repository, which
     * the event copied from it at the time.
     *
     * `severity=` keeps the images that gained a finding in any named band.
     *
     * @route GET /api/feed/movement?days=&severity=&control=
     */
    async movement(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const query = feedMovementQuerySchema.parse(req.query);
            const { historyDays } = getPlanLimits(auth.org.plan);
            const days = Math.min(query.days, historyDays);
            const until = new Date();
            const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

            const events = await activityFeedRepository.listMovementEvents(auth.orgId, since);
            const folded = foldMovement(events, since, until, parseTierParam(query.tier));
            /* Filtered before the cap, so the newest fifty are the newest fifty
               that match — not whatever matches among the newest fifty. */
            /* `control=` as the findings lists read it: third-party, or
               everything that is not — an undecided image is the org's to
               look at until someone says otherwise. */
            let inControl = folded.images;
            if (query.control) {
                const { known, thirdParty } = await activityFeedRepository.thirdPartyImageIds(
                    auth.orgId,
                    folded.images.map((i) => i.imageId),
                );
                inControl = folded.images.filter((i) =>
                    query.control === "third-party"
                        ? thirdParty.has(i.imageId)
                        : known.has(i.imageId) && !thirdParty.has(i.imageId),
                );
            }
            const matching =
                query.severity.length === 0
                    ? inControl
                    : inControl.filter((i) => query.severity.some((band) => i.added[band] > 0));
            const shown = matching.slice(0, MOVEMENT_MAX_IMAGES);
            const described = await activityFeedRepository.describeImages(
                auth.orgId,
                shown.map((i) => i.imageId),
            );

            res.json({
                since,
                until,
                days,
                historyDays,
                totalImages: matching.length,
                /** Before the severity filter — what an empty filtered view can offer instead. */
                totalImagesAnySeverity: inControl.length,
                resolved: folded.resolved,
                tierCounts: folded.tierCounts,
                images: shown.map((i) => {
                    const d = described.get(i.imageId);
                    return {
                        ...i,
                        registry: d?.registry ?? null,
                        repository: d?.repository ?? i.repository,
                        digest: d?.digest ?? i.digest,
                        control: d?.control ?? null,
                        tag: i.tag ?? d?.tag ?? null,
                        clusterName: d?.clusterName ?? null,
                        runsIn: d?.runsIn ?? [],
                    };
                }),
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * The findings behind one movement row: what the scan events' head lists
     * name, plus what each measured move onto the image introduced, diffed
     * again now against the from-digest. `partial` says the list is not the
     * whole count — a scan added more than its payload carried, or a move's
     * from-digest is gone (image GC) and could not be diffed.
     *
     * @route GET /api/feed/movement/:imageId/findings?days=&severity=
     */
    async movementFindings(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const { imageId } = feedMovementFindingsParamsSchema.parse(req.params);
            const query = feedMovementQuerySchema.parse(req.query);
            const { historyDays } = getPlanLimits(auth.org.plan);
            const days = Math.min(query.days, historyDays);
            const until = new Date();
            const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

            // Org-scoped by the query: another org's image has no events here and unfolds empty.
            const events = await activityFeedRepository.listMovementEventsForImage(auth.orgId, imageId, since);
            const arrivals = collectArrivals(events, imageId);

            const byKey = new Map<string, ArrivedFinding>(arrivals.findings.map((f) => [f.key, f]));
            let unmeasuredMoves = 0;
            if (arrivals.moveFrom.length > 0) {
                const scanned = await scannedImages(db, [imageId, ...arrivals.moveFrom]);
                const measurable = scanned.has(imageId) ? arrivals.moveFrom.filter((id) => scanned.has(id)) : [];
                unmeasuredMoves = arrivals.moveFrom.length - measurable.length;
                if (measurable.length > 0) {
                    const findings = await comparableFindings([imageId, ...measurable]);
                    for (const from of measurable) {
                        const delta = diffFindings(
                            from,
                            imageId,
                            findings.get(from) ?? [],
                            findings.get(imageId) ?? [],
                        );
                        for (const f of delta.introduced) {
                            if (byKey.has(f.key)) continue;
                            const { purlType: _purlType, epssScore: _epss, ...line } = f;
                            byKey.set(f.key, { ...line, via: "move", exploited: passesLens(f, []) });
                        }
                    }
                }
            }

            const lensed = lensArrivals([...byKey.values()], parseTierParam(query.tier));
            /* The row was kept for these bands; the list under it answers in
               the same terms. Before the cap, as for the images. */
            const wanted = new Set<string>(query.severity);
            const all = lensed.findings
                .filter((f) => wanted.size === 0 || wanted.has((f.severityLevel ?? "").toLowerCase()))
                .sort(byArrivalOrder);
            const page = all.slice(0, MOVEMENT_MAX_FINDINGS);

            /* A scan arrival was *already there*: the advisory database
               caught up with a package the image had all along. Say for how
               long. One history read and one findings read for the image's
               slots, shared by every row; nothing for a move arrival, whose
               presence is the move the row already names. */
            const NO_EXPOSURE: ArrivalExposure = {
                presentSince: null,
                presentSinceIsLowerBound: false,
                lowerBoundReason: null,
                publishedAt: null,
            };
            const scanArrivals = page.filter((f) => f.via === "scan");
            let exposureOfRow = (_f: ArrivedFinding): ArrivalExposure => NO_EXPOSURE;
            if (scanArrivals.length > 0) {
                const time = createQueryTimer(log, { orgId: auth.orgId, imageId });
                const [presenceOf, publishedAt] = await Promise.all([
                    time("exposureForImage", exposureService.forImage(auth.orgId, imageId)),
                    time(
                        "advisoryDatesByVulnId",
                        exposureRepository.advisoryDatesByVulnId(scanArrivals.map((f) => f.vulnId)),
                    ),
                ]);
                exposureOfRow = (f) => {
                    if (f.via !== "scan") return NO_EXPOSURE;
                    const presence = presenceOf(f.key);
                    return {
                        presentSince: presence?.presentSince ?? null,
                        presentSinceIsLowerBound: presence?.presentSinceIsLowerBound ?? false,
                        lowerBoundReason: presence?.lowerBoundReason ?? null,
                        publishedAt: publishedAt.get(f.vulnId)?.publishedAt ?? null,
                    };
                };
            }

            res.json({
                imageId,
                since,
                until,
                days,
                historyDays,
                findings: page.map((f) => ({ ...f, ...exposureOfRow(f) })),
                total: all.length,
                tierCounts: lensed.tierCounts,
                partial: arrivals.truncated || unmeasuredMoves > 0,
                unmeasuredMoves,
            });
        } catch (error) {
            next(error);
        }
    },
};
