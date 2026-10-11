import type { Express } from "express";

let appInstance: Express | null = null;

/**
 * Get the Express app instance for testing
 * The app is lazily loaded after database setup to ensure
 * environment variables are set correctly
 */
export async function getTestApp(): Promise<Express> {
    if (!appInstance) {
        // Dynamic import to ensure DATABASE_URL is set first
        const { default: app } = await import("../../src/app.js");
        appInstance = app;
    }
    return appInstance;
}

/**
 * Create headers for internal service authentication
 * Simulates requests from the Next.js BFF
 */
export function createInternalHeaders(user: {
    id: string;
    email: string;
    name?: string;
    orgId?: string;
    orgName?: string;
    orgSlug?: string;
    orgPlan?: string;
    /** Platform admin. The BFF sets this from the session; `requireAdmin` reads it. */
    isAdmin?: boolean;
}): Record<string, string> {
    const headers: Record<string, string> = {
        "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "test-internal-key-12345",
        "X-User-Id": user.id,
        "X-User-Email": encodeURIComponent(user.email),
    };

    if (user.name) {
        headers["X-User-Name"] = encodeURIComponent(user.name);
    }

    if (user.isAdmin) {
        headers["X-Is-Admin"] = "true";
    }

    if (user.orgId) {
        headers["X-Org-Id"] = user.orgId;
        headers["X-Org-Name"] = encodeURIComponent(user.orgName || "Test Org");
        headers["X-Org-Slug"] = user.orgSlug || "test-org";
        headers["X-Org-Plan"] = user.orgPlan || "free";
    }

    return headers;
}

/**
 * Create headers for API key authentication
 * Simulates requests from CI/CD pipelines
 */
export function createApiKeyHeaders(apiKey: string): Record<string, string> {
    return {
        "X-API-Key": apiKey,
    };
}
