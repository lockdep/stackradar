import { describe, it, expect } from "vitest";
import {
    INVENTORY_VERSION,
    SUPPORTED_INVENTORY_VERSIONS,
    isSupportedInventoryVersion,
} from "../../../src/schemas/inventory.schema.js";

/**
 * Accepting a *set* of versions is what keeps a v(N) fleet reporting the day
 * v(N+1) ships. The current version must always be in the set; a version
 * outside it is rejected by type as well as by value.
 */
describe("inventory version acceptance", () => {
    it("includes the current version", () => {
        expect(SUPPORTED_INVENTORY_VERSIONS).toContain(INVENTORY_VERSION);
        expect(isSupportedInventoryVersion(INVENTORY_VERSION)).toBe(true);
    });

    it("rejects unknown and mistyped versions", () => {
        expect(isSupportedInventoryVersion(INVENTORY_VERSION + 100)).toBe(false);
        expect(isSupportedInventoryVersion(String(INVENTORY_VERSION))).toBe(false);
        expect(isSupportedInventoryVersion(undefined)).toBe(false);
    });
});
