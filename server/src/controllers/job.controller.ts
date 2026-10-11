import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { jobService } from "../services/job.service.js";
import { jobIdParamSchema } from "../schemas/index.js";
import { asAuthed } from "../middleware/auth.js";

const log = createLogger("job.controller");

export const jobController = {
    /**
     * Get all jobs for the current organization
     * @route GET /api/jobs
     * @returns {JobListResult} 200 - Jobs organized by status
     */
    async getAll(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const time = createQueryTimer(log, { orgId });
            const jobs = await time("getJobsList", jobService.getJobsList(orgId));
            res.json(jobs);
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
            const { auth } = asAuthed(req);
            const { id } = jobIdParamSchema.parse(req.params);
            const time = createQueryTimer(log, { jobId: id });
            const job = await time("getJob", jobService.getJob(id));

            if (!job) {
                throw new AppError(404, "Job not found");
            }

            // Verify the job belongs to the user's organization
            if (job.orgId !== auth.orgId) {
                throw new AppError(404, "Job not found");
            }

            res.json(job);
        } catch (error) {
            next(error);
        }
    },
};
