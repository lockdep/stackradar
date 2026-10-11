// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
/**
 * The demo fixture: one user, one org, one
 * membership, one terms acceptance, one cluster with one scanner key.
 * Idempotent and keyed on `organizations.slug = 'demo' AND demo = true`, in
 * the `ensurePlatform()` mould: every step is find-or-create, nothing is ever
 * deleted, and a second run is a no-op that reports the same ids.
 *
 * The plaintext API key exists only in the return value of the run that
 * minted it — on creation, or on `rotateKey` — which the CLI in
 * `seed-demo.ts` beside this file prints exactly once. A lost key is recovered with
 * `--rotate-key`, never by re-reading.
 *
 * What is deliberately *not* here: the client-side `users` / `sessions` rows
 * the Auth.js session needs (the client's `/demo/enter` route owns those),
 * and any SBOM or inventory — the demo reporter fills those through `/v1`
 * with the key this mints.
 */

import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { CURRENT_TERMS_VERSION } from "../terms/version.js";
import { clusterRepository } from "../../repositories/cluster.repository.js";
import { termsRepository } from "../terms/terms.repository.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("demo-seed");

export const DEMO_ORG_SLUG = "demo";
export const DEMO_ORG_NAME = "Demo";
export const DEMO_USER_EMAIL = "demo@stackradar.io";
export const DEMO_USER_NAME = "Demo visitor";
/** What a team would call it; the name the UI shows. */
export const DEMO_CLUSTER_NAME = "platform-eu1";

export interface SeedDemoOptions {
    /** Revoke the cluster's active keys and mint a new one, returning it. */
    rotateKey?: boolean;
}

export interface SeedDemoResult {
    userId: string;
    orgId: string;
    clusterId: string;
    /** Present only when this run minted a key (creation or rotation). */
    apiKey?: string;
    created: { user: boolean; org: boolean; membership: boolean; cluster: boolean };
}

export async function seedDemo(options: SeedDemoOptions = {}): Promise<SeedDemoResult> {
    const created = { user: false, org: false, membership: false, cluster: false };

    // 1. User. Keyed on the email (case-insensitive unique index). An
    //    existing row under our own address that is not yet flagged is
    //    flagged, not duplicated — the address is ours, and a non-demo row
    //    there would be a half-run seed, not a customer.
    let [user] = await db
        .select({ id: schema.users.id, demo: schema.users.demo })
        .from(schema.users)
        .where(eq(schema.users.email, DEMO_USER_EMAIL));
    if (!user) {
        [user] = await db
            .insert(schema.users)
            .values({
                email: DEMO_USER_EMAIL,
                name: DEMO_USER_NAME,
                demo: true,
                emailVerified: new Date(),
            })
            .returning({ id: schema.users.id, demo: schema.users.demo });
        created.user = true;
        log.info({ userId: user!.id }, "Created demo user");
    } else if (!user.demo) {
        await db.update(schema.users).set({ demo: true }).where(eq(schema.users.id, user.id));
        log.warn({ userId: user.id }, "Existing user under the demo address was not flagged demo; flagged it");
    }
    if (!user) throw new Error("Failed to create the demo user");

    // 2. Org. The slug index is partial on `deleted_at IS NULL`, so a
    //    soft-deleted `demo` org does not block the insert; a *live* non-demo
    //    org holding the slug does, and the unique violation surfaces as-is —
    //    that is a situation for a person, not a fallback.
    let [org] = await db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(and(eq(schema.organizations.slug, DEMO_ORG_SLUG), eq(schema.organizations.demo, true)));
    if (!org) {
        [org] = await db
            .insert(schema.organizations)
            .values({
                name: DEMO_ORG_NAME,
                slug: DEMO_ORG_SLUG,
                demo: true,
                // Every tab, every history window — and no Stripe customer:
                // the plan is set directly, and billing never sees this org.
                plan: "team",
                color: "emerald",
            })
            .returning({ id: schema.organizations.id });
        created.org = true;
        log.info({ orgId: org!.id }, "Created demo organization");
    }
    if (!org) throw new Error("Failed to create the demo organization");

    // 3. Membership, inserted directly: `addOrgMember` refuses demo orgs by
    //    design, and this is the one sanctioned exception.
    const [membership] = await db
        .insert(schema.orgMembers)
        .values({ userId: user.id, orgId: org.id, role: "member" })
        .onConflictDoNothing()
        .returning({ userId: schema.orgMembers.userId });
    created.membership = membership !== undefined;

    // 4. Terms. The dashboard gates on the user's own acceptance; the org
    //    row is the counterparty evidence the same way `/users/setup` records
    //    it for a self-signed-up owner. Both are conflict-tolerant.
    await termsRepository.recordAcceptance(user.id, CURRENT_TERMS_VERSION);
    await termsRepository.recordOrgAcceptance(org.id, user.id, "member", CURRENT_TERMS_VERSION);

    // 5. Cluster + key, through the repository so the key carries exactly
    //    the name and scopes the cluster wizard mints (`sbom:write`).
    let apiKey: string | undefined;
    let [cluster] = await db
        .select({ id: schema.clusters.id })
        .from(schema.clusters)
        .where(and(eq(schema.clusters.orgId, org.id), eq(schema.clusters.name, DEMO_CLUSTER_NAME)));
    if (!cluster) {
        const result = await clusterRepository.createWithApiKey(
            {
                orgId: org.id,
                name: DEMO_CLUSTER_NAME,
                description: "Live demo cluster — reported by the demo reporter, read-only in the UI",
            },
            user.id,
        );
        cluster = { id: result.cluster.id };
        apiKey = result.apiKey;
        created.cluster = true;
        log.info({ clusterId: cluster.id }, "Created demo cluster and scanner key");
    } else if (options.rotateKey) {
        // 6. Rotation: revokes every active key for the cluster first, so
        //    exactly one is live afterwards.
        apiKey = await clusterRepository.rotateApiKey(cluster.id, org.id, user.id);
        log.info({ clusterId: cluster.id }, "Rotated demo cluster scanner key");
    }

    return {
        userId: user.id,
        orgId: org.id,
        clusterId: cluster.id,
        ...(apiKey ? { apiKey } : {}),
        created,
    };
}
