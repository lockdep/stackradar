import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { jobService } from "../services/job.service.js";
import { jobIdParamSchema } from "../schemas/index.js";

const log = createLogger("job.controller");

/**
 * Cancel and retry share everything but the service call: load the job,
 * check it belongs to the caller's org (404 either way — a foreign job id
 * must be indistinguishable from a missing one), act, return the row.
 */
function jobAction(action: "cancelJob" | "retryJob") {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { id } = jobIdParamSchema.parse(req.params);
            const time = createQueryTimer(log, { jobId: id });

            // Verify ownership first
            const existingJob = await time("getJob", jobService.getJob(id));
            if (!existingJob || existingJob.orgId !== req.auth!.orgId) {
                throw new AppError(404, "Job not found");
            }

            const job = await time(action, jobService[action](id));
            res.json(job);
        } catch (error) {
            next(error);
        }
    };
}

export const jobController = {
    /**
     * Get all jobs for the current organization
     * @route GET /api/jobs
     * @returns {JobListResult} 200 - Jobs organized by status
     */
    async getAll(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { orgId });
            const jobs = await time("getJobsList", jobService.getJobsList(orgId));
            res.json(jobs);
        } catch (error) {
            next(error);
        }
    },

    /**
     * Get job statistics for the current organization
     * @route GET /api/jobs/stats
     * @returns {JobStats} 200 - Job counts by status
     */
    async getStats(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { orgId });
            const stats = await time("getStats", jobService.getStats(orgId));
            res.json(stats);
        } catch (error) {
            next(error);
        }
    },

    /**
     * Get a single job by ID
     * @route GET /api/jobs/:id
     * @param {string} req.params.id - Job UUID
     * @returns {Job} 200 - Job details
     */
    async getById(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = jobIdParamSchema.parse(req.params);
            const time = createQueryTimer(log, { jobId: id });
            const job = await time("getJob", jobService.getJob(id));

            if (!job) {
                throw new AppError(404, "Job not found");
            }

            // Verify the job belongs to the user's organization
            if (job.orgId !== req.auth!.orgId) {
                throw new AppError(404, "Job not found");
            }

            res.json(job);
        } catch (error) {
            next(error);
        }
    },

    /**
     * Cancel a pending or scheduled job
     * @route POST /api/jobs/:id/cancel
     * @param {string} req.params.id - Job UUID
     * @returns {Job} 200 - Cancelled job
     */
    cancel: jobAction("cancelJob"),

    /**
     * Retry a failed job
     * @route POST /api/jobs/:id/retry
     * @param {string} req.params.id - Job UUID
     * @returns {Job} 200 - Retried job
     */
    retry: jobAction("retryJob"),
};
