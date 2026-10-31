import { expect, test } from '@playwright/test';
import { stack } from '../src/stack';

/**
 * The cluster's settings tab: its name, and the scanner key an admin can
 * reveal — which on this stack is the quickstart's fixture key, so the
 * reveal path (encrypted copy at rest, admin-only POST) is checked end to
 * end against a known value.
 */
test('the settings tab shows the cluster name and reveals the scanner key', async ({ page }) => {
    await page.goto('/clusters');
    await page.getByRole('button', { name: stack.clusterName, exact: true }).click();
    await expect(page).toHaveURL(/\/clusters\/[0-9a-f-]{36}$/);
    await page.goto(`${page.url()}/settings`);

    await expect(page.getByRole('heading', { name: 'General', level: 3 })).toBeVisible();
    await expect(page.getByRole('textbox').first()).toHaveValue(stack.clusterName);

    await page.getByRole('button', { name: 'Reveal key' }).click();
    await expect(page.getByText(stack.scannerKey, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Hide key' }).click();
    await expect(page.getByText(stack.scannerKey, { exact: true })).toHaveCount(0);
});
