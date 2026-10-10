import type { Request, Response, NextFunction, RequestHandler } from "express";
import { edition, type Capabilities } from "../edition.js";
import { AppError } from "./error-handler.js";

/**
 * The edition gates on the HTTP surface (docs/open-source-plan-2026-10-10.md
 * step 03). A capability the edition lacks is a `403` with a code the client
 * can match on and a message that says what the community edition *is*, not
 * just what it refuses — the same shape as the system-org guards in
 * `cluster.repository.ts` and the demo's `read_only_demo`.
 *
 * 403, not 404: the route exists in both editions and the caller is who
 * they say they are; what is missing is the edition's permission. The
 * cloud-only routers are the ones that are 404 in community
 * (`app.ts`), because there the route itself is absent.
 *
 * The client never shows the control in the first place (it reads the same
 * capabilities through `useRuntimeConfig().edition`); this is what makes
 * the rule hold for a request that did not come from the UI.
 */

/** The `code` a community-edition request for a second organisation is refused with. */
export const SINGLE_ORGANIZATION_CODE = "single_organization";
/** The `code` a community-edition cluster or key write is refused with. */
export const SINGLE_CLUSTER_CODE = "single_cluster";

export const SINGLE_ORGANIZATION_MESSAGE =
    "The community edition has one organisation. Everyone who signs in joins it.";
export const SINGLE_CLUSTER_MESSAGE =
    "The community edition manages one cluster, the one it runs in; its scanner key is set by BOOTSTRAP_CLUSTER_API_KEY on the server. Multiple clusters in one dashboard are a StackRadar Cloud feature.";

function requireCapability(
    capability: keyof Pick<Capabilities, "multiOrg" | "multiCluster">,
    refusal: { message: string; code: string },
    caps: Capabilities = edition,
): RequestHandler {
    return (_req: Request, _res: Response, next: NextFunction) => {
        if (caps[capability]) return next();
        next(new AppError(403, refusal.message, true, refusal.code));
    };
}

/** `POST /api/users/organizations`: a second organisation. */
export const requireMultiOrg = requireCapability("multiOrg", {
    message: SINGLE_ORGANIZATION_MESSAGE,
    code: SINGLE_ORGANIZATION_CODE,
});

/** `POST /api/clusters` and the key rotate/revoke: another cluster, or another key. */
export const requireMultiCluster = requireCapability("multiCluster", {
    message: SINGLE_CLUSTER_MESSAGE,
    code: SINGLE_CLUSTER_CODE,
});
