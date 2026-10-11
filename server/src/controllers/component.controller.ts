import type { Request, Response, NextFunction } from "express";
import { packageRepository } from "../repositories/index.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { clusterComponentsQuerySchema, clusterPackageOccurrencesQuerySchema } from "../schemas/cluster.schema.js";
import { asAuthed } from "../middleware/auth.js";

const log = createLogger("component.controller");

export const componentController = {
    /**
     * Every package across the org's clusters, one row per name + version —
     * the Packages page the Dashboard's Packages card links to. The cluster
     * tab's handler with the org for a scope; the parameters are parsed by
     * the same schema so a cluster link and an org link carry the same query
     * string.
     *
     * @route GET /api/components
     */
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const query = clusterComponentsQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId });

            const page = await time(
                "findPackages",
                packageRepository.findPackages(
                    { orgId },
                    {
                        ...query,
                        severities: query.severity?.split(",").map((s) => s.trim().toLowerCase()),
                        kev: query.kev === "true",
                    },
                ),
            );

            res.json(page);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The ecosystems the org's packages come from — the list's Ecosystem menu.
     *
     * @route GET /api/components/ecosystems
     */
    async ecosystems(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const time = createQueryTimer(log, { orgId });

            const ecosystems = await time("findPackageEcosystems", packageRepository.findPackageEcosystems({ orgId }));

            res.json({ ecosystems });
        } catch (error) {
            next(error);
        }
    },

    /**
     * The images and workloads one package version is in anywhere in the
     * org, each with its cluster — what the org list's count cells open to.
     *
     * @route GET /api/components/occurrences
     */
    async occurrences(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const query = clusterPackageOccurrencesQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId });

            const occurrences = await time(
                "findPackageOccurrences",
                packageRepository.findPackageOccurrences(
                    { orgId },
                    { name: query.name, version: query.version ?? null, control: query.control },
                ),
            );

            res.json(occurrences);
        } catch (error) {
            next(error);
        }
    },
};
