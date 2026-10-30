import { z } from "zod";

/**
 * `GET /api/feed`. `days` is clamped to the plan's
 * history window by the controller, like the metrics endpoints; `cursor` is
 * the opaque keyset the previous page returned.
 */
export const feedQuerySchema = z.object({
    days: z.coerce.number().int().positive().max(730).default(30),
    limit: z.coerce.number().int().positive().max(500).default(200),
    cursor: z.string().min(1).max(200).optional(),
    cluster: z.guid().optional(),
});

/** The bands a movement row can be filtered on — the scored four; rows never exist on `unscored` alone. */
export const MOVEMENT_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type MovementSeverity = (typeof MOVEMENT_SEVERITIES)[number];

/**
 * `GET /api/feed/movement?days=` — the Dashboard's "New on running images"
 * block. A fixed window, not the reader's last visit: the same page reads
 * the same on every refresh. Clamped to the plan's history window.
 */
export const feedMovementQuerySchema = z.object({
    days: z.coerce.number().int().positive().max(90).default(7),
    /** The tier lens — see `tierQueryField` in `cluster.schema.ts`. */
    tier: z.string().max(100).optional(),
    /** Only images one side controls — the findings lists' `?control=`; a bad value is no filter. */
    control: z.enum(["yours", "third-party"]).optional().catch(undefined),
    /**
     * Comma-separated bands; an image is kept when it gained a finding in any
     * of them. Unknown values are dropped, and none left means no filter — a
     * hand-edited value degrades to "everything" rather than a 400.
     */
    severity: z
        .string()
        .max(100)
        .optional()
        .transform((raw) =>
            (raw ?? "")
                .split(",")
                .map((s) => s.trim().toLowerCase())
                .filter((s): s is MovementSeverity => (MOVEMENT_SEVERITIES as readonly string[]).includes(s)),
        ),
});

/** `GET /api/feed/movement/:imageId/findings?days=` — the findings behind one movement row. */
export const feedMovementFindingsParamsSchema = z.object({
    imageId: z.guid(),
});
