import { NextResponse, type NextRequest } from "next/server";
import type { Session } from "next-auth";
import { ACTIVE_ORG_COOKIE } from "./constants";
import { createLogger } from "./logger";

const log = createLogger("api-utils");

/**
 * Get the Express API base URL
 */
export function getExpressUrl(): string {
  return process.env.EXPRESS_API_URL || "http://localhost:8080";
}

/**
 * Get the internal service key for BFF -> Express communication
 */
function getInternalKey(): string {
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (!key) {
    throw new Error("INTERNAL_SERVICE_KEY environment variable is required");
  }
  return key;
}

/**
 * Encode a free-text value for use in an HTTP header.
 *
 * Header values must be Latin-1; `new Headers()` throws
 * "Cannot convert argument to a ByteString" for anything above U+00FF, which
 * turned every API call into a 500 for users with e.g. Arabic display names.
 * Every header carrying user-controlled text (names, org names, emails) MUST
 * go through this. The server decodes with `decodeHeaderValue` in
 * server/src/middleware/auth.ts.
 */
export function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Base headers for every BFF -> Express call: service key + user identity.
 */
function baseInternalHeaders(session: Session): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Key": getInternalKey(),
    "X-User-Id": session.user.id,
    "X-User-Email": encodeHeaderValue(session.user.email || ""),
  };
  if (session.user.name) {
    headers["X-User-Name"] = encodeHeaderValue(session.user.name);
  }
  return headers;
}

interface ServerOrg {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role?: string;
}

/**
 * In-flight cache of the user's org list to avoid hammering Express on
 * concurrent BFF route calls within the same request lifecycle. Keyed by
 * userId. Entries are short-lived (cleared on resolve/reject) so they only
 * coalesce concurrent inflight requests, not subsequent ones.
 */
const inflightOrgFetches = new Map<string, Promise<ServerOrg[]>>();

async function fetchUserOrgs(session: Session): Promise<ServerOrg[]> {
  const userId = session.user.id;
  const existing = inflightOrgFetches.get(userId);
  if (existing) return existing;

  const promise = (async (): Promise<ServerOrg[]> => {
    const headers = baseInternalHeaders(session);

    const response = await fetch(`${getExpressUrl()}/api/users/organizations`, {
      method: "GET",
      headers,
      cache: "no-store",
    });

    if (!response.ok) {
      log.warn(
        { status: response.status, userId },
        "Failed to fetch user organizations from Express",
      );
      return [];
    }

    const data = (await response.json()) as { organizations?: ServerOrg[] };
    return data.organizations ?? [];
  })();

  inflightOrgFetches.set(userId, promise);
  try {
    return await promise;
  } finally {
    inflightOrgFetches.delete(userId);
  }
}

/**
 * Resolve the active organization for the current request.
 *
 * Strategy:
 *   1. If the browser sent an `sr_org_id` cookie AND the user is a member
 *      of that org, use it (supports the multi-org switcher in the UI).
 *   2. Otherwise fall back to the user's first organization.
 *   3. Returns `null` if the user has no organizations yet — the
 *      organization-setup flow handles that case via `/api/users/setup`.
 */
async function resolveActiveOrg(
  session: Session,
  request?: NextRequest,
): Promise<ServerOrg | null> {
  const orgs = await fetchUserOrgs(session);
  if (orgs.length === 0) return null;

  const cookieOrgId = request?.cookies.get(ACTIVE_ORG_COOKIE)?.value;
  if (cookieOrgId) {
    const match = orgs.find((o) => o.id === cookieOrgId);
    if (match) return match;
  }

  return orgs[0]!;
}

/**
 * Create headers for internal API calls to Express
 * Includes the internal service key, user context, and active organization.
 *
 * The active org is resolved from the `sr_org_id` cookie (validated against
 * the user's memberships) or the user's first org. Pass the `NextRequest`
 * so that the cookie can be read; without it the user's first org is used.
 */
export async function createApiHeaders(
  session: Session,
  request?: NextRequest,
): Promise<Record<string, string>> {
  const headers = baseInternalHeaders(session);

  if (session.user.isAdmin) {
    headers["X-Is-Admin"] = "true";
  }

  const org = await resolveActiveOrg(session, request);
  if (org) {
    headers["X-Org-Id"] = org.id;
    headers["X-Org-Name"] = encodeHeaderValue(org.name);
    headers["X-Org-Slug"] = org.slug;
    headers["X-Org-Plan"] = org.plan;
  }

  return headers;
}

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Get or generate a request ID from a NextRequest
 */
export function getRequestId(request?: NextRequest): string {
  return request?.headers.get("x-request-id") || generateRequestId();
}

/**
 * Handle API errors and return appropriate response
 */
export function handleApiError(error: unknown, reqId?: string): NextResponse {
  log.error({ err: error, reqId }, "API proxy error");
  
  if (error instanceof Error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
  
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}
