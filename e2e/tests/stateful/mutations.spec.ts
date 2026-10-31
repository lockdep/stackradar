import { expect, test } from '@playwright/test';
import { nginx, nginxDigest, privateApi, reportInventory } from '../../src/api';
import { stack } from '../../src/stack';

/**
 * Tests that change what every other test reads, so they run last and one
 * at a time (playwright.config.ts `stateful`), and each puts back what it
 * changed before it ends — a stack that stays up between local runs has
 * to look the same to the next run.
 */
// Three minutes: an inventory report may wait out the endpoint's rate limit (src/api.ts).
test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 });

test.describe('inventory reports are full-set replacements', () => {
    test.afterAll(async () => {
        await reportInventory({ nginxDigest: await nginxDigest() });
    });

    test('a container missing from the next report is no longer tracked', async ({ page }) => {
        await reportInventory({ privateApi: true });

        await page.goto('/containers');
        await expect(page.getByRole('row').filter({ hasText: privateApi.workload }).first()).toBeVisible();
        await expect(page.getByRole('row').filter({ hasText: nginx.workload })).toHaveCount(0);

        // The feed page folds an appeared-and-removed pair on one digest within
        // a day into nothing (an informer hiccup, by design), so the removal is
        // read from the API rather than the page.
        const feed = await page.request.get('/api/feed');
        expect(feed.ok()).toBe(true);
        expect(await feed.text()).toContain('container.removed');
    });

    test('reporting it again tracks it again', async ({ page }) => {
        await reportInventory({ nginxDigest: await nginxDigest() });

        await page.goto('/containers');
        await expect(page.getByRole('row').filter({ hasText: nginx.workload }).first()).toBeVisible();
        await expect(page.getByRole('button', { name: /^1\/2 scanned$/ })).toBeVisible();
    });
});

test.describe('renames', () => {
    test('the cluster can be renamed and renamed back', async ({ page }) => {
        await page.goto('/clusters');
        await page.getByRole('button', { name: stack.clusterName, exact: true }).click();
        await expect(page).toHaveURL(/\/clusters\/[0-9a-f-]{36}$/);
        const settingsUrl = `${page.url()}/settings`;
        const clusterId = page.url().split('/').pop()!;

        try {
            await page.goto(settingsUrl);
            const name = page.getByRole('textbox').first();
            await name.fill(`${stack.clusterName}-renamed`);
            await page.getByRole('button', { name: 'Save' }).click();
            await expect(page.getByText('Cluster renamed successfully.')).toBeVisible();
            await page.reload();
            await expect(page.getByRole('textbox').first()).toHaveValue(`${stack.clusterName}-renamed`);
            await expect(page.getByRole('heading', { level: 1 })).toContainText(`${stack.clusterName}-renamed`);
        } finally {
            const restored = await page.request.patch(`/api/clusters/${clusterId}`, {
                data: { name: stack.clusterName },
            });
            expect(restored.ok(), 'the cluster name was put back').toBe(true);
        }

        await page.goto('/clusters');
        await expect(page.getByRole('button', { name: stack.clusterName, exact: true })).toBeVisible();
    });

    test('the organization can be renamed and renamed back', async ({ page }) => {
        await page.goto('/org-settings');
        const renamed = `${stack.orgName} (renamed)`;
        try {
            await page.getByRole('button', { name: 'Edit', exact: true }).click();
            await page.getByPlaceholder('Organization name').fill(renamed);
            await page.getByRole('button', { name: 'Save' }).click();
            await expect(page.getByRole('tabpanel').getByText(renamed)).toBeVisible();
            await page.reload();
            await expect(page.getByRole('tabpanel').getByText(renamed)).toBeVisible();
        } finally {
            await page.goto('/org-settings');
            await page.getByRole('button', { name: 'Edit', exact: true }).click();
            await page.getByPlaceholder('Organization name').fill(stack.orgName);
            await page.getByRole('button', { name: 'Save' }).click();
            await expect(page.getByRole('tabpanel').getByText(stack.orgName, { exact: true })).toBeVisible();
        }
    });
});

test.describe('a second local account', () => {
    test('the admin creates a member from the Users tab', async ({ page }) => {
        await page.goto('/admin?tab=users');
        await page.getByRole('button', { name: 'New local user' }).click();

        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Email').fill(stack.member.email);
        await dialog.getByLabel('Initial password').fill(stack.member.initialPassword);
        await dialog.getByRole('button', { name: 'Create user' }).click();

        // A stack that has run this before already has the account: the
        // route says so, which is as good as creating it.
        const exists = dialog.getByText('A user with that email already exists.');
        await expect(page.getByRole('row').filter({ hasText: stack.member.email }).or(exists)).toBeVisible();
        if (await exists.isVisible()) await page.keyboard.press('Escape');

        await expect(page.getByRole('row').filter({ hasText: stack.member.email })).toBeVisible();
        const memberRow = page.getByRole('row').filter({ hasText: stack.member.email });
        await expect(memberRow.getByRole('img', { name: 'Platform admin' })).toHaveCount(0);
    });

    test.describe('as the member', () => {
        test.use({ storageState: { cookies: [], origins: [] } });

        test('the member signs in, replaces the handed-over password, and is not an admin', async ({ page }) => {
            await page.goto('/login');
            await page.getByLabel('Email').fill(stack.member.email);
            await page.getByLabel('Password', { exact: true }).fill(stack.member.initialPassword);
            await page.getByRole('button', { name: 'Sign in' }).click();

            const forced = page.getByRole('heading', { name: 'Choose a new password' });
            const refused = page.getByText('Invalid email or password');
            await expect(forced.or(refused)).toBeVisible({ timeout: 15_000 });

            if (await forced.isVisible()) {
                await page.getByLabel('Current password').fill(stack.member.initialPassword);
                await page.getByLabel('New password', { exact: true }).fill(stack.member.password);
                await page.getByLabel('New password, again').fill(stack.member.password);
                await page.getByRole('button', { name: 'Set password and continue' }).click();
            } else {
                await page.getByLabel('Password', { exact: true }).fill(stack.member.password);
                await page.getByRole('button', { name: 'Sign in' }).click();
            }

            await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 15_000 });
            await expect(page.getByRole('navigation', { name: 'Main' })).toContainText(stack.member.email);
            await expect(
                page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Administration' }),
            ).toHaveCount(0);

            const admin = await page.request.get('/api/admin/users');
            expect(admin.status()).toBe(403);
        });
    });
});
