import { expect, test } from '@playwright/test';
import { stack } from '../src/stack';

/**
 * The voluntary password page, reached from the profile rather than forced.
 * A wrong current password is refused and nothing changes, so the e2e
 * password every other test signs in with stays valid.
 */
test('the password page refuses a wrong current password', async ({ page }) => {
    await page.goto('/account/password');
    await expect(page.getByRole('heading', { name: 'Change your password', level: 1 })).toBeVisible();
    await expect(page.getByText(stack.admin.email)).toBeVisible();

    await page.getByLabel('Current password').fill('definitely-not-the-current-password');
    await page.getByLabel('New password', { exact: true }).fill('another-long-enough-password');
    await page.getByLabel('New password, again').fill('another-long-enough-password');
    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.getByText(/current password|incorrect|wrong/i)).toBeVisible();
    await expect(page).toHaveURL(/\/account\/password$/);
});

test('a short new password is refused before it is sent', async ({ page }) => {
    await page.goto('/account/password');
    await page.getByLabel('Current password').fill(stack.admin.password);
    await page.getByLabel('New password', { exact: true }).fill('short');
    await page.getByLabel('New password, again').fill('short');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText(/at least 12 characters/i)).toBeVisible();
    await expect(page).toHaveURL(/\/account\/password$/);
});
