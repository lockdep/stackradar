import { afterEach, describe, expect, it } from "vitest";
import robots from "./robots";

const original = process.env.DEMO_MODE;

afterEach(() => {
    if (original === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = original;
});

describe("robots", () => {
    it("disallows everything for the real app", () => {
        delete process.env.DEMO_MODE;
        expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    });

    // The demo relies on noindex, which a crawler can only read if it may
    // fetch the page — a disallow here would get the host indexed as a bare
    // URL. See the comment in robots.ts.
    it("allows crawling in demo mode so the noindex is visible", () => {
        process.env.DEMO_MODE = "true";
        expect(robots()).toEqual({ rules: { userAgent: "*", allow: "/" } });
    });
});
