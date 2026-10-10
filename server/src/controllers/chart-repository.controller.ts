import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import { chartRepositoryRepository } from "../repositories/index.js";
import { discoverChartRepositories } from "../services/chart-repo.service.js";
import { jobService } from "../services/job.service.js";
import { jobRepository } from "../repositories/job.repository.js";
import {
    chartRepositoryIdParamSchema,
    createChartRepositorySchema,
    discoverChartQuerySchema,
    updateChartRepositorySchema,
} from "../schemas/index.js";
import { isUniqueViolation } from "../lib/pg-errors.js";
import type { ChartRepository } from "../db/schema/chart-repositories.js";

/**
 * Org-level chart repository settings —
 * docs/proposals/fix-tab-suggestions.md phase 2.
 *
 * The rows feed the suggestion feed's unmeasured band and nothing else.
 * Credentials go in and never come back out: responses carry a
 * `hasCredentials` flag, not the secret.
 */

function redact(repo: ChartRepository) {
    const { username, password, etag: _etag, ...rest } = repo;
    return { ...rest, hasCredentials: username != null && password != null };
}

export const chartRepositoryController = {
    /**
     * @route GET /api/chart-repositories
     */
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;
            const [repositories, unknownCharts] = await Promise.all([
                chartRepositoryRepository.listForOrg(orgId),
                chartRepositoryRepository.chartNamesWithUnknownRepo(orgId),
            ]);
            res.json({ repositories: repositories.map(redact), unknownCharts });
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route POST /api/chart-repositories
     *
     * `manual` for hubs the user names; `artifact-hub-confirmed` for a
     * discovery result the user explicitly accepted. The confirmation *is*
     * this request — the discover endpoint stores nothing.
     */
    async create(req: Request, res: Response, next: NextFunction) {
        try {
            const input = createChartRepositorySchema.parse(req.body);
            const repo = await chartRepositoryRepository.create({
                orgId: req.auth!.orgId,
                url: input.url,
                source: input.source,
                username: input.username ?? null,
                password: input.password ?? null,
            });
            res.status(201).json(redact(repo));
        } catch (error) {
            if (isUniqueViolation(error)) {
                next(new AppError(409, "That repository is already registered"));
                return;
            }
            next(error);
        }
    },

    /**
     * @route PATCH /api/chart-repositories/:id
     */
    async update(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = chartRepositoryIdParamSchema.parse(req.params);
            const input = updateChartRepositorySchema.parse(req.body);
            const repo = await chartRepositoryRepository.update(id, req.auth!.orgId, {
                ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
                ...(input.username !== undefined ? { username: input.username ?? null } : {}),
                ...(input.password !== undefined ? { password: input.password ?? null } : {}),
            });
            if (!repo) throw new AppError(404, "Chart repository not found");
            res.json(redact(repo));
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route DELETE /api/chart-repositories/:id
     */
    async delete(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = chartRepositoryIdParamSchema.parse(req.params);
            const removed = await chartRepositoryRepository.delete(id, req.auth!.orgId);
            if (!removed) throw new AppError(404, "Chart repository not found");
            res.json(redact(removed));
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route POST /api/chart-repositories/:id/refresh
     *
     * Enqueues a `chart_repo_refresh` job and returns 202 with it. The fetch
     * and parse never run in the API process: the URL is user-supplied and
     * `yaml.parse` is synchronous, so doing it here let any org admin stall
     * every tenant's requests (security-review-2026-08-22.md § S1). The
     * settings page polls the job and re-reads the row for the outcome.
     *
     * One open job per repository: a second click while one is queued
     * returns the existing job rather than stacking fetches.
     */
    async refresh(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = chartRepositoryIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const repo = await chartRepositoryRepository.findById(id, orgId);
            if (!repo) throw new AppError(404, "Chart repository not found");

            const existing = await jobRepository.findOpenByParam("chart_repo_refresh", "repositoryId", id);
            const job =
                existing ??
                (await jobService.createJob({
                    orgId,
                    type: "chart_repo_refresh",
                    title: `${repo.url}: Chart Repository Refresh`.slice(0, 255),
                    triggeredBy: "manual",
                    params: { repositoryId: id },
                }));
            res.status(202).json({ job, repository: redact(repo) });
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/chart-repositories/discover?chart=<name>
     *
     * Artifact Hub candidates for a chart name. Proposals only — nothing is
     * stored here, and the copy downstream must present them as a guess.
     */
    async discover(req: Request, res: Response, next: NextFunction) {
        try {
            const { chart } = discoverChartQuerySchema.parse(req.query);
            const candidates = await discoverChartRepositories(chart);
            res.json({ chart, candidates });
        } catch (error) {
            next(error);
        }
    },
};
