// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { z } from "zod";

/**
 * POST /api/feedback body. The message cap matches what the dialog enforces
 * client-side; `page` is capped to the column width rather than rejected,
 * because a pathological URL should not lose the feedback it came with.
 */
export const createFeedbackSchema = z.object({
    message: z
        .string()
        .trim()
        .min(1, "Feedback message is required")
        .max(5000, "Feedback is too long (max 5000 characters)"),
    page: z
        .string()
        .optional()
        .transform((s) => {
            const trimmed = s?.trim().slice(0, 1024);
            return trimmed ? trimmed : undefined;
        }),
});
