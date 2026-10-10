import { z } from "zod";

// ============================================================================
// Organization Schemas
// ============================================================================

/**
 * Valid organization colors for theming
 */
export const ORG_COLORS = [
    "emerald",
    "blue",
    "purple",
    "orange",
    "pink",
    "cyan",
    "indigo",
    "rose",
] as const;

export const orgColorSchema = z.enum(ORG_COLORS);

/**
 * Valid member roles
 */
export const memberRoleSchema = z.enum(["admin", "member"]);

/**
 * Critical & KEV alert settings (`controllers/alerts.controller.ts`).
 * `slackWebhookUrl: null` removes the webhook; the URL's shape is checked in
 * the controller (`lib/slack-webhook.ts`), not here.
 */
export const updateAlertsSchema = z.object({
    emailEnabled: z.boolean().optional(),
    slackWebhookUrl: z.string().trim().max(2048).nullable().optional(),
    /** The severity floor; `none` leaves only the KEV rule. */
    minSeverity: z.enum(["critical", "high", "none"]).optional(),
    /** Anything on CISA KEV, whatever its severity. */
    kev: z.boolean().optional(),
});

/**
 * Schema for updating organization settings
 */
export const updateOrgSchema = z.object({
    name: z.string().min(1).max(255).optional(),
    color: orgColorSchema.nullable().optional(),
    /** The Monday weekly digest email to owners and admins. */
    weeklyDigestEnabled: z.boolean().optional(),
    /** The findings view this org's tables and its digest open on. */
    defaultFindingTier: z.enum(["application", "all"]).optional(),
});

/**
 * Schema for updating a member's role
 */
export const updateMemberRoleSchema = z.object({
    role: memberRoleSchema,
});

/**
 * Schema for creating an invite
 */
export const createInviteSchema = z.object({
    email: z.email("Invalid email address"),
    role: memberRoleSchema.default("member"),
});

