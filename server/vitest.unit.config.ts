import { defineConfig } from "vitest/config";

/**
 * The unit suite alone: `tests/unit/**`, no Testcontainers. `vitest.config.ts`
 * starts a PostgreSQL container for every run, which made `pnpm test` the only
 * way to run a pure function's test and put Docker between a contributor and
 * a 50 ms assertion. Files that need the database live under
 * `tests/integration/`; `tests/setup/unit-env.ts` says what happens if one
 * slips in here.
 */
export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/unit/**/*.test.ts"],
        setupFiles: ["./tests/setup/unit-setup.ts"],
        testTimeout: 30000,
        alias: {
            "@/": new URL("./src/", import.meta.url).pathname,
        },
    },
});
