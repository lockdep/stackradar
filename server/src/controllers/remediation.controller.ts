import type { Request, Response, NextFunction } from "express";
import { fixesForOrg } from "../services/remediation.service.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { asAuthed } from "../middleware/auth.js";

const log = createLogger("remediation-controller");

/**
 * The remediation surface: one read-only list of the moves the product can
 * recommend across the org, ranked. The dashboard's "Fix these first" block
 * reads the top of it; the image and release pages carry their own panels.
 * Nothing here implies an upgrade is safe — the copy states what a move
 * clears, what it leaves, and stops.
 */
export const remediationController = {
    /**
     * Every move the product can recommend across the org, ranked, plus the
     * images with findings it has no move for and why. Read-only by
     * construction — nothing here applies anything.
     *
     * @route GET /api/remediation/fixes
     */
    async getFixes(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const time = createQueryTimer(log, { orgId });
            const page = await time("fixesForOrg", fixesForOrg(orgId));
            res.json(page);
        } catch (error) {
            next(error);
        }
    },
};
