// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import express, { type Express } from "express";
import { Cron } from "croner";
import { createLogger } from "../lib/logger.js";
import { registerCloudHooks } from "../lib/cloud-hooks.js";
import { buildCloudHooks } from "./hooks.js";
import billingRoutes from "./billing/billing.routes.js";
import { billingController } from "./billing/billing.controller.js";
import { emailController } from "./email/email.controller.js";
import feedbackRoutes, { adminFeedbackRoutes } from "./feedback/feedback.routes.js";
import termsRoutes from "./terms/terms.routes.js";
import { unsubscribeController } from "./alerting/unsubscribe.controller.js";
import { digestService } from "./alerting/digest.service.js";

const log = createLogger("cloud");

/**
 * StackRadar Cloud — everything under `src/cloud/` is source-available
 * under the StackRadar Cloud Licence (`./LICENSE`), not the AGPL, and is
 * reached from the AGPL core through exactly three calls: this file's
 * `mountCloud(app)` for the HTTP surface, `enableCloud()` for the hooks a
 * process without an HTTP server (the worker) still needs, and
 * `scheduleCloudJobs()` for the cloud's crons. `app.ts` and `worker.ts`
 * make those calls only when `edition.isCloud` (`src/edition.ts`); nothing
 * else in the core imports from here, which `scripts/check-cloud-boundary.mjs`
 * enforces.
 */

let enabled = false;

/** Register the cloud's hooks into the core (`lib/cloud-hooks.ts`). Idempotent. */
export function enableCloud(): void {
    if (enabled) return;
    registerCloudHooks(buildCloudHooks());
    enabled = true;
}

/**
 * Mount the cloud's HTTP surface. Called **before** the app's JSON parser:
 * the two webhooks verify signatures over the raw body, so they carry their
 * own `express.raw`, and the routers that take JSON carry their own
 * `express.json` (the app's parser later sees the body as already read and
 * skips). Every `/v1` path here must also be allow-listed on the hosted
 * API ingress; the `/api` paths are reached through the BFF.
 */
export function mountCloud(app: Express): void {
    enableCloud();

    const raw = express.raw({ type: "application/json" });
    // Stripe webhook — keeps org plan in sync with Stripe subscription state.
    app.post("/v1/webhooks/stripe", raw, billingController.webhook);
    // Resend (email) delivery events, on invites, digests and alert mail.
    app.post("/v1/webhooks/resend", raw, emailController.resendWebhook);

    // The weekly digest's and the alerts' unsubscribe links: no session, the
    // signed token is the credential. GET is the footer link, POST the mail
    // client's one-click button (RFC 8058).
    app.get("/v1/digest/unsubscribe", unsubscribeController.digest);
    app.post("/v1/digest/unsubscribe", unsubscribeController.digest);
    app.get("/v1/alerts/unsubscribe", unsubscribeController.alerts);
    app.post("/v1/alerts/unsubscribe", unsubscribeController.alerts);

    // The beta-price slot counter the marketing site's pricing page renders
    // (landing-page lib/beta-slots.ts). No credential: the numbers are public
    // by design, and the controller caches them so the page cannot drive
    // Stripe traffic. Deliberately NOT on the API ingress: the landing page
    // calls the server's Service in-cluster (the public host hairpins through
    // the load balancer and hangs), so the path is reachable only from inside
    // the cluster.
    app.get("/v1/pricing", billingController.pricing);

    // Checkout, portal and the in-app slot counter.
    app.use("/api/billing", express.json(), billingRoutes);
    // The sidebar's "Send feedback" and the admin inbox that reads it back.
    app.use("/api/feedback", express.json(), feedbackRoutes);
    app.use("/api/admin/feedback", adminFeedbackRoutes);
    // The terms-of-service gate.
    app.use("/api/users/terms", termsRoutes);

    log.info("Cloud edition: billing, feedback, terms and the email webhooks mounted");
}

/**
 * The cloud's crons, for the worker: the Monday weekly digest email
 * (`alerting/digest.service.ts`). The alert pass itself is the core's — it
 * runs in every edition and reaches the email channel through the hooks —
 * so it is not here. Returns the jobs so the worker can log and stop them.
 */
export function scheduleCloudJobs(opts: { digestCron: string }): Cron[] {
    enableCloud();
    const digestJob = new Cron(opts.digestCron, { name: "weekly-digest", catch: true }, async () => {
        try {
            const stats = await digestService.sendWeeklyDigests();
            log.info(stats, "Sent weekly digests");
        } catch (error) {
            log.error({ error }, "Failed to send weekly digests");
        }
    });
    return [digestJob];
}
