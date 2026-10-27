import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { apiKeys, organizations, type OrgRole } from "../db/schema/index.js";
import { clusterRepository } from "../repositories/cluster.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { userRepository } from "../repositories/user.repository.js";
import { AppError } from "./error-handler.js";
import { createLogger } from "../lib/logger.js";
import { isReadMethod, readOnlyDemoError } from "../lib/demo.js";
import { orgHasActivePlan, planRequiredError } from "../lib/plan-gate.js";
import { hashApiKey } from "../lib/api-key.js";

const log = createLogger("auth");

/**
 * Authentication context added to request.
 *
 * A discriminated union on `type`, because the two credentials must not be
 * interchangeable: an API key is a *machine* credential and carries no user
 * identity. It used to impersonate its creating user (`userId = createdBy`),
 * which let a scanner key leaked from one cluster pass `requireAdminOrOwner`
 * and every role check its creator would pass. The `userId?: undefined` /
 * `apiKey?: undefined` members keep property access legal on the union while
 * making `if (req.auth?.userId)` narrow to the internal branch.
 */
interface OrgAuthContext {
    orgId: string;
    org: {
        id: string;
        name: string;
        slug: string;
        plan: string;
    };
}

export interface InternalAuthContext extends OrgAuthContext {
    type: "internal";
    userId: string;
    user: {
        id: string;
        email: string;
        name: string | null;
    };
    isAdmin: boolean;
    /**
     * The user's role in the active org, resolved from the database by
     * {@link requireOrg}. Absent until `requireOrg` has run (routes that take
     * their org from a route param instead use {@link assertAdminOrOwner}).
     */
    role?: OrgRole;
    apiKey?: undefined;
}

export interface ApiKeyAuthContext extends OrgAuthContext {
    type: "api_key";
    userId?: undefined;
    user?: undefined;
    isAdmin: false;
    apiKey: {
        id: string;
        name: string;
        scopes: string[];
        clusterId?: string;
    };
}

export type AuthContext = InternalAuthContext | ApiKeyAuthContext;

// Extend Express Request type
declare global {
    namespace Express {
        interface Request {
            auth?: AuthContext;
        }
    }
}

/** A request {@link requireAuth} has stamped: `auth` is present, not optional. */
export type AuthedRequest = Request & { auth: AuthContext };

export function isAuthed(req: Request): req is AuthedRequest {
    return req.auth !== undefined;
}

/**
 * Narrow a handler's request to one `requireAuth` has run on. Express cannot
 * carry that fact in the type from middleware to handler, so every handler
 * behind `requireAuth` asserted a non-null `req.auth` — 111 sites, each one a claim the
 * router's mount order makes true and nothing checks. This is the one place
 * the claim is checked: a handler reached without auth (a route mounted
 * without the middleware, the only way) answers 401 instead of throwing on
 * an undefined property somewhere below.
 */
export function asAuthed(req: Request): AuthedRequest {
    if (!isAuthed(req)) {
        throw new AppError(401, "Authentication required");
    }
    return req;
}

function getInternalKey(): string {
    const key = config.internalServiceKey;
    if (!key) {
        throw new Error("INTERNAL_SERVICE_KEY environment variable is required");
    }
    return key;
}

/**
 * Extract API key from X-API-Key header
 * Format: "sk_live_xxxxx"
 */
function getApiKey(req: Request): string | null {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || typeof apiKey !== "string") return null;
    return apiKey;
}

/**
 * Extract the scanner agent version from the `X-Scanner-Version` header. The
 * Helm chart injects this from `.Chart.Version` so we can surface outdated
 * scanners in the UI. The header is trusted for display purposes only — auth
 * is already established via the cluster-scoped API key.
 */
