import { describe, it, expect } from "vitest";
import { databaseTlsProblem } from "../../../src/config/index.js";

const cloud = { isProduction: true, isCloud: true };
const community = { isProduction: true, isCloud: false };

/**
 * The production rule for the database URL's TLS (security review I6),
 * and the one relaxation the community edition gets: an explicit
 * `sslmode=prefer`, which is what the Compose quickstart and the chart's
 * bundled Postgres run on. A URL that says nothing is refused everywhere.
 */
describe("databaseTlsProblem", () => {
    it("says nothing outside production, whatever the URL", () => {
        expect(databaseTlsProblem("postgres://u:p@db/x", { isProduction: false, isCloud: true })).toBeNull();
        expect(databaseTlsProblem("postgres://u:p@db/x", { isProduction: false, isCloud: false })).toBeNull();
    });

    it.each(["require", "verify-ca", "verify-full"])("accepts sslmode=%s in both editions", (mode) => {
        const url = `postgres://u:p@db:5432/x?sslmode=${mode}`;
        expect(databaseTlsProblem(url, cloud)).toBeNull();
        expect(databaseTlsProblem(url, community)).toBeNull();
    });

    it("accepts an explicit sslmode=prefer in the community edition only", () => {
        const url = "postgres://stackradar:x@postgres:5432/stackradar?sslmode=prefer";
        expect(databaseTlsProblem(url, community)).toBeNull();
        expect(databaseTlsProblem(url, cloud)).toMatch(/sslmode=require/);
    });

    it("refuses a URL with no sslmode in both editions", () => {
        const url = "postgres://u:p@db:5432/x";
        expect(databaseTlsProblem(url, cloud)).toMatch(/must set sslmode=require/);
        expect(databaseTlsProblem(url, community)).toMatch(/must set sslmode=require/);
        // The community message names the one relaxation it has.
        expect(databaseTlsProblem(url, community)).toContain("sslmode=prefer");
    });

    it("refuses sslmode=disable, which postgres.js would still negotiate TLS on", () => {
        const url = "postgres://u:p@db:5432/x?sslmode=disable";
        expect(databaseTlsProblem(url, community)).not.toBeNull();
        expect(databaseTlsProblem(url, cloud)).not.toBeNull();
    });

    it("finds sslmode after other query parameters", () => {
        expect(databaseTlsProblem("postgres://u:p@db/x?application_name=sr&sslmode=require", cloud)).toBeNull();
    });
});
