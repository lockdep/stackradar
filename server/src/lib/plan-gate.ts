/**
 * The no-plan contract: an organization without a subscription is read-only.
 *
 * On the cloud, `organizations.plan = 'free'` means "no active plan" — a new
 * org that has not started one yet, or one whose trial or subscription
 * ended (`config/plans.ts`). Such an org keeps its dashboard readable and
 * loses every write: `requireOrg` (`middleware/auth.ts`) refuses non-safe
 * internal requests with `403` and the code below, which the client banner
 * and toast match on to say "start a plan" instead of "Forbidden"; the
 * scanner's inventory and SBOM endpoints refuse the same way, so a lapsed
 * org's agent stops writing while its heartbeat keeps answering `200` (with
 * `planRequired: true`) and the pod stays up.
 *
 * What stays open on such an org is the way back in and the way out —
 * billing (checkout, portal, the slot counter), deleting the org — and the
 * routes that are about the person rather than the org (terms, feedback,
 * creating or joining another org), which `requireOrg` never sees. Routers
 * that must keep working mount {@link allowWithoutPlan}; everything else
 * under `/api` is refused on write by default, so a new route is gated
 * unless someone decides otherwise.
 *
 * The community edition has no plans (`edition.billing` is false) and is
 * never gated; the demo's `read_only_demo` (`lib/demo.ts`) is the sibling
 * contract and the pattern this follows.
 */

import type { Request, Response, NextFunction } from "express";
import { edition } from "../edition.js";
import { AppError } from "../middleware/error-handler.js";
import { isReadMethod } from "./demo.js";
import { organizationRepository } from "../repositories/organization.repository.js";

/** The `code` a write on an org without a plan is refused with. The client matches on it. */
export const PLAN_REQUIRED_CODE = "plan_required";

export const PLAN_REQUIRED_MESSAGE = "Start a plan to use StackRadar Cloud. The dashboard stays readable until you do.";

declare global {
    namespace Express {
        interface Request {
            /** Set by {@link allowWithoutPlan}: this route keeps working on an org without a plan. */
            allowWithoutPlan?: boolean;
        }
    }
}

export function planRequiredError(): AppError {
    return new AppError(403, PLAN_REQUIRED_MESSAGE, true, PLAN_REQUIRED_CODE);
}

/**
 * Whether the org may write. Every stored plan but `free` is a plan
 * (`pro`, `team`, and a value this build does not know, which the limits
 * treat as free but the gate must not: refusing a paying customer over an
 * unrecognised plan string would be the worse failure).
 */
export function orgHasActivePlan(org: { plan: string }): boolean {
    if (!edition.billing) return true;
    return org.plan !== "free";
}

/**
 * Marker middleware for the routers that must keep working on an org
 * without a plan (billing, org deletion). Mounted before `requireOrg`, which
 * reads the flag; it decides nothing itself.
 */
export function allowWithoutPlan(req: Request, _res: Response, next: NextFunction): void {
    req.allowWithoutPlan = true;
    next();
}

/**
 * The gate for routes whose org is `req.auth.org` — the scanner's ingest
 * endpoints, where the org comes from the API key row on every request and
 * `requireOrg` is not mounted. Reads pass; nothing on the ingest surface is
 * a read, so in practice this is "refuse".
 */
export function requireActivePlan(req: Request, _res: Response, next: NextFunction): void {
    if (!req.auth) return next(new AppError(401, "Authentication required"));
    if (!isReadMethod(req.method) && !orgHasActivePlan(req.auth.org)) return next(planRequiredError());
    next();
}

/**
 * The gate for the organization routes, whose org is the `:id` route
 * parameter rather than the ambient `req.auth.org` (they are not behind
 * `requireOrg`). One indexed read per write. `DELETE /:id` — the org's own
 * deletion — is the one write that must keep working; a missing org falls
 * through to the controller's own 404.
 */
export function requireActivePlanForOrgParam(req: Request, _res: Response, next: NextFunction): void {
    if (!edition.billing || isReadMethod(req.method)) return next();
    const id = req.params["id"];
    if (!id) return next();
    // Mounted with `router.use("/:id", …)`, so `req.path` is the remainder
    // after the id; the full path says whether this is the org itself.
    const fullPath = req.originalUrl.split("?")[0] ?? "";
    if (req.method === "DELETE" && fullPath.endsWith(`/organizations/${id}`)) return next();
    organizationRepository
        .getOrganizationById(id)
        .then((org) => {
            if (org && !orgHasActivePlan(org)) throw planRequiredError();
            next();
        })
        .catch(next);
}
