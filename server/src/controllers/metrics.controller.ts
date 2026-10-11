import type { Request, Response, NextFunction } from "express";
import { metricsRepository, clusterRepository } from "../repositories/index.js";
import { metricsService } from "../services/metrics.service.js";
import { AppError } from "../middleware/error-handler.js";
import { getPlanLimits } from "../config/plans.js";
import { clusterIdParamSchema } from "../schemas/index.js";
import { parseTierParam } from "../db/finding-tier.js";
import { isFiltered, projectSnapshot, type SnapshotBreakdown, type SnapshotFilter } from "../lib/snapshot-breakdown.js";
import { asAuthed } from "../middleware/auth.js";

const DEFAULT_DAYS = 30;

/**
 * The `?days` window, clamped to the plan's history window rather than a
 * global maximum — trend depth is one of the things a paid plan buys
 * (`historyDays` in `config/plans.ts`). The retention sweep deletes snapshots
 * past the same window, so the clamp is the immediate-consistency half (a
 * downgrade shortens the view before the next sweep runs) rather than the
 * only enforcement.
 */
function clampDays(req: Request): number {
    const requested = parseInt(String(req.query.days ?? DEFAULT_DAYS), 10) || DEFAULT_DAYS;
    return Math.min(requested, getPlanLimits(asAuthed(req).auth.org.plan).historyDays);
}

/**
 * `?control=` and `?tier=`, read as the findings lists read them: a bad value
 * is no filter, never a 400.
 */
function snapshotFilter(req: Request): SnapshotFilter {
    const control = req.query.control;
    return {
        control: control === "yours" || control === "third-party" ? control : undefined,
        lens: parseTierParam(typeof req.query.tier === "string" ? req.query.tier : undefined),
    };
}

/**
 * The series a chart reads. Unfiltered it is the rows' own columns; filtered,
 * each row's counts are replaced by the sum of the breakdown cells the filter
 * selects, and rows captured before the breakdown existed are left out — the
 * filtered history starts where recording did. The breakdown itself never
 * leaves the server: the response shape is the same either way.
 */
function toSeries<T extends { breakdown: SnapshotBreakdown | null }>(rows: T[], filter: SnapshotFilter) {
    if (!isFiltered(filter)) return rows.map(({ breakdown: _breakdown, ...row }) => row);
    return rows.flatMap(({ breakdown, ...row }) => {
        const counts = projectSnapshot(breakdown, filter);
        return counts ? [{ ...row, ...counts }] : [];
    });
}

export const metricsController = {
    async listSnapshots(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const days = clampDays(req);
            const snapshots = await metricsRepository.findByOrg(orgId, days);
            res.json(toSeries(snapshots, snapshotFilter(req)));
        } catch (error) {
            next(error);
        }
    },

    async triggerCapture(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            await metricsService.captureSnapshot(orgId);
            const [snapshot] = await metricsRepository.findByOrg(orgId, 1);
            res.status(201).json(snapshot);
        } catch (error) {
            next(error);
        }
    },

    async listClusterSnapshots(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const { clusterId } = clusterIdParamSchema.parse(req.params);
            const days = clampDays(req);

            const cluster = await clusterRepository.findById(clusterId, orgId);
            if (!cluster) throw new AppError(404, "Cluster not found");

            const snapshots = await metricsRepository.findByCluster(clusterId, days);
            res.json(toSeries(snapshots, snapshotFilter(req)));
        } catch (error) {
            next(error);
        }
    },

    async triggerClusterCapture(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const { clusterId } = clusterIdParamSchema.parse(req.params);

            const cluster = await clusterRepository.findById(clusterId, orgId);
            if (!cluster) throw new AppError(404, "Cluster not found");

            await metricsService.captureClusterSnapshot(clusterId);
            const [snapshot] = await metricsRepository.findByCluster(clusterId, 1);
            res.status(201).json(snapshot);
        } catch (error) {
            next(error);
        }
    },
};
