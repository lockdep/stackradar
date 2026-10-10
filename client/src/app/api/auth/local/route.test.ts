import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashPassword } from "@/lib/password";

/**
 * The route against a mocked client database. The contract: one argon2
 * verification per attempt whatever the outcome, one `401` body for every
 * refusal, a lock after five failures, and on success the same session row
 * and cookie the demo's door writes plus where to go next.
 */

type UserRow = {
    id: string;
    passwordHash: string | null;
    failedLogins: number;
    lockedUntil: Date | null;
    mustChangePassword: boolean;
    demo: boolean;
};

const findFirst = vi.fn<() => Promise<UserRow | undefined>>();
const insertValues = vi.fn<(row: { sessionToken: string; userId: string; expires: Date }) => Promise<void>>(async () => undefined);
const updateSet = vi.fn();
const updateWhere = vi.fn(async () => undefined);
const deleteWhere = vi.fn(async () => undefined);

vi.mock("@/db", () => ({
    db: {
        query: { users: { findFirst } },
        insert: () => ({ values: insertValues }),
        update: () => ({ set: (patch: unknown) => (updateSet(patch), { where: updateWhere }) }),
        delete: () => ({ where: deleteWhere }),
    },
}));
vi.mock("@/lib/logger", () => ({
    createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const PASSWORD = "correct horse battery staple";
let HASH: string;

const localUser = (over: Partial<UserRow> = {}): UserRow => ({
    id: "11111111-1111-4111-8111-111111111111",
    passwordHash: HASH,
    failedLogins: 0,
    lockedUntil: null,
    mustChangePassword: false,
    demo: false,
    ...over,
});

function post(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest("http://app.test/api/auth/local", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
}

// The rate limiter and sweep clock are module state; a fresh module per test.
async function loadRoute() {
    vi.resetModules();
    return import("./route");
}

const envKeys = ["STACKRADAR_EDITION", "AUTH_LOCAL_ENABLED", "AUTH_URL", "NEXTAUTH_URL"] as const;
const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(async () => {
    HASH ??= await hashPassword(PASSWORD);
    for (const key of envKeys) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    findFirst.mockReset();
    insertValues.mockClear();
    updateSet.mockClear();
    updateWhere.mockClear();
    deleteWhere.mockClear();
});

afterEach(() => {
    for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
    vi.useRealTimers();
});

describe("POST /api/auth/local", () => {
    it("404s when local login is off (the cloud default), before reading anything", async () => {
        process.env.STACKRADAR_EDITION = "cloud";
        const { POST } = await loadRoute();
        const res = await POST(post({ email: "a@b.c", password: PASSWORD }));
        expect(res.status).toBe(404);
        expect(findFirst).not.toHaveBeenCalled();
    });

    it("400s a body without both fields", async () => {
        const { POST } = await loadRoute();
        expect((await POST(post({ email: "a@b.c" }))).status).toBe(400);
        expect((await POST(post({ password: "x" }))).status).toBe(400);
        expect((await POST(new NextRequest("http://app.test/api/auth/local", { method: "POST", body: "not json" }))).status).toBe(400);
        expect(findFirst).not.toHaveBeenCalled();
    });

    it("signs a local user in: session row, Auth.js cookie, redirect target", async () => {
        vi.useFakeTimers();
        const now = new Date("2026-10-10T12:00:00Z");
        vi.setSystemTime(now);
        findFirst.mockResolvedValue(localUser());
        const { POST } = await loadRoute();

        const res = await POST(post({ email: "Admin@StackRadar.local", password: PASSWORD, callbackUrl: "/clusters" }));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, redirectTo: "/clusters" });
        expect(res.headers.get("cache-control")).toBe("no-store");

        expect(insertValues).toHaveBeenCalledTimes(1);
        const row = insertValues.mock.calls[0]![0];
        expect(row.userId).toBe(localUser().id);
        expect(row.expires.getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000);
        expect(row.sessionToken.length).toBeGreaterThanOrEqual(43);

        const cookie = res.cookies.get("authjs.session-token");
        expect(cookie?.value).toBe(row.sessionToken);
        expect(cookie?.httpOnly).toBe(true);
        expect(cookie?.sameSite).toBe("lax");
        // Nothing to reset: no counter write on a clean success.
        expect(updateWhere).not.toHaveBeenCalled();
    });

    it("uses the __Secure- cookie over https, as Auth.js will expect", async () => {
        findFirst.mockResolvedValue(localUser());
        const { POST } = await loadRoute();
        const res = await POST(post({ email: "a@b.c", password: PASSWORD }, { "x-forwarded-proto": "https" }));
        expect(res.cookies.get("__Secure-authjs.session-token")?.secure).toBe(true);
        expect(res.cookies.get("authjs.session-token")).toBeUndefined();
    });

    it("sends an account that must change its password to /account/password, whatever the callback", async () => {
        findFirst.mockResolvedValue(localUser({ mustChangePassword: true }));
        const { POST } = await loadRoute();
        const res = await POST(post({ email: "a@b.c", password: PASSWORD, callbackUrl: "/clusters" }));
        expect(await res.json()).toEqual({ ok: true, redirectTo: "/account/password" });
    });

    it("refuses an open redirect in callbackUrl", async () => {
        findFirst.mockResolvedValue(localUser());
        const { POST } = await loadRoute();
        for (const bad of ["//evil.test", "https://evil.test", "clusters"]) {
            const res = await POST(post({ email: "a@b.c", password: PASSWORD, callbackUrl: bad }));
            expect((await res.json()).redirectTo).toBe("/");
        }
    });

    it("answers unknown email, provider-only account, demo account and wrong password identically", async () => {
        const { POST } = await loadRoute();
        const bodies: string[] = [];
        for (const user of [undefined, localUser({ passwordHash: null }), localUser({ demo: true }), localUser()]) {
            findFirst.mockResolvedValue(user);
            const res = await POST(post({ email: "a@b.c", password: "wrong password here" }));
            expect(res.status).toBe(401);
            expect(res.cookies.get("authjs.session-token")).toBeUndefined();
            bodies.push(await res.text());
        }
        expect(new Set(bodies).size).toBe(1);
        expect(insertValues).not.toHaveBeenCalled();
    });

    it("counts failures and locks on the fifth, resetting the counter with the lock", async () => {
        vi.useFakeTimers();
        const now = new Date("2026-10-10T12:00:00Z");
        vi.setSystemTime(now);
        const { POST } = await loadRoute();

        findFirst.mockResolvedValue(localUser({ failedLogins: 3 }));
        await POST(post({ email: "a@b.c", password: "wrong" }));
        expect(updateSet).toHaveBeenLastCalledWith({ failedLogins: 4 });

        findFirst.mockResolvedValue(localUser({ failedLogins: 4 }));
        await POST(post({ email: "a@b.c", password: "wrong" }));
        const patch = updateSet.mock.calls.at(-1)![0] as { failedLogins: number; lockedUntil: Date };
        expect(patch.failedLogins).toBe(0);
        expect(patch.lockedUntil.getTime() - now.getTime()).toBe(15 * 60 * 1000);
    });

    it("refuses a locked account even with the right password, and lets it back in once the lock lapses", async () => {
        vi.useFakeTimers();
        const now = new Date("2026-10-10T12:00:00Z");
        vi.setSystemTime(now);
        const { POST } = await loadRoute();

        findFirst.mockResolvedValue(localUser({ lockedUntil: new Date(now.getTime() + 60_000) }));
        expect((await POST(post({ email: "a@b.c", password: PASSWORD }))).status).toBe(401);
        expect(insertValues).not.toHaveBeenCalled();
        expect(updateWhere).not.toHaveBeenCalled(); // a locked attempt is not another failure

        findFirst.mockResolvedValue(localUser({ lockedUntil: new Date(now.getTime() - 1) }));
        expect((await POST(post({ email: "a@b.c", password: PASSWORD }))).status).toBe(200);
        // The stale lock and counter are cleared on the way in.
        expect(updateSet).toHaveBeenLastCalledWith({ failedLogins: 0, lockedUntil: null });
    });

    it("429s once the per-address bucket is empty, before any lookup", async () => {
        findFirst.mockResolvedValue(localUser());
        const { POST } = await loadRoute();
        for (let i = 0; i < 10; i++) {
            await POST(post({ email: "a@b.c", password: "wrong" }, { "x-forwarded-for": "198.51.100.1" }));
        }
        findFirst.mockClear();
        const limited = await POST(post({ email: "a@b.c", password: PASSWORD }, { "x-forwarded-for": "198.51.100.1" }));
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toBe("60");
        expect(findFirst).not.toHaveBeenCalled();

        expect((await POST(post({ email: "a@b.c", password: PASSWORD }, { "x-forwarded-for": "198.51.100.2" }))).status).toBe(200);
    });
});
