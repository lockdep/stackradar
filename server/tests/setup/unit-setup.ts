import { exportUnitTestEnv } from "./unit-env.js";

/**
 * Setup for `vitest.unit.config.ts`: the shared environment and nothing else.
 * No container, no connection — a unit run finishes in seconds with Docker
 * stopped. Top level, not a hook, for the reason `test-setup.ts` gives.
 */
exportUnitTestEnv();