function getScannerVersion(req: Request): string | undefined {
    const raw = req.headers["x-scanner-version"];
    if (!raw || typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    // Cap length to match the `clusters.scanner_version` column (varchar 64)
    // and guard against a pathological header value blowing up the UPDATE.
    return trimmed.length > 64 ? trimmed.slice(0, 64) : trimmed;
}

/**
 * Fire-and-forget ping: updates `scanner_last_seen_at` on the cluster and, if
 * the agent reported one, `scanner_version`. Skipped for org-scoped API keys
 * (no `clusterId`) since those aren't attached to a specific cluster.
 */
function recordScannerPing(req: Request, auth: AuthContext): void {
    if (auth.type !== "api_key") return;
    const clusterId = auth.apiKey?.clusterId;
    if (!clusterId) return;
    const version = getScannerVersion(req);
    clusterRepository
        .recordScannerPing(clusterId, version)
        .catch((err) => log.error({ err, clusterId }, "Failed to record scanner ping"));
}

/**
 * Check if request is from internal Next.js service
 * Uses X-Internal-Key header with shared secret
 */
function isInternalRequest(req: Request): boolean {
    const internalKey = req.headers["x-internal-key"];
    if (!internalKey || typeof internalKey !== "string") {
        return false;
    }

    try {
        const serverKey = getInternalKey();
        // Constant-time: `===` returns at the first differing byte, which leaks
        // the prefix length of the secret one request at a time. Unequal lengths
        // are a mismatch without comparing (timingSafeEqual throws on them).
        const supplied = Buffer.from(internalKey);
        const expected = Buffer.from(serverKey);
        const matches = supplied.length === expected.length && timingSafeEqual(supplied, expected);
        if (!matches) {
            log.warn("Internal key mismatch - client and server keys don't match");
        }
        return matches;
    } catch (err) {
        log.error({ err }, "Failed to get internal service key - is INTERNAL_SERVICE_KEY set?");
        return false;
    }
}

/**
 * Decode a free-text header value sent by the BFF.
 *
 * HTTP header values must be Latin-1, so the BFF percent-encodes any header
 * that carries user-controlled text (display names, org names, emails) — see
 * `encodeHeaderValue` in client/src/lib/api-utils.ts. Falls back to the raw
 * value if it is not valid percent-encoding so that older, un-encoding
 * clients (e.g. during a rolling deploy) keep working.
 */
export function decodeHeaderValue(raw: string | string[] | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined) return undefined;
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * Extract user context from internal request headers
 * Next.js BFF passes these after validating the session
 * Note: orgId is optional - some endpoints don't require org context
 */
function getInternalUserContext(req: Request): InternalAuthContext | null {
    const userId = req.headers["x-user-id"];
    const userEmail = decodeHeaderValue(req.headers["x-user-email"]);
    const userName = decodeHeaderValue(req.headers["x-user-name"]);
    const orgId = req.headers["x-org-id"];
    const orgName = decodeHeaderValue(req.headers["x-org-name"]);
    const orgSlug = req.headers["x-org-slug"];
    const orgPlan = req.headers["x-org-plan"];

    // User ID and email are required, org context is optional
    if (!userId || !userEmail) {
        return null;
    }

    const isAdminHeader = req.headers["x-is-admin"];
    return {
        type: "internal",
        userId: String(userId),
        user: {
            id: String(userId),
            email: String(userEmail),
            name: userName ? String(userName) : null,
        },
        orgId: orgId ? String(orgId) : "",
        org: {
            id: orgId ? String(orgId) : "",
            name: orgName ? String(orgName) : "",
            slug: orgSlug ? String(orgSlug) : "",
            plan: orgPlan ? String(orgPlan) : "free",
        },
        isAdmin: isAdminHeader === "true",
    };
}

async function validateApiKey(key: string): Promise<ApiKeyAuthContext | null> {
    try {
        const keyHash = hashApiKey(key);

        // `keyPrefix` is derivable from the plaintext key and adds nothing to
        // the lookup — the SHA-256 hash is already cryptographically unique and
        // the partial unique index `api_keys_key_hash_active_unique` guarantees
        // at most one active match.
        //
        // `created_by` is deliberately NOT joined: it is audit metadata, not an
        // identity to act as. Resolving it here is what used to let a scanner key
        // inherit its creator's org role.
        const result = await db
            .select({
                apiKey: apiKeys,
                org: organizations,
            })
            .from(apiKeys)
            .innerJoin(organizations, eq(apiKeys.orgId, organizations.id))
            .where(
                and(
                    eq(apiKeys.keyHash, keyHash),
                    eq(apiKeys.isActive, true),
                    // A deleted org's keys are deactivated in the same transaction as
                    // the delete (S5), but the filter stays: a key must never resolve
                    // through a soft-deleted org, however it got here.
                    isNull(organizations.deletedAt),
                ),
            )
            .limit(1);

        const first = result[0];
        if (!first) return null;

        const { apiKey: keyRecord, org } = first;

        if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) {
            return null;
        }

        // Update last used timestamp (fire and forget)
        db.update(apiKeys)
            .set({ lastUsedAt: new Date() })
            .where(eq(apiKeys.id, keyRecord.id))
            .catch((err) => log.error({ err, apiKeyId: keyRecord.id }, "Failed to update API key last used timestamp"));

        return {
            type: "api_key",
            orgId: org.id,
            org: {
                id: org.id,
                name: org.name,
                slug: org.slug,
                plan: org.plan,
            },
            isAdmin: false,
            apiKey: {
                id: keyRecord.id,
                name: keyRecord.name,
                scopes: keyRecord.scopes,
                ...(keyRecord.clusterId ? { clusterId: keyRecord.clusterId } : {}),
            },
        };
    } catch (error) {
        log.error({ err: error }, "API key validation error");
        return null;
    }
}

