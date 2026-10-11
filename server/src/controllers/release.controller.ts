import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import { chartAttributionRepository, helmReleaseRepository, workloadRepository } from "../repositories/index.js";
import { clusterScopeQuerySchema, releaseIdParamSchema } from "../schemas/index.js";
import { recommendForRelease } from "../services/upgrade-recommendation.service.js";
import { artifactHubMatch, isChartDeprecated } from "../lib/chart-attribution.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { asAuthed } from "../middleware/auth.js";

const log = createLogger("release-controller");

/**
 * The release lens.
 *
 * "Which workloads and images does this chart run" is a first-class question,
 * and it needed no new collection — `helm_releases` is derivable from labels
 * and annotations the agent already sends. It is the **third** grouping axis
 * over the same rows, alongside namespace (the folder view) and image (the
 * remediation view): same data, three lenses, no new hierarchy.
 *
 * Two things this deliberately surfaces rather than hides:
 *
 * - **Unmanaged workloads.** Most clusters run plenty of workloads no chart
 *   manages, and a release-grouped view that quietly omits them under-reports
 *   the fleet in a way that is invisible — those rows have no group to be
 *   missing from. `GET /api/releases` therefore carries an `unmanaged` count.
 * - **Chart-name ambiguity.** Several repositories publish `nginx`, and until
 *   `repoUrl` is known "all releases of chart X" is a name match. The flag says
 *   so instead of implying the releases are the same chart.
 */
export const releaseController = {
    /**
     * @route GET /api/releases?clusterId={uuid}
     */
    async getAll(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;

            const { clusterId } = clusterScopeQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId, clusterId });

            // Attributions feed the ambiguity check: a null-repo release whose
            // chart the nightly pass attributed is no longer a silent merge.
            // They also feed the row itself — the list is where "we know which
            // chart this is, and the hub lists a newer one" is worth an eye
            // sweep rather than a page visit per release.
            const attributions = await time("attributionsForOrg", chartAttributionRepository.forOrg(orgId));
            const attributionByChart = new Map(attributions.map((a) => [a.chartName, a]));
            const attributedRepoByChart = new Map(attributions.map((a) => [a.chartName, a.repoUrl]));

            const [releases, unmanaged] = await Promise.all([
                time(
                    "findAllWithCounts",
                    helmReleaseRepository.findAllWithCounts(orgId, clusterId, attributedRepoByChart),
                ),
                time("countUnmanaged", helmReleaseRepository.countUnmanaged(orgId, clusterId)),
            ]);

            res.json({
                releases: releases.map((release) => ({
                    ...release,
                    artifactHub: artifactHubMatch(
                        release,
                        release.chartName ? attributionByChart.get(release.chartName) : undefined,
                    ),
                })),
                unmanaged,
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * A release's workloads, its distinct images and its aggregate findings.
     *
     * The workloads come from `workloads.releaseId`, not from a namespace
     * match, so a chart that deploys into namespaces other than its own still
     * groups under it — grouping by the workload's namespace is what silently
     * splits one release into several.
     *
     * @route GET /api/releases/:id
     */
    async getById(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const { id } = releaseIdParamSchema.parse(req.params);
            const orgId = auth.orgId;
            const time = createQueryTimer(log, { releaseId: id });

            const bare = await time("findById", helmReleaseRepository.findById(id));
            if (!bare || bare.orgId !== orgId) {
                throw new AppError(404, "Release not found");
            }

            const attribution = bare.chartName
                ? await time("findForChart", chartAttributionRepository.findForChart(orgId, bare.chartName))
                : undefined;

            /* The enriched row, not the bare one. `chartNameAmbiguous` is a
               fact about this release *relative to the others* — whether
               anything else claims its chart name from a repository we cannot
               prove is the same — so it can only be computed over the set. The
               detail page needs it precisely because a lone release page is
               where the collision is least visible. */
            const enriched = await time(
                "findAllWithCounts",
                helmReleaseRepository.findAllWithCounts(
                    orgId,
                    bare.clusterId,
                    attribution ? new Map([[attribution.chartName, attribution.repoUrl]]) : undefined,
                ),
            );
            const release = enriched.find((r) => r.id === id);
            if (!release) {
                throw new AppError(404, "Release not found");
            }

            const [workloads, images, findings] = await Promise.all([
                time("findAllWithStats", workloadRepository.findAllWithStats(orgId, { releaseId: id })),
                time("findImagesForRelease", helmReleaseRepository.findImagesForRelease(id)),
                time("findingsForRelease", helmReleaseRepository.findingsForRelease(id)),
            ]);

            // The attribution may only speak for this release when the scanner
            // observed no repo, or observed the one the evidence points at.
            const applicable =
                attribution && (bare.repoUrl === null || bare.repoUrl === attribution.repoUrl)
                    ? attribution
                    : undefined;

            res.json({
                release: {
                    ...release,
                    /** The inferred repo — never written back to `repo_url`. */
                    attributedRepoUrl: bare.repoUrl === null ? (applicable?.repoUrl ?? null) : null,
                    /** Null = cannot say; only an attribution can claim it. */
                    chartDeprecated: applicable ? isChartDeprecated(applicable, bare.chartVersion) : null,
                    /** The same match the list carries, so both surfaces agree. */
                    artifactHub: artifactHubMatch(bare, attribution),
                },
                workloads,
                images,
                findings,
                // Namespaces its workloads actually landed in, which may include
                // ones other than the release's own.
                namespaces: [...new Set(workloads.map((w) => w.namespaceName))].sort(),
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * "This release runs an older chart, and here is what one `helm upgrade`
     * would move."
     *
     * @route GET /api/releases/:id/upgrade
     *
     * The release-scoped upgrade, priced. Note it does not supersede the image-scoped one: image scope stays
     * the default because its blast radius is smaller, and this is the
     * escalation for when the chart pins the tag or one bump subsumes several.
     */
    async getUpgrade(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const { id } = releaseIdParamSchema.parse(req.params);
            const orgId = auth.orgId;
            const time = createQueryTimer(log, { releaseId: id });

            const release = await time("findById", helmReleaseRepository.findById(id));
            if (!release || release.orgId !== orgId) {
                throw new AppError(404, "Release not found");
            }

            res.json(await time("recommendForRelease", recommendForRelease(orgId, id)));
        } catch (error) {
            next(error);
        }
    },
};
