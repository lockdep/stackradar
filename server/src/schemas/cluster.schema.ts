import { z } from "zod";

/** Zod schemas for `/api/clusters` and the org-wide Radar Score routes. */

/**
 * A cluster name is a label for people, not an identifier for machines —
 * nothing downstream (the scanner install, the API key, the inventory) ever
 * keys on it, so the old DNS-label rule was only ever friction. Free text,
 * bounded: letters, numbers, spaces, hyphens, underscores and periods; 2–63
 * characters after trimming; must start with a letter or number.
 *
 * Mirrored in `client/src/components/clusters/newClusterWizard.ts` — keep the
 * two in step.
 */
export const CLUSTER_NAME_MAX_LENGTH = 63;
export const CLUSTER_NAME_MIN_LENGTH = 2;
const CLUSTER_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

const CLUSTER_NAME = z
    .string()
    .trim()
    .min(CLUSTER_NAME_MIN_LENGTH, `Name must be at least ${CLUSTER_NAME_MIN_LENGTH} characters`)
    .max(CLUSTER_NAME_MAX_LENGTH, `Name must be ${CLUSTER_NAME_MAX_LENGTH} characters or fewer`)
    .regex(
        CLUSTER_NAME_RE,
        "Name can only contain letters, numbers, spaces, hyphens, underscores and periods, and must start with a letter or number",
    );

export const createClusterSchema = z.object({
    name: CLUSTER_NAME,
    description: z.string().max(1000).optional(),
});

export const updateClusterSchema = z.object({
    name: CLUSTER_NAME.optional(),
    description: z.string().max(1000).nullable().optional(),
});

/**
 * `?tier=application,main` — the tier lens (`db/finding-tier.ts`). Comma-joined
 * like `severity`, unknown values ignored, absent means no lens. Parsed by
 * `parseTierParam`; every findings endpoint spreads this one field so the
 * parameter cannot mean two things.
 */
export const tierQueryField = { tier: z.string().max(100).optional() };

/**
 * `?control=` — "Yours / Third-party" on a findings or packages list. Anything else — a
 * stale or hand-edited link — is no filter.
 */
export const controlQueryField = { control: z.enum(["yours", "third-party"]).optional().catch(undefined) };

/** `GET …/vulnerabilities/grouped` — the image and container findings tables. */
export const groupedFindingsQuerySchema = z.object({ ...tierQueryField });

/**
 * `?cluster=` and `?namespace=` on the vulnerability lists — the same two
 * parameters `/containers` reads, so a scoped link means the same thing on
 * both. The namespace is a *name* and spans clusters. A cluster id that is not
 * a uuid — a stale or hand-edited link — is no filter; one that is another
 * org's lists nothing, because the org scope is still applied.
 */
export const withinQueryFields = {
    cluster: z.uuid().optional().catch(undefined),
    namespace: z.string().min(1).max(253).optional().catch(undefined),
};

/**
 * `?kev=true` on the vulnerability and package lists — only findings on the
 * CISA KEV catalogue (a package list: only packages with one). Anything else
 * is no filter.
 */
export const kevQueryField = { kev: z.literal("true").optional().catch(undefined) };

export const clusterVulnerabilitiesQuerySchema = z.object({
    /* Comma-joined, matching the tab's URL parameter. Unknown values degrade
       to "no filter on that value" rather than 400 — the same treatment a
       hand-edited filter gets in the client's own URL handling. */
    severity: z.string().max(100).optional(),
    search: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    /* An unknown column or direction degrades to the default order, like the filters above. */
    sort: z
        .enum(["radar", "severity", "cvss", "epss", "kev", "published", "packages", "images", "containers"])
        .optional()
        .catch(undefined),
    order: z.enum(["asc", "desc"]).optional().catch(undefined),
    ...kevQueryField,
    ...tierQueryField,
    ...controlQueryField,
    ...withinQueryFields,
});

export const clusterVulnerabilityOccurrencesQuerySchema = z.object({
    /** The identity of a listed row — the collapse key, not a raw advisory id. */
    identity: z.string().min(1, "identity is required").max(255),
    ...tierQueryField,
    ...controlQueryField,
    ...withinQueryFields,
});

/** `GET /api/vulnerabilities/:vulnId/overview` — an advisory id as a reader types it. */
export const vulnerabilityIdParamSchema = z.object({
    vulnId: z.string().trim().min(1).max(100),
});

export const clusterRadarScoreQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    /** "Yours / Third-party". Anything else — a stale or hand-edited link — is no filter. */
    control: z.enum(["yours", "third-party"]).optional().catch(undefined),
});

export const clusterRadarScoreFindingsQuerySchema = z.object({
    imageId: z.uuid("Invalid image ID"),
    ...tierQueryField,
});

/**
 * `?ecosystem=` on the package lists — a purl type (`npm`, `golang`), or a
 * type and its distro namespace for OS packages (`deb/ubuntu`). The shape is
 * checked rather than a vocabulary: the values are whatever the scanned
 * purls carry, and one outside the shape — `%` and `_` included, so it can
 * go into a LIKE prefix as written — is no filter.
 */
export const ecosystemQueryField = {
    ecosystem: z
        .string()
        .max(64)
        .regex(/^[a-z0-9.+-]+(\/[a-z0-9.+-]+)?$/)
        .optional()
        .catch(undefined),
};

export const clusterComponentsQuerySchema = z.object({
    search: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    ...controlQueryField,
    ...ecosystemQueryField,
    /* Comma-joined like the vulnerability lists' — `severity=critical,high` —
       and read the same way: values outside the four bands are ignored. */
    severity: z.string().max(100).optional(),
    ...kevQueryField,
});

export const clusterPackageOccurrencesQuerySchema = z.object({
    name: z.string().min(1, "name is required").max(512),
    // Absent means "the versionless component", matching the null the
    // packages list showed — not a wildcard over every version.
    version: z.string().max(255).optional(),
    ...controlQueryField,
});

/** A `:clusterId` route param (the metrics routes name it this way). */
export const clusterIdParamSchema = z.object({
    clusterId: z.uuid("Invalid cluster ID"),
});
