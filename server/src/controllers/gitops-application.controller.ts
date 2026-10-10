import type { Request, Response, NextFunction } from "express";
import { gitopsApplicationRepository } from "../repositories/index.js";
import { clusterScopeQuerySchema } from "../schemas/index.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";

const log = createLogger("gitops-application-controller");

/**
 * The delivery lens — the fourth grouping axis over the same workload rows,
 * alongside namespace (the folder view), chart (what packaged it) and image
 * (the remediation view).
 *
 * It is **not** a redefinition of the chart lens. Grouping by Chart keeps
 * meaning "which chart packaged this", and its unmanaged bucket keeps meaning
 * "no chart"; grouping by App answers "which Argo app delivers this", and its
 * own bucket is the workloads no app delivers — which includes the scanner
 * itself, `helm install`ed with no GitOps tool above it. Neither bucket is the
 * other's, and the workloads in both are the cluster's genuine floor.
 *
 * Why a sibling of `/releases` rather than a field on it: ArgoCD commonly
 * deploys *via* Helm, so a workload legitimately has both, and the two answers
 * are needed for different halves of the same remediation — the chart version
 * is what a CVE report cites, and the app's `targetRevision` is where the fix
 * is made. See `db/schema/gitops-applications.ts`.
 */
export const gitopsApplicationController = {
    /**
     * @route GET /api/applications?clusterId={uuid}
     */
    async getAll(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;

            const { clusterId } = clusterScopeQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId, clusterId });

            const [applications, undelivered] = await Promise.all([
                time("findAllWithCounts", gitopsApplicationRepository.findAllWithCounts(orgId, clusterId)),
                time("countUndelivered", gitopsApplicationRepository.countUndelivered(orgId, clusterId)),
            ]);

            /* `undelivered`, not `unmanaged`: these are workloads no GitOps
               tool delivers, which is a different set from the ones no chart
               manages. Naming them the same thing is what would invite the two
               buckets to be read as one. */
            res.json({ applications, undelivered });
        } catch (error) {
            next(error);
        }
    },
};