/**
 * Authentication middleware
 * Supports:
 * - Internal requests from Next.js BFF (X-Internal-Key + user context headers)
 * - API key requests from CI/CD (X-API-Key)
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    (async () => {
        // Check for internal request from Next.js BFF first
        if (isInternalRequest(req)) {
            const auth = getInternalUserContext(req);
            if (auth) {
                // The demo visitor (`users.demo`) is read-only everywhere, including
                // the routes with no org context that `requireOrg` never sees —
                // creating an org, accepting an invite, feedback, terms, profile.
                // Only mutations pay the lookup; reads stay header-only. A user row
                // that does not exist yet (first login, before `POST /users/setup`)
                // is not a demo user.
                if (!isReadMethod(req.method) && (await userRepository.isDemoUser(auth.userId))) {
                    throw readOnlyDemoError();
                }
                req.auth = auth;
                return next();
            }
            throw new AppError(400, "Missing user context headers for internal request");
        }

        // Check for API key (CI/CD pipelines)
        const apiKey = getApiKey(req);
        if (apiKey) {
            const auth = await validateApiKey(apiKey);
            if (auth) {
                req.auth = auth;
                recordScannerPing(req, auth);
                return next();
            }
            throw new AppError(401, "Invalid API key");
        }

        throw new AppError(401, "Authentication required. Use X-API-Key or internal service key.");
    })().catch(next);
}

/**
 * Require the request to come from the Next.js BFF (internal auth), rejecting
 * API keys outright. This is the boundary that keeps machine credentials on
 * the scanner ingest surface: a scanner key lives as a Secret in a customer's
 * cluster, and its blast radius when leaked must be that cluster's ingest —
 * not cluster CRUD, key rotation, or the org's read surface. Every management
 * route mounts this right after requireAuth; only the `/v1` scanner endpoints
 * (and the legacy `/api/sboms/upload/cyclonedx` mount) accept API keys.
 * Use after requireAuth middleware.
 */
export function requireInternal(req: Request, _res: Response, next: NextFunction): void {
    if (!req.auth) {
        return next(new AppError(401, "Authentication required"));
    }

    if (req.auth.type !== "internal") {
        return next(new AppError(403, "This endpoint is not available to API keys"));
    }

    next();
}

/**
 * Require specific API key scope
 * Use after requireAuth middleware
 * Note: Internal requests (from Next.js) have all scopes
 */
export function requireScope(scope: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.auth) {
            return next(new AppError(401, "Authentication required"));
        }

        // Internal requests have all scopes (user already authorized via Next.js)
        if (req.auth.type === "internal") {
            return next();
        }

        // Check API key scopes
        if (req.auth.apiKey && req.auth.apiKey.scopes.includes(scope)) {
            return next();
        }

        next(new AppError(403, `Missing required scope: ${scope}`));
    };
}

