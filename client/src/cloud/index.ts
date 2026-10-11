// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
/**
 * StackRadar Cloud — everything under `src/cloud/` is source-available
 * under the StackRadar Cloud Licence (`./LICENSE`), not the AGPL. The AGPL
 * core reaches it through this barrel only, at the few seams that render a
 * cloud surface behind an `edition` check (`lib/edition.ts`):
 *
 * - billing: the Billing tab, its cards, and the landing-page upgrade intent;
 * - feedback: the sidebar's "Send feedback" dialog and the admin inbox;
 * - admin: the Chart Index tab, the operator view of the hosted chart index;
 * - terms: the terms-of-service gate;
 * - demo: the live demo's banner, toast, hosted address and no-account entry route;
 * - attribution: the ad-click parameters a hosted sign-up carries.
 *
 * `scripts/check-cloud-boundary.mjs` keeps the importers to the list it
 * names. Nothing here is mounted in the community edition.
 */
export { BillingTab } from './billing/BillingTab';
export { UpgradeIntent } from './billing/UpgradeIntent';
export { FeedbackDialog } from './feedback/FeedbackDialog';
export { FeedbackTab } from './admin/FeedbackTab';
export { ChartIndexTab } from './admin/ChartIndexTab';
export { TermsAcceptanceScreen, useTermsGate } from './terms/TermsGate';
export { DemoBanner } from './demo/DemoBanner';
export { DemoReadOnlyToast } from './demo/DemoReadOnlyToast';
export { DEMO_URL } from './demo/hosted';
export {
    ATTRIBUTION_COOKIE,
    ATTRIBUTION_COOKIE_MAX_AGE,
    attributionFromSearchParams,
    parseAttributionCookie,
    serializeAttributionCookie,
    type Attribution,
} from './attribution/attribution';
