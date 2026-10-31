import { expect, test } from '@playwright/test';
import { stack } from '../src/stack';

/** The organisation page of a community install: one org, one member. */
test('the organization settings show the org and its one member', async ({ page }) => {
    await page.goto('/org-settings');
    await expect(page.getByRole('heading', { name: 'Organization Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('tabpanel').getByText(stack.orgName)).toBeVisible();

    await page.getByRole('tab', { name: 'Members' }).click();
    await expect(page.getByRole('table', { name: 'Members' })).toContainText(stack.admin.email);
});
