import { expect, test as setup } from '@playwright/test';
import { adminStorageState, stack } from './stack';

/**
 * The first sign-in, as a test the other projects depend on.
 *
 * A fresh stack has the bootstrap admin with the fixture password and
 * `must_change_password` set: signing in lands on /account/password and
 * nothing else is reachable until a new password is chosen. A stack that
 * has already run this suite has the admin on the e2e password. Both paths
 * end signed in on the dashboard, and the browser state is saved for every
 * other test to start from.
 */
setup('the bootstrap admin signs in, changing the fixture password when asked', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(stack.admin.email);
    await page.getByLabel('Password', { exact: true }).fill(stack.admin.bootstrapPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();

    const refused = page.getByText('Sign-in failed', { exact: false }).or(page.getByText('Invalid', { exact: false }));
    await expect(page.getByRole('heading', { name: 'Choose a new password' }).or(refused)).toBeVisible({
        timeout: 15_000,
    });

    if (await page.getByRole('heading', { name: 'Choose a new password' }).isVisible()) {
        // Fresh stack: the forced change. Until it is done, the app is off limits.
        await page.goto('/');
        await expect(page).toHaveURL(/\/account\/password$/);
        await page.getByLabel('Current password').fill(stack.admin.bootstrapPassword);
        await page.getByLabel('New password', { exact: true }).fill(stack.admin.password);
        await page.getByLabel('New password, again').fill(stack.admin.password);
        await page.getByRole('button', { name: 'Set password and continue' }).click();
    } else {
        // Seen stack: the fixture password is gone; sign in with the one this suite set.
        await page.getByLabel('Password', { exact: true }).fill(stack.admin.password);
        await page.getByRole('button', { name: 'Sign in' }).click();
    }

    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await page.context().storageState({ path: adminStorageState });
});
