import { describe, it, expect } from "vitest";
import { ALL_LOOKUP_KEYS, lookupKey, parseLookupKey } from "../../../src/cloud/billing/stripe-prices.js";

describe("stripe price lookup keys", () => {
    it("names the eight prices of the catalog", () => {
        expect([...ALL_LOOKUP_KEYS].sort()).toEqual([
            "stackradar_pro_annual",
            "stackradar_pro_annual_standard",
            "stackradar_pro_monthly",
            "stackradar_pro_monthly_standard",
            "stackradar_team_annual",
            "stackradar_team_annual_standard",
            "stackradar_team_monthly",
            "stackradar_team_monthly_standard",
        ]);
    });

    it("round-trips through parseLookupKey", () => {
        for (const key of ALL_LOOKUP_KEYS) {
            const c = parseLookupKey(key)!;
            expect(lookupKey(c.plan, c.interval, c.book)).toBe(key);
        }
    });

    it("ignores keys that are not ours", () => {
        expect(parseLookupKey("stackradar_free_monthly")).toBeNull();
        expect(parseLookupKey("stackradar_pro_monthly_beta")).toBeNull();
        expect(parseLookupKey(null)).toBeNull();
    });
});
