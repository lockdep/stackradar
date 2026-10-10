// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
/**
 * StackRadar Cloud — everything under `src/cloud/` is source-available
 * under the StackRadar Cloud Licence (`./LICENSE`), not the AGPL. The AGPL
 * core reaches it through this barrel only, at the few seams that render a
 * cloud surface behind an `edition` check (`lib/edition.ts`):
 *
 * - billing: the Billing tab, its cards, and the landing-page upgrade intent;
 * - feedback: the sidebar's "Send feedback" dialog and the admin inbox;
 * - terms: the terms-of-service gate;
 * - demo: the live demo's banner, toast and no-account entry route.
 *
 * `scripts/check-cloud-boundary.mjs` keeps the importers to the list it
 * names. Nothing here is mounted in the community edition.
 */
export { BillingTab } from './billing/BillingTab'
export { UpgradeIntent } from './billing/UpgradeIntent'
export { FeedbackDialog } from './feedback/FeedbackDialog'
export { FeedbackTab } from './admin/FeedbackTab'
export { TermsAcceptanceScreen, useTermsGate } from './terms/TermsGate'
export { DemoBanner } from './demo/DemoBanner'
export { DemoReadOnlyToast } from './demo/DemoReadOnlyToast'
