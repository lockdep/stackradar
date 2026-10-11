// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
/**
 * The version of the Terms of Service the service currently requires, as the
 * ISO form of the terms' effective date.
 *
 * > [!IMPORTANT]
 * > Kept in lockstep with the marketing site's `legal.ts` (`termsVersion` /
 * > `effectiveDate`), which renders the document this constant refers to.
 * > Bump both together, and only for **material** changes — bumping here is
 * > what makes every existing user re-accept in the dashboard, so a typo fix
 * > must not touch it.
 *
 * Acceptances are recorded per user per version in `terms_acceptances`; a
 * user whose latest accepted version is not this one is shown the acceptance
 * screen on next dashboard load.
 */
export const CURRENT_TERMS_VERSION = "2026-08-20";
