// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type { Request, Response, NextFunction } from "express";
import { feedbackRepository } from "./feedback.repository.js";
import { createFeedbackSchema } from "./feedback.schema.js";
import { adminListQuerySchema } from "../../schemas/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("feedback.controller");

export const feedbackController = {
  /**
   * Store a feedback message from the signed-in user.
   *
   * @route POST /api/feedback
   */
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { message, page } = createFeedbackSchema.parse(req.body);
      // requireAuth + requireInternal proved this is a BFF request acting as
      // a user, so userId is present on the internal auth branch.
      const userId = req.auth!.userId!;

      const entry = await feedbackRepository.create({
        userId,
        orgId: req.auth!.orgId ?? null,
        message,
        page: page ?? null,
      });

      log.info({ userId, feedbackId: entry.id }, "Feedback submitted");
      res.status(201).json({ id: entry.id, createdAt: entry.createdAt });
    } catch (error) {
      next(error);
    }
  },

  /**
   * The admin inbox: every message, cross-tenant, newest first.
   *
   * @route GET /api/admin/feedback
   */
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const { limit, offset } = adminListQuerySchema.parse(req.query);
      const [entries, total] = await Promise.all([
        feedbackRepository.listAll(limit, offset),
        feedbackRepository.countAll(),
      ]);
      res.json({ feedback: entries, total, limit, offset });
    } catch (error) {
      next(error);
    }
  },
};
