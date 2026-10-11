/**
 * The seam between the AGPL core and `src/cloud/` for the side effects the
 * core performs *on the cloud's behalf* — the handful of places where a
 * community-edition request would, on the cloud, also record a terms
 * acceptance, send an email, report a conversion or cancel a subscription.
 *
 * The core never imports from `src/cloud/`; the cloud registers its
 * handlers here once at start-up (`cloud/index.ts` `enableCloud()`), and
 * every call site below is a no-op until it does. That keeps the
 * licence boundary visible in both directions: what the core hands the
 * cloud is exactly this interface, and in the community edition the
 * handlers are simply absent — off, not broken.
 *
 * HTTP routes do not go through here; they are mounted by `mountCloud(app)`.
 */

import type { Transaction } from "../db/index.js";
import type { InviteEmailStatus, Organization, OrgInvite, OrgRole } from "../db/schema/index.js";
import type { AlertBatch } from "./alert-batch.js";
import type { AlertOrg } from "../repositories/alert.repository.js";

/** The account and organisation a self-sign-up created. */
export interface SignupIdentity {
    user: { id: string; email: string; name: string | null; isNew: boolean };
    org: { id: string; name: string };
}

/** What an inventory report says about itself. */
export interface ClusterReport {
    clusterId: string;
    accepted: { namespaces: number; workloads: number; containers: number };
    scannerVersion: string | null;
}

/** What sending an invite email came to; stored on the invite row by the core. */
export interface InviteEmailOutcome {
    status: InviteEmailStatus;
    messageId: string | null;
}

/** An alert channel's outcome, as the settings page and the send log record it. */
export type ChannelOutcome = { status: "sent" } | { status: "failed"; error: string } | { status: "not_configured" };

/** The email half of the critical & KEV alerts (`alerting: "full"` only). */
export interface AlertEmailChannel {
    /** Send one batch to the org's owners and admins; counts per message. */
    deliver(org: AlertOrg, batch: AlertBatch, now: Date): Promise<{ sent: number; failed: number }>;
    /** The settings page's test send, to the person who clicked. */
    sendTest(org: AlertOrg, requester: { id: string; email: string }, now: Date): Promise<ChannelOutcome>;
    /** Who the email channel reaches, for the settings page. */
    recipients(orgId: string): Promise<{ email: string; name: string | null }[]>;
}

export interface CloudHooks {
    /**
     * `POST /users/setup` saw an account, before the organisation check —
     * where the cloud records the login-page terms acceptance.
     */
    onUserSeen?(user: { id: string }): Promise<void>;
    /**
     * `POST /users/setup` created the account's first organisation. The
     * body is the raw request body (attribution rides in it); the handler
     * validates what it uses.
     */
    onSignup?(identity: SignupIdentity, body: unknown): Promise<void>;
    /** `POST /users/organizations` created a further organisation. */
    onOrganizationCreated?(input: { orgId: string; userId: string }): Promise<void>;
    /**
     * An invite was created; send it. Returns the email status to store on
     * the invite row. Absent: the invite is link-only, status `not_configured`.
     */
    sendInviteEmail?(
        invite: OrgInvite,
        ctx: { orgName: string; inviterName: string | null },
    ): Promise<InviteEmailOutcome>;
    /** Inside the accept-invite transaction, after the membership row. */
    onInviteAccepted?(input: { userId: string; orgId: string; role: OrgRole; tx: Transaction }): Promise<void>;
    /** After the accept-invite transaction committed; `isNew` is the users row. */
    afterInviteAccepted?(input: {
        user: { id: string; email: string; name: string | null; isNew: boolean };
        org: { id: string; name: string };
        role: OrgRole;
    }): Promise<void>;
    /** Every inventory report, after it was recorded (fire-and-forget). */
    onClusterReported?(orgId: string, report: ClusterReport): void;
    /**
     * `DELETE /organizations/:id`, before the soft delete. Throwing aborts
     * the deletion — the cloud uses that to refuse deleting an org whose
     * subscription could not be cancelled.
     */
    beforeOrganizationDelete?(org: Organization): Promise<void>;
    /** The email channel of the alerts; absent means webhook-only. */
    alertEmail?: AlertEmailChannel;
}

let registered: CloudHooks = {};

/** Called once by the cloud at start-up. A second call replaces the set. */
export function registerCloudHooks(hooks: CloudHooks): void {
    registered = hooks;
}

/**
 * The call sites' view: every hook callable, absent ones no-ops. Read
 * through a getter so a registration after import is seen.
 */
export const cloudHooks = {
    async onUserSeen(user: { id: string }): Promise<void> {
        await registered.onUserSeen?.(user);
    },
    async onSignup(identity: SignupIdentity, body: unknown): Promise<void> {
        await registered.onSignup?.(identity, body);
    },
    async onOrganizationCreated(input: { orgId: string; userId: string }): Promise<void> {
        await registered.onOrganizationCreated?.(input);
    },
    async sendInviteEmail(
        invite: OrgInvite,
        ctx: { orgName: string; inviterName: string | null },
    ): Promise<InviteEmailOutcome> {
        return registered.sendInviteEmail
            ? registered.sendInviteEmail(invite, ctx)
            : { status: "not_configured", messageId: null };
    },
    async onInviteAccepted(input: { userId: string; orgId: string; role: OrgRole; tx: Transaction }): Promise<void> {
        await registered.onInviteAccepted?.(input);
    },
    async afterInviteAccepted(input: Parameters<NonNullable<CloudHooks["afterInviteAccepted"]>>[0]): Promise<void> {
        await registered.afterInviteAccepted?.(input);
    },
    onClusterReported(orgId: string, report: ClusterReport): void {
        registered.onClusterReported?.(orgId, report);
    },
    async beforeOrganizationDelete(org: Organization): Promise<void> {
        await registered.beforeOrganizationDelete?.(org);
    },
    get alertEmail(): AlertEmailChannel | null {
        return registered.alertEmail ?? null;
    },
};
