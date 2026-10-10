import { lt } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { createLogger } from "./logger";

/**
 * Signing a user in without an OAuth round trip: write the Auth.js
 * `sessions` row ourselves and set the cookie Auth.js will read it back
 * from. Everything after that is an ordinary database session — sliding
 * window, server-side revocation, the `session` callback — so the cloud's
 * session model does not change by having a second way to mint one.
 *
 * First written for the live demo (`cloud/demo/enter.ts`, 2026-09-08);
 * local username/password sign-in (`api/auth/local`, step 04) reuses it.
 * Both callers decide *who* and *for how long*; this module only knows how.
 */

const log = createLogger("local-session");

/**
 * Whether Auth.js will expect the `__Secure-` cookie. Mirrors
 * `@auth/core`'s `useSecureCookies ?? url.protocol === "https:"`, where the
 * url is `AUTH_URL` when set and otherwise built from `x-forwarded-proto`
 * (`createActionURL` in next-auth's `lib/env.js`). Confirmed against
 * next-auth 5.0.0-beta.32 / @auth/core 0.41.3: the session cookie is
 * `__Secure-authjs.session-token` on https and `authjs.session-token` else.
 */
export function usesSecureCookies(request: NextRequest): boolean {
    const configured = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
    if (configured) {
        try {
            return new URL(configured).protocol === "https:";
        } catch {
            /* fall through to the request */
        }
    }
    const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol;
    return proto.replace(/:$/, "") === "https";
}

/** The session cookie's name for this request, by the rule above. */
export function sessionCookieName(request: NextRequest): string {
    return `${usesSecureCookies(request) ? "__Secure-" : ""}authjs.session-token`;
}

/**
 * The address a per-IP limiter keys on. `X-Forwarded-For` is set by
 * ingress-nginx, which is the only way traffic reaches a deployed pod; a
 * local `next dev` has neither header and shares one bucket.
 */
export function clientIp(request: NextRequest): string {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim();
    return request.headers.get("x-real-ip") ?? "unknown";
}

export interface IssuedSession {
    sessionToken: string;
    expires: Date;
}

/** One `sessions` row: 32 random bytes, base64url, as Auth.js itself mints. */
export async function issueSession(userId: string, maxAgeSeconds: number, now = Date.now()): Promise<IssuedSession> {
    const sessionToken = randomBytes(32).toString("base64url");
    const expires = new Date(now + maxAgeSeconds * 1000);
    await db.insert(sessions).values({ sessionToken, userId, expires });
    return { sessionToken, expires };
}

/** Attach an issued session to a response as the cookie Auth.js reads. */
export function setSessionCookie(response: NextResponse, request: NextRequest, session: IssuedSession): void {
    const secure = usesSecureCookies(request);
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set({
        name: `${secure ? "__Secure-" : ""}authjs.session-token`,
        value: session.sessionToken,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure,
        expires: session.expires,
    });
}

/**
 * Auth.js never deletes expired session rows, and every sign-in here is a
 * row. Sweeping on issue keeps the cleanup with the thing that makes the
 * mess; at most once an hour so a burst of sign-ins is not a burst of
 * `DELETE`s. Past `expires + 1 day`, not `expires`: a just-expired row is
 * harmless and this keeps the sweep clear of any session being read.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastSweepAt = 0;

export function sweepExpiredSessions(now: number): void {
    if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = now;
    const cutoff = new Date(now - 24 * 60 * 60 * 1000);
    void db
        .delete(sessions)
        .where(lt(sessions.expires, cutoff))
        .catch((err: unknown) => log.warn({ err }, "expired-session sweep failed"));
}
