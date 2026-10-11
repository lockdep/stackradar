/**
 * May this organisation see this image?
 *
 * Since [ADR 0006](../../../docs/adr/0006-images-are-cluster-scoped.md) an
 * image belongs to one cluster and therefore one org — `images.org_id` is a
 * column — so the answer is a column comparison: **an org may see an image it
 * owns.** The EXISTS probe over `workload_containers` that used to live here
 * ("an org may see an image it is running") was forced by the absence of that
 * column; with it, an uploaded-but-not-yet-inventoried image is visible to its
 * owning org, which is correct — it is their upload.
 *
 * This module is that answer, once. It exists because the rule was previously
 * re-implemented per controller and two controllers forgot: `image.controller`
 * proved ownership through `findDeployments`, while `GET /api/sboms/:id`,
 * `DELETE /api/sboms/:id` and the whole `/api/vulnerabilities` router did not
 * check at all — any signed-in user could read or delete any tenant's SBOM by
 * UUID. A rule spelled out in four places is a rule three places can drift from.
 *
 * The three entry points below are one question asked from three depths of the
 * same chain. Everything downstream of an image — `sboms → components →
 * component_vulnerabilities` — inherits its tenancy from the image, so a new
 * surface reaching one of those tables adds a resolver here rather than a
 * predicate of its own.
 *
 * **Not an ownership check on the advisory itself.** `vulnerabilities` and
 * `osv_vulns` are public facts about the world, shared by every tenant and
 * scoped by nothing. Only the *link* between an advisory and a customer's
 * component is tenant data, and that link is reached through a component.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "./index.js";
import { components } from "./schema/components.js";
import { images } from "./schema/images.js";
import { sboms } from "./schema/sboms.js";

/**
 * Does `orgId` own `imageId`?
 *
 * A `LIMIT 1` existence probe on the image row itself, served by the primary
 * key. Kept as an async boolean rather than inlined at call sites so the rule
 * stays in one place — the name still says "runs" for call-site stability;
 * read it as "owns".
 */
export async function orgRunsImage(orgId: string, imageId: string): Promise<boolean> {
    const rows = await db
        .select({ one: sql`1` })
        .from(images)
        .where(and(eq(images.id, imageId), eq(images.orgId, orgId)))
        .limit(1);

    return rows.length > 0;
}

/**
 * Same question, entered from an SBOM id.
 *
 * Resolves through `sboms.imageId` rather than making the caller load the SBOM
 * first, so an unauthorised request is refused before its component list is
 * ever assembled. A missing SBOM and a forbidden one both come back `false`,
 * which is what lets the caller answer 404 to each and leak nothing about which
 * digests exist.
 */
export async function orgRunsImageOfSbom(orgId: string, sbomId: string): Promise<boolean> {
    const rows = await db
        .select({ one: sql`1` })
        .from(sboms)
        .innerJoin(images, eq(sboms.imageId, images.id))
        .where(and(eq(sboms.id, sbomId), eq(images.orgId, orgId)))
        .limit(1);

    return rows.length > 0;
}

/**
 * Same question, entered from a component id — the depth the vulnerability
 * surfaces reach in at.
 */
export async function orgRunsImageOfComponent(orgId: string, componentId: string): Promise<boolean> {
    const rows = await db
        .select({ one: sql`1` })
        .from(components)
        .innerJoin(sboms, eq(components.sbomId, sboms.id))
        .innerJoin(images, eq(sboms.imageId, images.id))
        .where(and(eq(components.id, componentId), eq(images.orgId, orgId)))
        .limit(1);

    return rows.length > 0;
}
