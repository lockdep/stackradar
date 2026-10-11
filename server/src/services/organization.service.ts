/**
 * Membership changes that have to be atomic across repositories. The
 * controllers decide *whether* a request may do something; what they must
 * not own is the transaction that does it, because a second caller (a CLI,
 * a test, the cloud's hooks) then re-implements the locking and gets it
 * subtly wrong.
 */

import { db } from "../db/index.js";
import { organizationRepository, inviteRepository } from "../repositories/index.js";
import { AppError } from "../middleware/error-handler.js";
import { cloudHooks } from "../lib/cloud-hooks.js";
import type { OrgInvite, OrgRole } from "../db/schema/index.js";

/**
 * Add the member and consume the invite atomically. The org row lock
 * serializes concurrent acceptances so they cannot race past the member
 * limit, which is re-checked here: the plan may have changed (or seats
 * filled up) since the invite was created. The cloud records the terms
 * acceptance the invite page states next to its button inside the same
 * transaction, so it is rolled back with the membership on failure.
 */
export async function acceptInviteMembership(input: {
    invite: OrgInvite;
    userId: string;
    /** The plan's member ceiling at acceptance time. */
    memberLimit: number;
}): Promise<void> {
    const { invite, userId, memberLimit } = input;
    const role = invite.role as OrgRole;
    await db.transaction(async (tx) => {
        await organizationRepository.lockOrganization(invite.orgId, tx);
        const memberCount = await organizationRepository.countMembers(invite.orgId, tx);
        if (memberCount >= memberLimit) {
            throw new AppError(
                403,
                `This organization has reached its member limit (${memberLimit}). Ask an admin to upgrade the plan.`,
                true,
                "PLAN_LIMIT_EXCEEDED",
            );
        }
        await organizationRepository.addOrgMember(invite.orgId, userId, role, tx);
        await inviteRepository.deleteInvite(invite.id, tx);
        await cloudHooks.onInviteAccepted({ userId, orgId: invite.orgId, role, tx });
    });
}
