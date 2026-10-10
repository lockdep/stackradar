// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { z } from "zod";

/**
 * The ad-click parameters the client forwards from the login URL on
 * `POST /users/setup`. Every field is optional and bounded: the values are
 * copied verbatim from a URL the visitor could have typed, so they are
 * stored, never interpreted, and capped well under the column width.
 */
const param = z.string().trim().min(1).max(255).optional();

/**
 * The browser's own account of where it is, forwarded by the client from
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` and the request's
 * `Accept-Language`. Both are free text from the client and are stored as
 * labels, so they are bounded and limited to the characters an IANA zone
 * name (`Europe/Oslo`, `America/Argentina/Buenos_Aires`, `Etc/GMT+2`) or a
 * BCP 47 tag (`nb-NO`, `en-US`) can contain.
 */
const timezone = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_+\-\/]+$/).optional();
const locale = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9\-]+$/).optional();

export const signupAttributionSchema = z.object({
    clickId: param,
    utmSource: param,
    utmMedium: param,
    utmCampaign: param,
    utmContent: param,
    utmTerm: param,
    timezone,
    locale,
});

export type SignupAttributionBody = z.infer<typeof signupAttributionSchema>;
