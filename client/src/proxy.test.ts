import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => auth(...args) }));

const { proxy } = await import("./proxy");

const savedDemoMode = process.env.DEMO_MODE;

beforeEach(() => {
    delete process.env.DEMO_MODE;
    auth.mockReset();
    auth.mockResolvedValue(null);
});

afterEach(() => {
    if (savedDemoMode === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = savedDemoMode;
});

const req = (path: string) => new NextRequest(`http://app.test${path}`);

describe("proxy", () => {
    it("bounces a signed-out visitor to /login with the callback", async () => {
        const res = await proxy(req("/clusters"));
        expect(res.headers.get("location")).toBe("http://app.test/login?callbackUrl=%2Fclusters");
    });

    it("answers a signed-out API call with 401 JSON rather than a redirect, in either mode", async () => {
        for (const demo of [false, true]) {
            if (demo) process.env.DEMO_MODE = "true";
            const res = await proxy(req("/api/feed/movement?days=7"));
            expect(res.status).toBe(401);
            expect(res.headers.get("location")).toBeNull();
            expect(await res.json()).toEqual({ error: "Unauthorized" });
            expect(res.headers.get("x-robots-tag")).toBe(demo ? "noindex, nofollow" : null);
        }
    });

    it("still lets the public API routes through signed out", async () => {
        for (const path of ["/api/auth/session", "/api/health/ready", "/api/invites/abc"]) {
            const res = await proxy(req(path));
            expect(res.status).toBe(200);
            expect(res.headers.get("location")).toBeNull();
        }
    });

    it("lets /demo/enter through signed out, in either mode", async () => {
        expect((await proxy(req("/demo/enter"))).headers.get("location")).toBeNull();
        process.env.DEMO_MODE = "true";
        expect((await proxy(req("/demo/enter"))).headers.get("location")).toBeNull();
    });

    it("leaves /login alone outside demo mode", async () => {
        const res = await proxy(req("/login?callbackUrl=%2Fclusters"));
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("x-robots-tag")).toBeNull();
    });

    it("sends a signed-out /login to /demo/enter in demo mode, dropping callbackUrl", async () => {
        process.env.DEMO_MODE = "true";
        const res = await proxy(req("/login?callbackUrl=%2Fclusters"));
        expect(res.headers.get("location")).toBe("http://app.test/demo/enter");
    });

    it("sends a signed-in /login to / in demo mode rather than minting another session", async () => {
        process.env.DEMO_MODE = "true";
        auth.mockResolvedValue({ user: { id: "u1" } });
        const res = await proxy(req("/login"));
        expect(res.headers.get("location")).toBe("http://app.test/");
    });

    it("adds X-Robots-Tag only in demo mode", async () => {
        auth.mockResolvedValue({ user: { id: "u1" } });
        expect((await proxy(req("/clusters"))).headers.get("x-robots-tag")).toBeNull();
        process.env.DEMO_MODE = "true";
        expect((await proxy(req("/clusters"))).headers.get("x-robots-tag")).toBe("noindex, nofollow");
        expect((await proxy(req("/nope"))).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    });

    describe("a session that must change its password", () => {
        const forced = { user: { id: "u1", isAdmin: false, mustChangePassword: true } };

        it("is redirected from every page to /account/password", async () => {
            auth.mockResolvedValue(forced);
            for (const path of ["/", "/clusters", "/profile", "/admin"]) {
                expect((await proxy(req(path))).headers.get("location")).toBe("http://app.test/account/password");
            }
        });

        it("gets 403 JSON with a code from every other API route", async () => {
            auth.mockResolvedValue(forced);
            const res = await proxy(req("/api/clusters"));
            expect(res.status).toBe(403);
            expect(await res.json()).toEqual({ error: "Password change required", code: "password_change_required" });
        });

        it("may still reach the password page, its route, sign-out and the probes", async () => {
            auth.mockResolvedValue(forced);
            for (const path of ["/account/password", "/api/account/password", "/api/auth/signout", "/api/health/ready"]) {
                const res = await proxy(req(path));
                expect(res.status).toBe(200);
                expect(res.headers.get("location")).toBeNull();
            }
        });

        it("does not gate a session whose flag is clear", async () => {
            auth.mockResolvedValue({ user: { id: "u1", isAdmin: false, mustChangePassword: false } });
            expect((await proxy(req("/clusters"))).headers.get("location")).toBeNull();
        });
    });

    it("lets /api/auth/local through signed out — it is the sign-in", async () => {
        const res = await proxy(new NextRequest("http://app.test/api/auth/local", { method: "POST" }));
        expect(res.status).toBe(200);
    });
});
