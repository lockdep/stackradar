import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import {
    adminRepository,
    adminStatusRepository,
    adminMatcherRepository,
    adminExplorerRepository,
    clusterRepository,
    workloadRepository,
    vulnerabilityMirrorRepository,
} from "../repositories/index.js";
import { buildMirrorStatus } from "../lib/mirror-status.js";
import { fetchOsvRecord } from "../lib/osv-api.js";
import { getSystemReport } from "../services/admin-system.service.js";
import {
    collectOrphanedImages,
    rescanFleet,
    retryJob,
    retryStuckJobs,
    triggerSync,
    type SyncAction,
} from "../services/admin-actions.service.js";
import {
    adminListQuerySchema,
    adminJobsQuerySchema,
    adminImagesQuerySchema,
    explorerImagesQuerySchema,
    explorerSbomsQuerySchema,
    explorerComponentsQuerySchema,
    adminOrgIdParamSchema,
    adminComponentIdParamSchema,
    parseFailureIdParamSchema,
    adminJobIdParamSchema,
    adminFeedParamSchema,
} from "../schemas/index.js";

/** The acting admin, for the log line every action writes. `requireAdmin` guarantees the internal branch. */
function actor(req: Request): string {
    return req.auth?.userId ?? "unknown";
}

export const adminController = {
    /**
     * The Overview: the pipeline's five stages (scanner, inventory, SBOMs,
     * queue, mirror and its two feeds) plus the figures. The mirror's
     * fresh-install state is the same `buildMirrorStatus` the app shell's
     * banner reads, so "still building" is one definition, not two.
     */
    async getOverview(_req: Request, res: Response, next: NextFunction) {
        try {
            const [stats, osvState, pipeline, feeds, feedStates] = await Promise.all([
                adminStatusRepository.getSystemStats(),
                adminStatusRepository.getOsvState(),
                adminStatusRepository.getPipelineHealth(),
                adminStatusRepository.getFeedsStatus(),
                vulnerabilityMirrorRepository.getFeedStates(),
            ]);

            res.json({ stats, osvState, pipeline, feeds, mirror: buildMirrorStatus(feedStates) });
        } catch (error) {
            next(error);
        }
    },

    async getSystem(_req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await getSystemReport());
        } catch (error) {
            next(error);
        }
    },

    async getOrganizations(_req: Request, res: Response, next: NextFunction) {
        try {
            const recentOrgs = await adminRepository.getRecentOrganizations();
            res.json({ recentOrgs });
        } catch (error) {
            next(error);
        }
    },

    async getVulnerabilities(_req: Request, res: Response, next: NextFunction) {
        try {
            const [vulnerabilities, ecosystemDistribution, advisoryIdDistribution, withdrawn] = await Promise.all([
                adminRepository.getVulnerabilityStats(),
                adminRepository.getEcosystemDistribution(),
                adminRepository.getAdvisoryIdDistribution(),
                adminRepository.getWithdrawnStats(),
            ]);

            res.json({ vulnerabilities, ecosystemDistribution, advisoryIdDistribution, withdrawn });
        } catch (error) {
            next(error);
        }
    },

    async getMatcher(_req: Request, res: Response, next: NextFunction) {
        try {
            const matcher = await adminMatcherRepository.getMatcherQuality();
            res.json(matcher);
        } catch (error) {
            next(error);
        }
    },

    async getOsv(_req: Request, res: Response, next: NextFunction) {
        try {
            const osv = await adminStatusRepository.getOsvStatus();
            res.json(osv);
        } catch (error) {
            next(error);
        }
    },

    async getFeeds(_req: Request, res: Response, next: NextFunction) {
        try {
            const feeds = await adminStatusRepository.getFeedsStatus();
            res.json(feeds);
        } catch (error) {
            next(error);
        }
    },

    async getOrgClusters(req: Request, res: Response, next: NextFunction) {
        try {
            const { orgId } = adminOrgIdParamSchema.parse(req.params);
            const clusters = await clusterRepository.findAllByOrg(orgId);
            res.json({ clusters });
        } catch (error) {
            next(error);
        }
    },

    async getOrgContainers(req: Request, res: Response, next: NextFunction) {
        try {
            const { orgId } = adminOrgIdParamSchema.parse(req.params);
            const containers = await workloadRepository.findAllWithStats(orgId);
            res.json(containers);
        } catch (error) {
            next(error);
        }
    },

    async getJobs(req: Request, res: Response, next: NextFunction) {
        try {
            const { limit, offset, status, stuck } = adminJobsQuerySchema.parse(req.query);
            const result = await adminRepository.getAdminJobs({ limit, offset, stuck, ...(status && { status }) });
            res.json(result);
        } catch (error) {
            next(error);
        }
    },

    // ── Actions ──────────────────────────────────────────────────────────────

    async retryJob(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = adminJobIdParamSchema.parse(req.params);
            res.json(await retryJob(id, actor(req)));
        } catch (error) {
            next(error);
        }
    },

    async retryStuckJobs(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await retryStuckJobs(actor(req)));
        } catch (error) {
            next(error);
        }
    },

    async triggerOsvSync(req: Request, res: Response, next: NextFunction) {
        try {
            res.status(202).json(triggerSync("osv-sync", actor(req)));
        } catch (error) {
            next(error);
        }
    },

    async triggerOsvBootstrap(req: Request, res: Response, next: NextFunction) {
        try {
            res.status(202).json(triggerSync("osv-bootstrap", actor(req)));
        } catch (error) {
            next(error);
        }
    },

    async triggerFeedSync(req: Request, res: Response, next: NextFunction) {
        try {
            const { feed } = adminFeedParamSchema.parse(req.params);
            res.status(202).json(triggerSync(feed as SyncAction, actor(req)));
        } catch (error) {
            next(error);
        }
    },

    async collectImages(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await collectOrphanedImages(actor(req)));
        } catch (error) {
            next(error);
        }
    },

    async rescanFleet(req: Request, res: Response, next: NextFunction) {
        try {
            res.status(202).json(await rescanFleet(actor(req)));
        } catch (error) {
            next(error);
        }
    },

    async listParseFailures(req: Request, res: Response, next: NextFunction) {
        try {
            const { limit, offset } = adminListQuerySchema.parse(req.query);
            const [failures, total] = await Promise.all([
                adminMatcherRepository.listParseFailures(limit, offset),
                adminMatcherRepository.countParseFailures(),
            ]);
            res.json({ failures, total, limit, offset });
        } catch (error) {
            next(error);
        }
    },

    async getParseFailure(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = parseFailureIdParamSchema.parse(req.params);
            const failure = await adminMatcherRepository.getParseFailureById(id);
            if (!failure) {
                throw new AppError(404, "Not found");
            }
            res.json(failure);
        } catch (error) {
            next(error);
        }
    },

    async clearParseFailures(_req: Request, res: Response, next: NextFunction) {
        try {
            const deleted = await adminMatcherRepository.deleteAllParseFailures();
            res.json({ deleted });
        } catch (error) {
            next(error);
        }
    },

    async getImages(req: Request, res: Response, next: NextFunction) {
        try {
            const { limit, offset, state, sort, search } = adminImagesQuerySchema.parse(req.query);
            const result = await adminRepository.listAdminImages({
                limit,
                offset,
                ...(state && { state }),
                ...(sort && { sort }),
                ...(search && { search }),
            });
            res.json(result);
        } catch (error) {
            next(error);
        }
    },

    async getExplorerImages(req: Request, res: Response, next: NextFunction) {
        try {
            const { orgId } = explorerImagesQuerySchema.parse(req.query);
            const images = await adminExplorerRepository.listExplorerImages(orgId);
            res.json({ images });
        } catch (error) {
            next(error);
        }
    },

    async getExplorerSboms(req: Request, res: Response, next: NextFunction) {
        try {
            const { imageId } = explorerSbomsQuerySchema.parse(req.query);
            const sboms = await adminExplorerRepository.listExplorerSboms(imageId);
            res.json({ sboms });
        } catch (error) {
            next(error);
        }
    },

    async getExplorerComponents(req: Request, res: Response, next: NextFunction) {
        try {
            const { sbomId, limit, offset, search } = explorerComponentsQuerySchema.parse(req.query);
            const result = await adminExplorerRepository.listExplorerComponents(sbomId, {
                limit,
                offset,
                ...(search && { search }),
            });
            res.json(result);
        } catch (error) {
            next(error);
        }
    },

    async getExplorerComponentDetail(req: Request, res: Response, next: NextFunction) {
        try {
            const { componentId } = adminComponentIdParamSchema.parse(req.params);
            const detail = await adminExplorerRepository.getExplorerComponentDetail(componentId);
            if (!detail) {
                throw new AppError(404, "Component not found");
            }
            res.json(detail);
        } catch (error) {
            next(error);
        }
    },

    async getParseFailureRaw(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = parseFailureIdParamSchema.parse(req.params);
            const failure = await adminMatcherRepository.getParseFailureById(id);
            if (!failure) {
                throw new AppError(404, "Not found");
            }
            if (!failure.osvId) {
                throw new AppError(422, "No OSV ID available for this failure — cannot fetch raw data");
            }
            const osvRes = await fetchOsvRecord(failure.osvId);
            if (!osvRes.ok) {
                throw new AppError(osvRes.status, `OSV API returned ${osvRes.status}`);
            }
            const raw = await osvRes.json();
            res.json(raw);
        } catch (error) {
            next(error);
        }
    },
};
