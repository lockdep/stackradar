import { describe, it, expect } from "vitest";
import { resolveEdition, EditionError } from "../../../src/edition.js";

/**
 * `src/edition.ts`: the one switch, read once. The mapping from the env
 * value to the capabilities object is what every product gate rests on.
 */
describe("resolveEdition", () => {
    it("is the community edition when unset or empty", () => {
        for (const raw of [undefined, "", "  "]) {
            const caps = resolveEdition(raw);
            expect(caps.edition).toBe("community");
            expect(caps.isCloud).toBe(false);
        }
    });

    it("gives the community edition one org, one cluster, webhook alerts and no billing", () => {
        expect(resolveEdition("community")).toEqual({
            edition: "community",
            isCloud: false,
            multiOrg: false,
            multiCluster: false,
            alerting: "webhook",
            sso: "oidc",
            billing: false,
            support: false,
        });
    });

    it("gives the cloud everything", () => {
        expect(resolveEdition("cloud")).toEqual({
            edition: "cloud",
            isCloud: true,
            multiOrg: true,
            multiCluster: true,
            alerting: "full",
            sso: "enterprise",
            billing: true,
            support: true,
        });
    });

    it("refuses anything else rather than guessing", () => {
        for (const raw of ["Cloud", "enterprise", "community edition", "true"]) {
            expect(() => resolveEdition(raw)).toThrow(EditionError);
        }
    });

    it("hands out frozen objects", () => {
        const caps = resolveEdition("cloud");
        expect(Object.isFrozen(caps)).toBe(true);
    });
});
