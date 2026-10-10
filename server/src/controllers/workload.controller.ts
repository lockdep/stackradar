import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import {
    componentRepository,
    imageRepository,
    jobRepository,
    sbomRepository,
    vulnerabilityRepository,
    vulnerabilityScanRunRepository,
    workloadRepository,
} from "../repositories/index.js";
import { workloadIdParamSchema, workloadListQuerySchema } from "../schemas/index.js";
import { parseTierParam } from "../db/finding-tier.js";
import { groupedFindingsQuerySchema } from "../schemas/cluster.schema.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { getPlanLimits } from "../config/plans.js";
import { findPathToDirect } from "../services/vulnerability-grouping.service.js";
import { loadGroupedFindings } from "../services/grouped-findings.service.js";
import { exposureService } from "../services/exposure.service.js";
import type { WorkloadContainer } from "../db/schema/index.js";

const log = createLogger("workload-controller");

declare global {
    namespace Express {
        interface Request {
            /** The `workload_containers` row loaded by {@link loadContainer}. */
            container?: WorkloadContainer;
        }
    }
}

/**
 * The workloads API — what `project.controller.ts` became.
 *
 * The addressable unit is a **`workload_containers` row**: one container of one
 * workload, on one image. That is the level a user points at, and it is also
 * the level at which findings are unambiguous, because the findings belong to
 * the image the row references. A workload with two containers on two images
 * has two different answers to "what is wrong with it", and this shape lets it
 * give both.
 *
 * There is no create, update or delete. Workloads are **discovered**, not
 * authored — they arrive through `POST /v1/inventory` and disappear when they
 * stop running. The old `POST /api/projects` existed because a project was a
 * thing a user made up; a Deployment is not.
 */

/**
 * Resolve the container in the path and the image behind it, or 404.
 *
 * Ownership is checked against the caller's org on every one of these
 * endpoints. The container id in the URL implies nothing — it is a uuid a user
 * can type.
 *
 * Mounted as `router.param("id", loadContainer)` so it runs once per request
 * for every route with an `:id`; handlers read the loaded row off
 * `req.container` instead of re-resolving it.
 */
export function loadContainer(req: Request, _res: Response, next: NextFunction, id: string): void {
    (async () => {
        workloadIdParamSchema.parse({ id });
        const container = await workloadRepository.findContainerById(id);
        if (!container || container.orgId !== req.auth!.orgId) {
            throw new AppError(404, "Workload not found");
        }
        req.container = container;
        next();
    })().catch(next);
}

