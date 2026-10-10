// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type { Request, Response, NextFunction } from "express";
import { createLogger, createQueryTimer } from "../../lib/logger.js";
import { termsRepository } from "./terms.repository.js";
import { CURRENT_TERMS_VERSION } from "./version.js";

const log = createLogger("terms.controller");

/**
 * The terms-of-service gate — the cloud's. A self-hoster is not a party to
 * the cloud's terms, so in the community edition these routes do not exist
 * and the client never asks.
 */
export const termsController = {
  /**
   * The current user's terms-of-service standing: the version the service
   * requires, the latest version they accepted, and whether those match.
   * The client's terms gate renders from this — the required version is
   * never duplicated client-side.
   *
   * @route GET /api/users/terms
   */
  async status(req: Request, res: Response, next: NextFunction) {
    // requireAuth + requireInternal are mounted on the router.
    const userId = req.auth!.userId!;

    try {
      const time = createQueryTimer(log, { userId });
      const latest = await time("getLatestAcceptance", termsRepository.getLatestAcceptance(userId));

      res.json({
        requiredVersion: CURRENT_TERMS_VERSION,
        acceptedVersion: latest?.termsVersion ?? null,
        accepted: latest?.termsVersion === CURRENT_TERMS_VERSION,
      });
    } catch (error) {
      log.error({ err: error, userId }, "Failed to get terms status");
      next(error);
    }
  },

  /**
   * Record that the current user accepted the current terms version.
   * Idempotent; the version is always the server's, never the client's —
   * a stale tab accepting yesterday's terms must not record yesterday's
   * version.
   *
   * @route POST /api/users/terms/accept
   */
  async accept(req: Request, res: Response, next: NextFunction) {
    const userId = req.auth!.userId!;

    try {
      const time = createQueryTimer(log, { userId });
      await time("recordTermsAcceptance", termsRepository.recordAcceptance(userId, CURRENT_TERMS_VERSION));
      // Any member's acceptance binds their orgs for now (admin-only later —
      // the filter goes here, not in the table).
      await time("recordOrgTermsAcceptances", termsRepository.recordAcceptanceForMemberOrgs(userId, CURRENT_TERMS_VERSION));

      log.info({ userId, termsVersion: CURRENT_TERMS_VERSION }, "Terms accepted");

      res.json({
        accepted: true,
        acceptedVersion: CURRENT_TERMS_VERSION,
      });
    } catch (error) {
      log.error({ err: error, userId }, "Failed to record terms acceptance");
      next(error);
    }
  },
};
