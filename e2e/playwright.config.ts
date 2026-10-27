import { defineConfig, devices } from '@playwright/test';
import { adminStorageState, stack } from './src/stack';

/**
 * End-to-end tests over the real product: the Compose quickstart built from
 * this checkout (e2e/compose.e2e.yml), seeded through the scanner API, driven
 * through a browser. global-setup.ts starts and seeds the stack; the `setup`
 * project signs in once and every other project starts from its cookie.
 *
 * Chromium only: the suite checks the product, not browser compatibility,
 * and one browser keeps the CI job within a few minutes of the build.
 */
export default defineConfig({
    testDir: './tests',
    globalSetup: './src/global-setup.ts',
    globalTeardown: './src/global-teardown.ts',
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : undefined,
    reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
    timeout: 30_000,
    expect: { timeout: 10_000 },
    use: {
        baseURL: stack.baseUrl,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'off',
    },
    projects: [
        {
            name: 'setup',
            testDir: './src',
            testMatch: /auth\.setup\.ts/,
        },
        {
            name: 'chromium',
            // 1440×900 rather than Desktop Chrome's 1280×720: at exactly 1280 the
            // images table's fixed columns leave the Image column no width (a
            // defect inventory.spec.ts records); a 15" laptop is the common case.
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1440, height: 900 },
                storageState: adminStorageState,
            },
            dependencies: ['setup'],
        },
    ],
});