export const workloadController = {
    /**
     * Every running container in the org, with its image's findings.
     *
     * Optionally narrowed by cluster, namespace, release or image — the three
     * grouping lenses (namespace, chart, image) are filters over one list, not
     * three hierarchies. That is what "grouping becomes a lens, not a
     * hierarchy" means in the API.
     *
     * @route GET /api/workloads
     */
    async getAll(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;

            const filter = workloadListQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId, ...filter });
            const workloads = await time("findAllWithStats", workloadRepository.findAllWithStats(orgId, filter));
            res.json(workloads);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/workloads/:id
     */
    async getById(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = req.container!;
            const time = createQueryTimer(log, { containerId: id });

            const workload = await time("findByIdWithStats", workloadRepository.findByIdWithStats(id));
            if (!workload) {
                throw new AppError(404, "Workload not found");
            }
            res.json(workload);
        } catch (error) {
            next(error);
        }
    },

    /**
     * Everywhere else this container's image runs.
     *
     * The remediation half of the page: "change `image:` from A to B" is one
     * action, and this is the list of places it lands. Before the cutover the
     * question could not be asked at all — each of those places was a separate
     * project with a separate SBOM.
     *
     * @route GET /api/workloads/:id/siblings
     */
    async getSiblings(req: Request, res: Response, next: NextFunction) {
        try {
            const container = req.container!;
            const orgId = req.auth!.orgId;

            const time = createQueryTimer(log, { containerId: container.id });
            const deployments = await time(
                "findDeployments",
                imageRepository.findDeployments(container.imageId, orgId)
            );
            res.json(deployments.filter((d) => d.containerId !== container.id));
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/workloads/:id/components
     */
    async getComponents(req: Request, res: Response, next: NextFunction) {
        try {
            const container = req.container!;
            const time = createQueryTimer(log, { containerId: container.id });

            const components = await time(
                "findByImageIdWithDetails",
                componentRepository.findByImageIdWithDetails(container.imageId)
            );
            res.json(components);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/workloads/:id/dependency-tree
     */
    async getDependencyTree(req: Request, res: Response, next: NextFunction) {
        try {
            const container = req.container!;
            const time = createQueryTimer(log, { containerId: container.id });

            const sbom = await time("findByImageId", sbomRepository.findByImageId(container.imageId));
            if (!sbom) {
                res.json({ components: [], dependencies: [] });
                return;
            }

            const [components, dependencies] = await Promise.all([
                time("findBySbomId", componentRepository.findBySbomId(sbom.id)),
                time("getAllDependenciesBySbomId", sbomRepository.getAllDependenciesBySbomId(sbom.id)),
            ]);

            res.json({
                sbomId: sbom.id,
                components,
                dependencies: dependencies.map(d => ({
                    parentComponentId: d.parentComponentId,
                    childComponentId: d.childComponentId,
                })),
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/workloads/:id/vulnerabilities
     */
    async getVulnerabilities(req: Request, res: Response, next: NextFunction) {
        try {
            const container = req.container!;
            const time = createQueryTimer(log, { containerId: container.id });

            const vulnerabilities = await time(
                "findByImageId",
                vulnerabilityRepository.findByImageId(container.imageId)
            );
            res.json(vulnerabilities);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The image's SBOM.
     *
     * Singular where the old `GET /api/projects/:id/sboms` returned a history,
     * because a digest has exactly one SBOM forever — there is nothing to keep
     * a history *of*. What used to be interesting about that list is now the
     * container's image changing, which is `GET /api/workloads/:id/siblings`
     * and the rollout state it shows.
     *
     * Returned as a list so an unscanned image is an empty one rather than a
     * 404 the caller has to special-case.
     *
     * @route GET /api/workloads/:id/sboms
     */
    async getSboms(req: Request, res: Response, next: NextFunction) {
        try {
            const container = req.container!;
            const time = createQueryTimer(log, { containerId: container.id });

            const sbom = await time(
                "findByImageIdWithComponentCount",
                sbomRepository.findByImageIdWithComponentCount(container.imageId)
            );
            if (!sbom) {
                res.json([]);
                return;
            }

            res.json([{
                id: sbom.id,
                createdAt: sbom.createdAt,
                specVersion: sbom.specVersion,
                documentVersion: sbom.documentVersion,
                imageId: sbom.imageId,
                imageTag: container.imageTag,
                imageRef: container.imageRef,
                toolName: sbom.toolName,
                toolVersion: sbom.toolVersion,
                sourceName: sbom.sourceName,
                componentCount: sbom.componentCount,
            }]);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The OSV scan-run history for this container's image — one row per time it
     * was scanned against the mirror. Sourced from the durable
     * `vulnerability_scan_runs` table, not the ephemeral jobs queue.
     *
     * @route GET /api/workloads/:id/scan-history
     */
    async getScanHistory(req: Request, res: Response, next: NextFunction) {
        try {
            const container = req.container!;
            const time = createQueryTimer(log, { containerId: container.id });

            // Windowed to the plan's historyDays: scan runs are history, and
            // history depth is a plan axis (`config/plans.ts`). The retention
            // sweep deletes past-window rows; this makes a downgrade take
            // effect immediately rather than at the next sweep.
            const { historyDays } = getPlanLimits(req.auth!.org.plan);
            const since = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000);
            const runs = await time(
                "findByImageId",
                vulnerabilityScanRunRepository.findByImageId(container.imageId, 50, since)
            );

            res.json(runs.map(run => ({
                id: run.id,
                sbomId: run.sbomId,
                jobId: run.jobId,
                trigger: run.trigger,
                status: run.status,
                componentsScanned: run.componentsScanned,
                vulnsFound: run.vulnsFound,
                counts: {
                    critical: run.critical,
                    high: run.high,
                    medium: run.medium,
                    low: run.low,
                },
                osvMirrorSyncedAt: run.osvMirrorSyncedAt,
                errorMessage: run.errorMessage,
                startedAt: run.startedAt,
                completedAt: run.completedAt,
                durationMs: run.durationMs,
                createdAt: run.createdAt,
            })));
        } catch (error) {
            next(error);
        }
    },

    /**
     * Vulnerabilities grouped by component, pre-sorted and pre-aggregated.
     * View-optimized endpoint for the vulnerabilities tab.
     *
     * The same table `GET /api/images/:id/vulnerabilities/grouped` serves —
     * findings belong to the image, and the container only names it.
     *
     * @route GET /api/workloads/:id/vulnerabilities/grouped
     */
    async getVulnerabilitiesGrouped(req: Request, res: Response, next: NextFunction) {
        try {
            const container = req.container!;
            const { tier } = groupedFindingsQuerySchema.parse(req.query);
            res.json(await loadGroupedFindings(container.imageId, {
                imageTag: container.imageTag,
                imageRef: container.imageRef,
            }, parseTierParam(tier)));
        } catch (error) {
            next(error);
        }
    },

    /**
     * How long each advisory has been on this container's slot, across the
     * digests that carried it, and the container's one headline figure —
     * `docs/exposure-duration-plan-2026-09-19.md` item 5. A displayed fact:
     * exposure is in neither layer of the risk score (ADR 0005, ADR 0007).
     *
     * @route GET /api/workloads/:id/exposure
     */
    async getExposure(req: Request, res: Response, next: NextFunction) {
        try {
            const container = req.container!;
            const time = createQueryTimer(log, { containerId: container.id });
            res.json(await time("exposureForContainer", exposureService.forContainer(container.orgId, container.id)));
        } catch (error) {
            next(error);
        }
    },

    /**
     * Dependencies with children pre-resolved for the dependencies tab.
     *
     * @route GET /api/workloads/:id/dependencies/overview
     */
    async getDependenciesOverview(req: Request, res: Response, next: NextFunction) {
        try {
            const container = req.container!;
            const time = createQueryTimer(log, { containerId: container.id });

            const targetSbom = await time("findByImageId", sbomRepository.findByImageId(container.imageId));
            if (!targetSbom) {
                res.json({ summary: { total: 0, direct: 0, transitive: 0 }, dependencies: [] });
                return;
            }

            const [components, deps] = await Promise.all([
                time("findBySbomIdWithDetails", componentRepository.findBySbomIdWithDetails(targetSbom.id)),
                time("getAllDependenciesBySbomId", sbomRepository.getAllDependenciesBySbomId(targetSbom.id)),
            ]);

            const childrenMap = new Map<string, string[]>();
            const childToParents = new Map<string, string[]>();
            for (const dep of deps) {
                const children = childrenMap.get(dep.parentComponentId) ?? [];
                children.push(dep.childComponentId);
                childrenMap.set(dep.parentComponentId, children);

                const parents = childToParents.get(dep.childComponentId) ?? [];
                parents.push(dep.parentComponentId);
                childToParents.set(dep.childComponentId, parents);
            }

            const directIds = new Set<string>();
            const componentMeta = new Map<string, { name: string; version: string | null }>();
            for (const comp of components) {
                if (comp.isDirect) directIds.add(comp.id);
                componentMeta.set(comp.id, { name: comp.name, version: comp.version });
            }

            let direct = 0;
            let transitive = 0;

            const dependencies = components.map(comp => {
                if (comp.isDirect) direct++;
                else transitive++;

                const isDirect = comp.isDirect ?? false;
                return {
                    id: comp.id,
                    name: comp.name,
                    version: comp.version,
                    isDirect,
                    license: comp.license,
                    purl: comp.purl,
                    vulnerabilities: comp.vulnerabilities,
                    children: childrenMap.get(comp.id) ?? [],
                    dependencyPath: isDirect
                        ? null
                        : findPathToDirect(comp.id, childToParents, directIds, componentMeta),
                    packageType: comp.packageType,
                    location: comp.location,
                };
            });

            res.json({
                summary: { total: components.length, direct, transitive },
                dependencies,
            });
        } catch (error) {
            next(error);
        }
    },
};
