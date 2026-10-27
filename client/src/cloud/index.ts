// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
/**
 * StackRadar Cloud — everything under `src/cloud/` is source-available
 * under the StackRadar Cloud Licence (`./LICENSE`), not the AGPL. The AGPL
 * core reaches it through this barrel only, at the few seams that render a
 * cloud surface behind an `edition` check (`lib/edition.ts`):
 *
 * - billing: the Billing tab, its cards, the landing-page upgrade intent, the
 *   plan chooser a new org sees first, and what a plan row means for the shell;
 * - feedback: the sidebar's "Send feedback" dialog and the admin inbox;
 * - admin: the Chart Index tab, the operator view of the hosted chart index;
 * - terms: the terms-of-service gate;
 * - demo: the live demo's banner, hosted address and no-account entry route;
 * - the read-only toast the demo and an org whose plan ended share;
 * - attribution: the ad-click parameters a hosted sign-up carries.
 *
 * `scripts/check-cloud-boundary.mjs` keeps the importers to the list it
 * names. Nothing here is mounted in the community edition.
 */
export { BillingTab } from './billing/BillingTab';
export { UpgradeIntent } from './billing/UpgradeIntent';
export { PlanGateScreen } from './billing/PlanGate';
export { planState } from './billing/plan-state';
export { FeedbackDialog } from './feedback/FeedbackDialog';
export { FeedbackTab } from './admin/FeedbackTab';
export { ChartIndexTab } from './admin/ChartIndexTab';
export { TermsAcceptanceScreen, useTermsGate } from './terms/TermsGate';
export { PlanEndedBanner } from './billing/PlanEndedBanner';
export { DemoBanner } from './demo/DemoBanner';
export { ReadOnlyToast } from './ReadOnlyToast';
export { DEMO_URL } from './demo/hosted';
export {
    ATTRIBUTION_COOKIE,
    ATTRIBUTION_COOKIE_MAX_AGE,
    attributionFromSearchParams,
    parseAttributionCookie,
    serializeAttributionCookie,
    type Attribution,
} from './attribution/attribution';
