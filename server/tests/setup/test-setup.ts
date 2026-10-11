import { beforeAll, afterAll } from "vitest";
import { exportTestEnv, setupTestDatabase, teardownTestDatabase } from "./test-db.js";

/**
 * Top level, not a hook: setup files are evaluated before the test file is
 * imported, so this lands DATABASE_URL (and friends) in the environment before
 * any `src/` module can snapshot it. See exportTestEnv for why that matters.
 */
exportTestEnv();

/**
 * Per-file setup - initializes db connection from global state
 */
beforeAll(async () => {
    await setupTestDatabase();
});

/**
 * Per-file teardown - closes db connection
 */
afterAll(async () => {
    await teardownTestDatabase();
});
