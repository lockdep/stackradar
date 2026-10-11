/**
 * Auth configuration health.
 *
 * Background: GHSA-8fpg-xm3f-6cx3 (critical, fixed in next-auth@5.0.0-beta.32).
 * Before that release, a server-side *configuration* error made `auth()` return
 * a truthy error object instead of `null`, so any `if (session)` check silently
 * failed **open**. We were never exposed — `proxy.ts` and every BFF route gate
 * on `session?.user`, which a config-error object does not have — and beta.32
 * now fails closed regardless. But the advisory's defence-in-depth advice still
 * stands: a deployment whose auth configuration is broken should never quietly
 * serve traffic.
 *
 * This module is how we enforce that. `/api/health/ready` consults it, so a pod
 * with broken auth config is pulled out of the Service instead of serving a
 * half-working sign-in.
 */

/**
 * Environment variables Auth.js needs before it can serve a single request.
 *
 * Checked lazily (on the readiness probe) rather than thrown at import time:
 * `next build` imports this module without production secrets present, so a
 * boot-time assertion would break the Docker build.
 */
import { authProviderProblems } from './auth-providers';

function missingAuthEnv(): string[] {
    const problems: string[] = [];

    // Mirrors @auth/core's own secret resolution, including the AUTH_SECRET_n
    // rotation slots and the NEXTAUTH_SECRET fallback next-auth keeps for v4
    // compatibility — a probe stricter than the library would fail deploys that
    // Auth.js is perfectly happy with.
    const hasSecret = Boolean(
        process.env.AUTH_SECRET ||
        process.env.NEXTAUTH_SECRET ||
        process.env.AUTH_SECRET_1 ||
        process.env.AUTH_SECRET_2 ||
        process.env.AUTH_SECRET_3,
    );
    if (!hasSecret) {
        problems.push('AUTH_SECRET is not set');
    }

    // Providers are registered conditionally in `auth.ts` (see
    // `lib/auth-providers.ts`): at least one must be fully configured, and a
    // provider with only half its credentials is exactly the trigger class the
    // fail-open advisory describes.
    problems.push(...authProviderProblems());

    // We self-host behind an ingress, so Auth.js cannot infer its own origin and
    // throws `UntrustedHost` on every request unless the host is trusted.
    //
    // This mirrors @auth/core/lib/utils/env.ts exactly:
    //   trustHost = AUTH_URL ?? AUTH_TRUST_HOST ?? VERCEL ?? CF_PAGES ?? NODE_ENV !== "production"
    // Any non-empty value counts (so `AUTH_TRUST_HOST=1` is as good as `=true`),
    // and development trusts the host implicitly — so in practice this only ever
    // fires on a deployed pod that is missing the variable.
    const trustsHost = Boolean(
        process.env.AUTH_URL ||
        process.env.AUTH_TRUST_HOST ||
        process.env.VERCEL ||
        process.env.CF_PAGES ||
        process.env.NODE_ENV !== 'production',
    );
    if (!trustsHost) {
        problems.push('neither AUTH_TRUST_HOST nor AUTH_URL is set');
    }

    return problems;
}

/**
 * Auth.js error types that mean "this deployment is misconfigured" — sticky
 * faults that do not heal on the next request.
 *
 * Deliberately excluded:
 *   - `UntrustedHost`: triggered by the *request's* Host header, so treating it
 *     as fatal would let anyone take a pod out of rotation with a forged Host.
 *     We cover that case with the AUTH_TRUST_HOST check above instead.
 *   - `AdapterError`: transient database trouble, already covered by the
 *     readiness probe's own DB check.
 *   - every sign-in / OAuth / CSRF / session-token error: per-request failures
 *     caused by user input, not by configuration.
 */
const CONFIGURATION_ERROR_TYPES = new Set([
    'MissingSecret',
    'MissingAdapter',
    'MissingAdapterMethods',
    'MissingAuthorize',
    'InvalidEndpoints',
    'InvalidProvider',
    'UnsupportedStrategy',
    'ExperimentalFeatureNotEnabled',
    'DuplicateConditionalUI',
]);

let recordedConfigError: string | null = null;

/**
 * Called from the Auth.js `logger.error` hook in `auth.ts`. Latches the first
 * configuration-level error so the readiness probe can report it.
 */
export function recordAuthError(error: Error): void {
    // `AuthError` carries a `type` discriminator; plain Errors do not.
    const type = (error as { type?: string }).type;
    if (!type || !CONFIGURATION_ERROR_TYPES.has(type)) return;
    recordedConfigError ??= `${type}: ${error.message}`;
}

/**
 * All currently known auth configuration problems: missing environment plus any
 * configuration error Auth.js has reported at runtime. Empty means healthy.
 */
export function getAuthConfigProblems(): string[] {
    const problems = missingAuthEnv();
    if (recordedConfigError) problems.push(recordedConfigError);
    return problems;
}
