import { describe, it, expect } from "vitest";
import {
    BootstrapClusterError,
    BOOTSTRAP_CLUSTER_API_KEY_VAR,
    BOOTSTRAP_CLUSTER_ID_VAR,
    readBootstrapCluster,
} from "../../../src/lib/bootstrap-cluster.js";

/**
 * The community edition's scanner credential from the environment: both of
 * the pair or neither, the same rule `authProviderProblems()` applies to a half-set
 * OAuth pair.
 */
describe("readBootstrapCluster", () => {
    const id = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
    const key = "abcdefghijklmnopqrstuvwxyz012345";

    it("is null when neither variable is set", () => {
        expect(readBootstrapCluster({})).toBeNull();
        expect(
            readBootstrapCluster({ [BOOTSTRAP_CLUSTER_ID_VAR]: "", [BOOTSTRAP_CLUSTER_API_KEY_VAR]: "  " }),
        ).toBeNull();
    });

    it("returns the pair, trimmed, with the id lower-cased", () => {
        expect(
            readBootstrapCluster({
                [BOOTSTRAP_CLUSTER_ID_VAR]: ` ${id.toUpperCase()} `,
                [BOOTSTRAP_CLUSTER_API_KEY_VAR]: ` ${key} `,
            }),
        ).toEqual({ clusterId: id, apiKey: key });
    });

    it("refuses exactly one of the pair", () => {
        expect(() => readBootstrapCluster({ [BOOTSTRAP_CLUSTER_ID_VAR]: id })).toThrow(BootstrapClusterError);
        expect(() => readBootstrapCluster({ [BOOTSTRAP_CLUSTER_API_KEY_VAR]: key })).toThrow(/only one of the pair/);
    });

    it("refuses a cluster id that is not a UUID", () => {
        expect(() =>
            readBootstrapCluster({ [BOOTSTRAP_CLUSTER_ID_VAR]: "local", [BOOTSTRAP_CLUSTER_API_KEY_VAR]: key }),
        ).toThrow(/UUID/);
    });

    it("refuses a key that is too short or contains whitespace", () => {
        expect(() =>
            readBootstrapCluster({ [BOOTSTRAP_CLUSTER_ID_VAR]: id, [BOOTSTRAP_CLUSTER_API_KEY_VAR]: "short" }),
        ).toThrow(/at least/);
        expect(() =>
            readBootstrapCluster({
                [BOOTSTRAP_CLUSTER_ID_VAR]: id,
                [BOOTSTRAP_CLUSTER_API_KEY_VAR]: "has a space in it yes",
            }),
        ).toThrow(/whitespace/);
    });

    it("never puts the key in the error message", () => {
        try {
            readBootstrapCluster({ [BOOTSTRAP_CLUSTER_ID_VAR]: "nope", [BOOTSTRAP_CLUSTER_API_KEY_VAR]: key });
            expect.unreachable();
        } catch (error) {
            expect((error as Error).message).not.toContain(key);
        }
    });
});
