/**
 * Which edition this deployment is — the client's mirror of the server's
 * `src/edition.ts`, computed the same way from the same variable so the
 * two pods of one install agree without a round trip. `GET /api/edition`
 * serves the server's copy for anything that wants to check.
 *
 * Read on the server side (the root layout) and handed to client
 * components through `RuntimeConfigProvider`; browser code reads
 * `useRuntimeConfig().edition`, never the env.
 *
 * Keep the `Capabilities` shape and the two tables identical to the
 * server's; `scripts/check-cloud-boundary.mjs` does not compare them, so a
 * change there is a change here in the same commit.
 */

export type Edition = 'community' | 'cloud';

export interface Capabilities {
    readonly edition: Edition;
    /** `edition === "cloud"`, for the branches that read better as a sentence. */
    readonly isCloud: boolean;
    /** More than one organisation per install, and the switcher between them. */
    readonly multiOrg: boolean;
    /** More than one cluster per organisation; "Add cluster" and key minting. */
    readonly multiCluster: boolean;
    /** `webhook`: one outbound webhook per org. `full`: email, routing, digests, per-cluster recipients. */
    readonly alerting: 'webhook' | 'full';
    /** `oidc`: local login plus generic OIDC/GitHub/Google. `enterprise`: SAML, SCIM, enforced SSO on top. */
    readonly sso: 'oidc' | 'enterprise';
    /** Stripe billing and plan limits; `false` means every limit is the community plan's. */
    readonly billing: boolean;
    /** A support channel inside the product (feedback inbox, contact address). Community uses GitHub Discussions. */
    readonly support: boolean;
}

export const ENV_VAR = 'STACKRADAR_EDITION';

const CAPABILITIES: Record<Edition, Capabilities> = {
    community: Object.freeze({
        edition: 'community',
        isCloud: false,
        multiOrg: false,
        multiCluster: false,
        alerting: 'webhook',
        sso: 'oidc',
        billing: false,
        support: false,
    }),
    cloud: Object.freeze({
        edition: 'cloud',
        isCloud: true,
        multiOrg: true,
        multiCluster: true,
        alerting: 'full',
        sso: 'enterprise',
        billing: true,
        support: true,
    }),
};

export class EditionError extends Error {
    constructor(raw: string) {
        super(`${ENV_VAR} must be "community" or "cloud" (got ${JSON.stringify(raw)}); refusing to start`);
        this.name = 'EditionError';
    }
}

/** Unset or empty means community, the two names are themselves, anything else throws. */
export function resolveEdition(raw: string | undefined): Capabilities {
    const value = (raw ?? '').trim();
    if (value === '') return CAPABILITIES.community;
    if (value === 'community' || value === 'cloud') return CAPABILITIES[value];
    throw new EditionError(raw ?? '');
}

/**
 * The deployment's edition, from the environment. Server side only — the
 * root layout reads it once per request and passes it down; a client
 * component asks `useRuntimeConfig()`.
 */
export function readEdition(): Capabilities {
    return resolveEdition(process.env[ENV_VAR]);
}