/**
 * Require organization context, and prove it.
 *
 * For internal (BFF) requests the `X-Org-Id` header is a *claim* — the BFF
 * resolves the active org from a membership lookup, but this server must not
 * trust that any caller holding the internal key did (security review S3).
 * One indexed lookup per request re-verifies the membership, rejects deleted
 * orgs, stamps `req.auth.role` for downstream role checks, and replaces the
 * header-supplied org fields (`plan` above all — S16) with the database row.
 *
 * A **demo** org (`organizations.demo`) is read-only
 * for every internal request: the membership row carries the flag, so the
 * refusal costs no second query. It is `403` with code `read_only_demo` so
 * the client can say so rather than "Forbidden". An org **without a plan**
 * (`plan = 'free'` on the cloud, `lib/plan-gate.ts`) is read-only the same
 * way, `403 plan_required`, except on the routers that opted out with
 * `allowWithoutPlan` — billing and the org's own deletion.
 *
 * API-key requests already resolved their org from the key row in
 * `validateApiKey`; there is nothing further to verify here — which is also
 * what keeps the demo cluster's scanner key working: the demo reporter's
 * ingest never passes through the membership branch.
 *
 * Use after requireAuth middleware.
 */
export function requireOrg(req: Request, _res: Response, next: NextFunction): void {
    (async () => {
        if (!req.auth) {
            throw new AppError(401, "Authentication required");
        }

        if (!req.auth.orgId) {
            throw new AppError(403, "Organization setup required");
        }

        if (req.auth.type === "internal") {
            const membership = await organizationRepository.getMembership(req.auth.orgId, req.auth.userId);
            if (!membership) {
                throw new AppError(403, "Not a member of this organization");
            }
            if (membership.org.demo && !isReadMethod(req.method)) {
                throw readOnlyDemoError();
            }
            if (!orgHasActivePlan(membership.org) && !isReadMethod(req.method) && !req.allowWithoutPlan) {
                throw planRequiredError();
            }
            req.auth.role = membership.role;
            req.auth.org = {
                id: membership.org.id,
                name: membership.org.name,
                slug: membership.org.slug,
                plan: membership.org.plan,
            };
        }

        next();
    })().catch(next);
}

/**
 * Require the caller to be a platform admin. The server holds no admin flag
 * of its own: `req.auth.isAdmin` is the BFF's `x-is-admin` header, which the
 * client sets from its `auth.users.isAdmin` row behind `INTERNAL_SERVICE_KEY`
 * — so the trust boundary is that shared secret, and any caller holding it
 * can claim admin. API-key contexts are never admins. Use after requireAuth.
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
    if (!req.auth) {
        return next(new AppError(401, "Authentication required"));
    }

    if (!req.auth.isAdmin) {
        return next(new AppError(403, "Admin access required"));
    }

    next();
}

/**
 * Assert the acting user holds the `admin` or `owner` role in `orgId`,
 * returning the role. This is the single definition of that check —
 * controllers whose org comes from a route param (organizations, billing)
 * call it directly; routes whose org is the ambient `req.auth.orgId`
 * mount {@link requireAdminOrOwner} instead.
 *
 * API key contexts carry no `userId` (see {@link AuthContext}), so a scanner
 * key can never pass this check — by construction, not by convention.
 */
export async function assertAdminOrOwner(req: Request, orgId: string): Promise<OrgRole> {
    const resolvedRole = req.auth?.type === "internal" && req.auth.orgId === orgId ? req.auth.role : undefined;
    const role =
        resolvedRole ?? (req.auth?.userId ? await organizationRepository.getUserRole(orgId, req.auth.userId) : null);
    if (!role || !organizationRepository.isAdminOrOwner(role)) {
        throw new AppError(403, "Admin or owner role required");
    }
    return role;
}

/**
 * Require the acting user to be an admin or owner of the active org
 * (`req.auth.orgId`). Mount after `requireAuth` + `requireOrg` on mutations
 * of org-owned resources that the UI presents as admin functionality —
 * cluster CRUD, cluster API key rotation, chart repositories.
 * Reads stay member-accessible; do not mount this on GET routes.
 */
export function requireAdminOrOwner(req: Request, _res: Response, next: NextFunction): void {
    (async () => {
        if (!req.auth) {
            throw new AppError(401, "Authentication required");
        }
        if (!req.auth.orgId) {
            throw new AppError(403, "Organization setup required");
        }
        await assertAdminOrOwner(req, req.auth.orgId);
        next();
    })().catch(next);
}
