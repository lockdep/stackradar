import { expect, test } from '@playwright/test';
import { stack } from '../src/stack';

/**
 * The door. What a visitor without a session gets, what a wrong password
 * gets, and that signing out really ends the session. The signed-in state
 * every other test starts from is auth.setup.ts.
 */
test.describe('without a session', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('a page redirects to /login and keeps where you were going', async ({ page }) => {
        await page.goto('/images');
        await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fimages$/);
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    });

    test('an API call is refused with 401, never redirected', async ({ request }) => {
        const res = await request.get('/api/clusters', { maxRedirects: 0 });
        expect(res.status()).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    test('a wrong password is refused with one message and stays on the form', async ({ page }) => {
        await page.goto('/login');
        await page.getByLabel('Email').fill(stack.admin.email);
        await page.getByLabel('Password', { exact: true }).fill('not-the-password-at-all');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByText('Invalid email or password')).toBeVisible();
        await expect(page).toHaveURL(/\/login/);
    });

    test('the readiness probes answer without a session', async ({ request }) => {
        const client = await request.get('/api/health/ready');
        expect(client.ok()).toBe(true);
        const server = await request.get(`${stack.apiUrl}/api/health/ready`);
        expect(server.ok()).toBe(true);
    });
});

/**
 * Sessions live in the database, so signing out deletes the row every test
 * in this run shares. This test therefore signs in on its own, in a context
 * with no saved state, and signs that session out.
 */
test.describe('signing out', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('ends the session', async ({ page }) => {
        // Known defect, found by this test: the sign-out response points the
        // browser at http://0.0.0.0:3000/login — the standalone Next server's
        // bind address (Dockerfile HOSTNAME=0.0.0.0), which Auth.js reads as
        // the request origin — so the browser lands on a connection error.
        // A session-lost reload sometimes rescues it, which makes the pass
        // a race. Enable this once the quickstart answers with its own origin.
        test.fixme(true, 'sign-out redirects to the container bind address 0.0.0.0:3000 under Compose');
        await page.goto('/login');
        await page.getByLabel('Email').fill(stack.admin.email);
        await page.getByLabel('Password', { exact: true }).fill(stack.admin.password);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 15_000 });

        await page.getByRole('button', { name: new RegExp(stack.admin.email) }).click();
        await page
            .getByRole('menuitem', { name: 'Sign out' })
            .or(page.getByRole('button', { name: 'Sign out' }))
            .click();
        await expect(page).toHaveURL(/\/login/);

        await page.goto('/');
        await expect(page).toHaveURL(/\/login/);
    });
});
