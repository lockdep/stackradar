import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts"],
        // Global setup runs once before all tests (container creation)
        globalSetup: ["./tests/setup/global-setup.ts"],
        // Per-file setup initializes db connection
        setupFiles: ["./tests/setup/test-setup.ts"],
        // Testcontainers can take time to start
        testTimeout: 30000,
        hookTimeout: 120000,
        // Run tests sequentially to share the database container
        fileParallelism: false,
        // Ensure proper module resolution
        alias: {
            "@/": new URL("./src/", import.meta.url).pathname,
        },
    },
});
