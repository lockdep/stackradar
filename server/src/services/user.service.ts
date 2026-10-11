/**
 * First-login side effects that span repositories. See
 * `organization.service.ts` for why the transaction lives here and not in
 * the controller.
 */

import { db } from "../db/index.js";
import { organizationRepository } from "../repositories/index.js";
import type { OrgRole } from "../db/schema/index.js";

/**
 * The community edition's single-organisation rule: the first account to
 * sign in owns the default organisation, every later account joins it as a
 * member. The org row lock is what makes "first" well-defined — two first
 * logins at once must not both find "no owner".
 */
export async function joinDefaultOrganization(orgId: string, userId: string): Promise<OrgRole> {
    return db.transaction(async (tx) => {
        await organizationRepository.lockOrganization(orgId, tx);
        const role: OrgRole = (await organizationRepository.hasOwner(orgId, tx)) ? "member" : "owner";
        await organizationRepository.addOrgMember(orgId, userId, role, tx);
        return role;
    });
}
