/**
 * Which sign-in providers this deployment offers, decided by environment.
 *
 * A provider is enabled when every variable in its tuple is set. This lets
 * production ship with GitHub only and add Google later by setting two env
 * vars — no code change, no conditional in three places drifting apart —
 * and lets a self-hosted install point at its own IdP with the three
 * `AUTH_OIDC_*` variables.
 *
 * A provider with some but not all of its tuple set is a misconfiguration,
 * not a "disabled" provider: it is reported by `authProviderProblems()` so
 * the readiness probe can refuse to serve a half-configured sign-in.
 *
 * Local username/password (`lib/local-login.ts`) is not a provider in this
 * sense — it has no credentials to be half of — but it is a sign-in
 * *method*, and the "nothing configured" refusal counts it as one.
 */

import { isDemoMode } from './demo';
import { isLocalLoginEnabled } from './local-login';

export type OAuthProviderId = 'github' | 'google' | 'oidc';

const PROVIDER_ENV: Record<OAuthProviderId, readonly string[]> = {
    github: ['AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET'],
    google: ['AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET'],
    oidc: ['AUTH_OIDC_ISSUER', 'AUTH_OIDC_ID', 'AUTH_OIDC_SECRET'],
};

export function isProviderEnabled(provider: OAuthProviderId): boolean {
    return PROVIDER_ENV[provider].every((name) => Boolean(process.env[name]));
}

export function enabledProviders(): OAuthProviderId[] {
    return (Object.keys(PROVIDER_ENV) as OAuthProviderId[]).filter(isProviderEnabled);
}

/**
 * The generic OIDC provider's button label — "Continue with Keycloak",
 * "Continue with Okta" — from `AUTH_OIDC_NAME`. The fallback is what the
 * button means when the install has not said what sits behind it.
 */
export function oidcDisplayName(): string {
    return process.env.AUTH_OIDC_NAME?.trim() || 'Single sign-on';
}

/** Configuration problems for the readiness probe — empty means healthy. */
export function authProviderProblems(): string[] {
    const problems: string[] = [];
    for (const [provider, names] of Object.entries(PROVIDER_ENV)) {
        const set = names.filter((name) => Boolean(process.env[name]));
        if (set.length > 0 && set.length < names.length) {
            const missing = names.filter((name) => !process.env[name]);
            problems.push(
                `${names.join(' / ')}: only ${set.join(', ')} set (${provider} is half-configured; missing ${missing.join(', ')})`,
            );
        }
    }
    // Zero sign-in *methods* is a deployment that cannot sign anyone in, and
    // a pod that reports it never becomes Ready — which is the point.
    // Local login counts as a method; so does the live demo, whose
    // `/demo/enter` writes the session itself and
    // whose Deployment carries no provider credentials on purpose. A
    // half-configured pair is a fault in every mode.
    if (enabledProviders().length === 0 && !isLocalLoginEnabled() && !isDemoMode()) {
        problems.push(
            'no sign-in method is configured (set AUTH_LOCAL_ENABLED=true, or AUTH_OIDC_* / AUTH_GITHUB_* / AUTH_GOOGLE_*)',
        );
    }
    return problems;
}

/**
 * Group-to-admin mapping for the generic OIDC provider: with
 * `AUTH_OIDC_ADMIN_GROUP` set, a user whose groups claim contains that
 * value is a platform admin and one whose claim does not is not — on every
 * sign-in, so removing someone from the group in the IdP removes the role
 * here at their next login. Unset, the answer is `undefined` and the
 * column is left alone: admins are then managed in StackRadar only.
 *
 * The claim is `groups` unless `AUTH_OIDC_GROUPS_CLAIM` names another, and
 * may arrive as an array or a single string (Entra ID sends arrays; some
 * Keycloak mappers send one value). Read from the ID token and userinfo
 * merged, which is what Auth.js hands the `profile` callback.
 */
export function oidcAdminFromProfile(profile: Record<string, unknown>): boolean | undefined {
    const group = process.env.AUTH_OIDC_ADMIN_GROUP?.trim();
    if (!group) return undefined;
    const claim = process.env.AUTH_OIDC_GROUPS_CLAIM?.trim() || 'groups';
    const value = profile[claim];
    const groups = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    return groups.some((g) => typeof g === 'string' && g === group);
}
