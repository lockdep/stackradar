/**
 * Which edition this process is — the one switch that decides what the
 * product *is*, read once from `STACKRADAR_EDITION` and frozen.
 *
 * Two editions, one codebase, the same images:
 *
 * - **community** (the default, so the public image is safe by default):
 *   the dashboard for the cluster it runs in. One organisation, one
 *   cluster, webhook alerting, local or OIDC login, no billing. Everything
 *   under `src/cloud/` is unmounted.
 * - **cloud**: app.stackradar.io. Hosting, many clusters per dashboard,
 *   enterprise SSO, full alerting (email digests, routing), billing and
 *   support. Set explicitly on the cloud deployments.
 *
 * Every product gate reads the {@link Capabilities} object exported here —
 * `edition.multiCluster`, `edition.alerting === "full"` — never the env
 * var and never "is a Stripe key set". The optional integrations (PostHog,
 * Resend, the chart index) stay env-presence switches in
 * `config/index.ts` (`integrations`), because they are optional in *both*
 * editions and never define the product.
 *
 * Anything other than the two names refuses to boot: a typo must not
 * silently produce the community edition on the cloud, or the other way
 * round.
 */

export type Edition = "community" | "cloud";

export interface Capabilities {
    readonly edition: Edition;
    /** `edition === "cloud"`, for the branches that read better as a sentence. */
    readonly isCloud: boolean;
    /** More than one organisation per install, and the switcher between them. */
    readonly multiOrg: boolean;
    /** More than one cluster per organisation; "Add cluster" and key minting. */
    readonly multiCluster: boolean;
    /** `webhook`: one outbound webhook per org. `full`: email, routing, digests, per-cluster recipients. */
    readonly alerting: "webhook" | "full";
    /** `oidc`: local login plus generic OIDC/GitHub/Google. `enterprise`: SAML, SCIM, enforced SSO on top. */
    readonly sso: "oidc" | "enterprise";
    /** Stripe billing and plan limits; `false` means every limit is the community plan's. */
    readonly billing: boolean;
    /** A support channel inside the product (feedback inbox, contact address). Community uses GitHub Discussions. */
    readonly support: boolean;
}

export const ENV_VAR = "STACKRADAR_EDITION";

const CAPABILITIES: Record<Edition, Capabilities> = {
    community: Object.freeze({
        edition: "community",
        isCloud: false,
        multiOrg: false,
        multiCluster: false,
        alerting: "webhook",
        sso: "oidc",
        billing: false,
        support: false,
    }),
    cloud: Object.freeze({
        edition: "cloud",
        isCloud: true,
        multiOrg: true,
        multiCluster: true,
        alerting: "full",
        sso: "enterprise",
        billing: true,
        support: true,
    }),
};

export class EditionError extends Error {
    constructor(raw: string) {
        super(`${ENV_VAR} must be "community" or "cloud" (got ${JSON.stringify(raw)}); refusing to start`);
        this.name = "EditionError";
    }
}

/**
 * The pure resolver: unset or empty means community, the two names are
 * themselves, anything else throws. Exported so the mapping can be tested
 * without re-importing the module under a different environment.
 */
export function resolveEdition(raw: string | undefined): Capabilities {
    const value = (raw ?? "").trim();
    if (value === "") return CAPABILITIES.community;
    if (value === "community" || value === "cloud") return CAPABILITIES[value];
    throw new EditionError(raw ?? "");
}

/** The process's edition. Importing this module is what refuses a bad value. */
export const edition: Capabilities = resolveEdition(process.env[ENV_VAR]);
