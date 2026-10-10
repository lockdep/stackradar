import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * The heartbeat body is the server's only channel to a running fleet. The
 * contract is that `{ok:true}` stays exactly that when there is nothing to
 * say — an older agent that does `JSON.stringify`-equality or a test that
 * asserts the shape must not break because a field arrived empty.
 */
describe("heartbeatResponse", () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
    });

    it("is bare {ok:true} when nothing is configured", async () => {
        vi.stubEnv("SCANNER_MIN_VERSION", "");
        vi.stubEnv("SCANNER_FLEET_MESSAGE", "");
        const { heartbeatResponse } = await import("../../../src/controllers/scanner.controller.js");
        expect(heartbeatResponse()).toEqual({ ok: true });
    });

    it("carries minScannerVersion and message when set", async () => {
        vi.stubEnv("SCANNER_MIN_VERSION", "0.2.0");
        vi.stubEnv("SCANNER_FLEET_MESSAGE", "inventory v2 retired on 2026-10-01");
        const { heartbeatResponse } = await import("../../../src/controllers/scanner.controller.js");
        expect(heartbeatResponse()).toEqual({
            ok: true,
            minScannerVersion: "0.2.0",
            message: "inventory v2 retired on 2026-10-01",
        });
    });
});
