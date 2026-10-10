import { describe, it, expect } from "vitest";
import { resolveTopology, TopologyError } from "../../src/topology.js";

/**
 * `src/topology.ts`: one process or several. Unset follows the edition so
 * the cloud's deployments did not have to change the day the switch landed.
 */
describe("resolveTopology", () => {
    it("is monolith for the community edition and split for the cloud when unset", () => {
        for (const raw of [undefined, "", " "]) {
            expect(resolveTopology(raw, { isCloud: false })).toBe("monolith");
            expect(resolveTopology(raw, { isCloud: true })).toBe("split");
        }
    });

    it("honours an explicit value in either edition", () => {
        expect(resolveTopology("split", { isCloud: false })).toBe("split");
        expect(resolveTopology("monolith", { isCloud: true })).toBe("monolith");
    });

    it("refuses anything else rather than guessing", () => {
        for (const raw of ["Monolith", "mono", "both", "1"]) {
            expect(() => resolveTopology(raw, { isCloud: false })).toThrow(TopologyError);
        }
    });
});
