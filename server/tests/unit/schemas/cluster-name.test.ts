import { describe, expect, it } from "vitest";
import { createClusterSchema, updateClusterSchema } from "../../../src/schemas/cluster.schema.js";

const parseName = (name: string) => createClusterSchema.safeParse({ name });

describe("cluster name", () => {
    it.each([
        "Production EU",
        "prod-eu-1",
        "Staging_2",
        "k8s.internal",
        "Produksjon Øst",
        "东京",
        "ab",
    ])("accepts %j", (name) => {
        expect(parseName(name).success).toBe(true);
    });

    it("trims surrounding whitespace before validating", () => {
        const result = parseName("  Production EU  ");
        expect(result.success).toBe(true);
        expect(result.data?.name).toBe("Production EU");
    });

    it.each([
        ["", "empty"],
        ["a", "one character"],
        [" a ", "one character after trim"],
        ["x".repeat(64), "longer than 63"],
        ["prod/eu", "slash"],
        ["prod:eu", "colon"],
        ["prod@eu", "at sign"],
        ["prod eu!", "exclamation"],
        ["-prod", "leading hyphen"],
        [" .prod", "leading period after trim"],
        ["prod\neu", "newline"],
        ["<script>", "angle brackets"],
    ])("rejects %j (%s)", (name) => {
        expect(parseName(name).success).toBe(false);
    });

    it("applies the same rule on rename", () => {
        expect(updateClusterSchema.safeParse({ name: "Production EU" }).success).toBe(true);
        expect(updateClusterSchema.safeParse({ name: "prod/eu" }).success).toBe(false);
        expect(updateClusterSchema.safeParse({}).success).toBe(true);
    });
});
