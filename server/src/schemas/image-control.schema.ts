import { z } from "zod";

/**
 * `PUT /api/organizations/:id/image-control-rules` — the org's answers to
 * "which of these do you build?". Only the repositories the user changed are
 * sent; `control: null` resets one to what was detected.
 */
export const imageControlRulesSchema = z.object({
    rules: z
        .array(
            z.object({
                /** Blank or absent means any registry. */
                registry: z.string().trim().max(255).nullable().optional(),
                /** A repository, or a prefix ending in `*`. No other wildcard. */
                repository: z
                    .string()
                    .trim()
                    .min(1)
                    .max(512)
                    .regex(/^[^*\s]+\*?$/, "Only a trailing * is a wildcard"),
                control: z.enum(["built", "third-party"]).nullable(),
                reason: z.string().trim().max(500).nullable().optional(),
            }),
        )
        .min(1)
        .max(500),
});
