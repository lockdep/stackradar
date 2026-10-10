// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type { CloudHooks } from "../lib/cloud-hooks.js";
import { buildInviteUrl } from "../lib/invite-url.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { cancelSubscriptionForOrgDeletion } from "./billing/billing.controller.js";
import { emailService } from "./email/email.service.js";
import { renderInviteEmail } from "./email/invite.js";
import { attributionService } from "./attribution/attribution.service.js";
import { signupAttributionSchema } from "./attribution/attribution.schema.js";
import { termsRepository } from "./terms/terms.repository.js";
import { CURRENT_TERMS_VERSION } from "./terms/version.js";
import { alertEmailChannel } from "./alerting/alert-email-channel.js";

/**
 * What the cloud does on the core's behalf at the seams the core exposes
 * (`lib/cloud-hooks.ts`): the terms acceptances the login and invite pages
 * promise, the welcome and invite emails, sign-up attribution and the
 * funnel events it drives, the Stripe cancellation that must precede an
 * org's deletion, and the email channel of the alerts. Registered once by
 * `enableCloud()`; absent in the community edition.
 */
export function buildCloudHooks(): CloudHooks {
    return {
        // The login page states, next to the OAuth buttons, that continuing
        // means accepting the terms — this records that acceptance the first
        // time the account reaches the server. Existing users who predate
        // acceptance tracking get the explicit acceptance screen in the
        // dashboard instead (`terms/terms.controller.ts`).
        async onUserSeen(user) {
            await termsRepository.recordAcceptance(user.id, CURRENT_TERMS_VERSION);
        },

        async onSignup(identity, body) {
            const { user, org } = identity;
            // The creator's acceptance also binds the new org.
            await termsRepository.recordOrgAcceptance(org.id, user.id, "owner", CURRENT_TERMS_VERSION);

            // First contact with a self-signed-up user. A side effect:
            // emailService never throws, so a failed send cannot fail setup.
            if (user.isNew) {
                await emailService.sendWelcome(user, { kind: "new_org", orgName: org.name });
            }

            // Record the self-sign-up and where it came from, if the login
            // link said. The client forwards the ad-click parameters it
            // carried through OAuth (its `lib/attribution.ts`); an invalid
            // or absent field is simply "no attribution", never a 400, and
            // an organic sign-up is recorded all the same so the funnel
            // counts it. The service writes the row and fires the sign-up
            // events (analytics, founder alert, ad conversion); it never
            // throws.
            const raw = typeof body === "object" && body !== null ? (body as { attribution?: unknown }).attribution : undefined;
            const attribution = signupAttributionSchema.safeParse(raw);
            await attributionService.recordSignup(
                { user: { id: user.id, email: user.email, name: user.name }, org },
                attribution.success ? attribution.data : {}
            );
        },

        // The creator accepted the terms to get here; that acceptance binds
        // each org they create, recorded per org.
        async onOrganizationCreated({ orgId, userId }) {
            await termsRepository.recordOrgAcceptance(orgId, userId, "owner", CURRENT_TERMS_VERSION);
        },

        async sendInviteEmail(invite, ctx) {
            const content = renderInviteEmail({
                orgName: ctx.orgName,
                inviterName: ctx.inviterName,
                role: invite.role,
                inviteUrl: buildInviteUrl(invite.token),
                expiresAt: invite.expiresAt,
            });
            const result = await emailService.send({
                ...content,
                to: invite.email,
                tags: { type: "org_invite", org_id: invite.orgId },
                idempotencyKey: `org-invite/${invite.id}`,
            });
            return { status: result.status, messageId: result.status === "sent" ? result.messageId : null };
        },

        // The invite page states, next to the accept button, that accepting
        // means agreeing to the terms — the second path into an org, so
        // acceptance is recorded here too, for the user and (if this version
        // isn't bound yet) on behalf of the org they just joined.
        async onInviteAccepted({ userId, orgId, role, tx }) {
            await termsRepository.recordAcceptance(userId, CURRENT_TERMS_VERSION, tx);
            await termsRepository.recordOrgAcceptance(orgId, userId, role, CURRENT_TERMS_VERSION, tx);
        },

        async afterInviteAccepted({ user, org, role }) {
            if (user.isNew) {
                await emailService.sendWelcome(user, { kind: "joined_org", orgName: org.name, role });
            }
        },

        onClusterReported(orgId, report) {
            void attributionService.onClusterReported(orgId, report);
        },

        // Stop the money first — see cancelSubscriptionForOrgDeletion for why
        // this must happen before the soft delete, and why a failure there
        // aborts the whole deletion.
        async beforeOrganizationDelete(org) {
            await cancelSubscriptionForOrgDeletion(org);
            if (org.stripeSubscriptionId) {
                await organizationRepository.updateOrganizationPlan(org.id, "free", {
                    stripeSubscriptionId: null,
                    stripeSubscriptionStatus: null,
                    stripeCurrentPeriodEnd: null,
                    stripeCancelAt: null,
                });
            }
        },

        alertEmail: alertEmailChannel,
    };
}
