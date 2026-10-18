import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import {
    adminRepository,
    adminStatusRepository,
    adminMatcherRepository,
    adminExplorerRepository,
    clusterRepository,
    workloadRepository,
} from "../repositories/index.js";
import { fetchOsvRecord } from "../lib/osv-api.js";
import { getSystemReport } from "../services/admin-system.service.js";
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
} from "../schemas/index.js";

export const adminController = {
    async getOverview(_req: Request, res: Response, next: NextFunction) {
        try {
            const [stats, osvState] = await Promise.all([
                adminStatusRepository.getSystemStats(),
                adminStatusRepository.getOsvState(),
            ]);

            res.json({ stats, osvState });
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
            const { limit, offset, status } = adminJobsQuerySchema.parse(req.query);
            const result = await adminRepository.getAdminJobs({ limit, offset, ...(status && { status }) });
            res.json(result);
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
