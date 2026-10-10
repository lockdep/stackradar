import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp } from "../setup/test-app.js";

describe("Health API", () => {
    let app: Express;

    beforeAll(async () => {
        app = await getTestApp();
    });

    describe("GET /api/health/live", () => {
        it("should return 200 OK for liveness probe", async () => {
            const response = await request(app).get("/api/health/live");

            expect(response.status).toBe(200);
            expect(response.body).toEqual({ status: "ok" });
        });
    });

    describe("GET /api/health/ready", () => {
        it("should return 200 OK when database is connected", async () => {
            const response = await request(app).get("/api/health/ready");

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({
                status: "ready",
                checks: {
                    database: "ok",
                },
            });
        });
    });

    describe("GET /api/health", () => {
        it("should return legacy health check response", async () => {
            const response = await request(app).get("/api/health");

            expect(response.status).toBe(200);
            expect(response.body).toEqual({ ok: true });
        });
    });
});
