// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import Stripe from "stripe";
import { config } from "../../config/index.js";
import { AppError } from "../../middleware/error-handler.js";

export const STRIPE_API_VERSION = "2026-04-22.dahlia" as const;

/**
 * The one Stripe client. Null when `STRIPE_SECRET_KEY` is unset (a dev
 * environment without billing), in which case every billing surface fails
 * with a 500 that names the gap rather than a TypeError.
 */
const stripeClient: Stripe | null = config.stripe.secretKey
    ? new Stripe(config.stripe.secretKey, { apiVersion: STRIPE_API_VERSION })
    : null;

export function getStripe(): Stripe {
    if (!stripeClient) {
        throw new AppError(500, "Stripe is not configured");
    }
    return stripeClient;
}
