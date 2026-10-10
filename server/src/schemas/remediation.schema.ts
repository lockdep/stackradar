import { z } from "zod";

// ============================================================================
// Remediation workflow — docs/proposals/remediation-workflow.md, renamed and
// widened by docs/proposals/issues-workflow.md.
//
// Three rules the shapes below encode rather than leave to handlers:
//
// - Suppression requires an owner, a reason and an expiry. The owner comes
//   from the auth context; reason and expiry are mandatory here, so a request
//   without them never reaches the service.
// - `verified` is not a state a request may ask for. The transition schema
//   admits `open`, `snoozed`, `applied` and `closed` only — verification is
//   written by the sweeps, never by a client.
// - `closed` requires a reason. Without it, snooze would be the only honest
//   manual exit, which is a different lie.
// ============================================================================

export const issueIdParamSchema = z.object({
    id: z.uuid("Invalid issue ID"),
});

/** `?cluster=` scopes the Fix tab to one cluster; absent = the whole org. */
export const rollupQuerySchema = z.object({
    cluster: z.uuid("Invalid cluster ID").optional(),
});

export const findingStateIdParamSchema = z.object({
    id: z.uuid("Invalid suppression ID"),
});

export const createIssueSchema = z
    .object({
        scope: z.enum(["image", "release", "finding"]),
        imageId: z.uuid("Invalid image ID").optional(),
        releaseId: z.uuid("Invalid release ID").optional(),
        toTag: z.string().min(1).max(255).optional(),
        toDigest: z.string().min(1).max(128).optional(),
        toChartVersion: z.string().min(1).max(128).optional(),
        /* Finding scope: the advisory the user acted on plus the package it
           was found in; the service resolves the collapsed identity. */
        vulnId: z.string().min(1).max(255).optional(),
        packageType: z.string().min(1).max(50).optional(),
        packageName: z.string().min(1).max(512).optional(),
        notes: z.string().max(2000).optional(),
    })
    .refine(
        (a) =>
            a.scope === "image"
                ? a.imageId != null
                : a.scope === "release"
                  ? a.releaseId != null
                  : a.vulnId != null && a.packageType != null && a.packageName != null,
        {
            message:
                "An image issue needs imageId; a release issue needs releaseId; a finding issue needs vulnId, packageType and packageName",
        }
    );

export const transitionIssueSchema = z
    .object({
        state: z.enum(["open", "snoozed", "applied", "closed"]),
        snoozedUntil: z.coerce.date().optional(),
        closedReason: z.enum(["fixed-otherwise", "wont-fix", "no-longer-relevant"]).optional(),
        closedNote: z.string().max(2000).optional(),
    })
    .refine((t) => t.state !== "snoozed" || t.snoozedUntil != null, {
        message: "Snoozing requires snoozedUntil",
    })
    .refine((t) => t.state !== "closed" || t.closedReason != null, {
        message: "Closing an issue requires a reason",
    });

export const listIssuesQuerySchema = z.object({
    state: z.enum(["open", "snoozed", "applied", "verified", "closed"]).optional(),
    cluster: z.uuid("Invalid cluster ID").optional(),
});

export const suppressFindingSchema = z.object({
    kind: z.enum(["suppressed", "accepted-risk"]).default("suppressed"),
    vulnId: z.string().min(1).max(255),
    packageType: z.string().min(1).max(50),
    packageName: z.string().min(1).max(512),
    reason: z.string().min(1, "A suppression requires a reason").max(2000),
    expiresAt: z.coerce.date(),
});

export const activityQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(500).default(100),
});
