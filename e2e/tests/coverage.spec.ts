import { expect, test } from '@playwright/test';
import { privateApi } from '../src/api';
import { stack } from '../src/stack';

/**
 * The container the scanner could not pull (src/api.ts `privateApi`,
 * reported with a `registry_auth` failure and never given an SBOM): it is
 * listed as not scanned, the coverage says one of two, and the cluster
 * page explains that the registry refused the pull.
 */
test('an unscannable container is listed as not scanned', async ({ page }) => {
    await page.goto('/containers');
    const row = page.getByRole('row').filter({ hasText: privateApi.workload }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('Not scanned');
    await expect(page.getByRole('button', { name: /^1\/2 scanned$/ })).toBeVisible();
});

test('the cluster page explains the registry failure', async ({ page }) => {
    await page.goto('/clusters');
    await page.getByRole('button', { name: stack.clusterName, exact: true }).click();
    await expect(page).toHaveURL(/\/clusters\/[0-9a-f-]{36}$/);

    const banner = page.getByRole('region', { name: 'Registry authentication failed' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(privateApi.registry);
    await expect(banner).toContainText('1 container on 1 image has no SBOM');
});

/**
 * Known defect, found by this suite: the coverage summary treats a blocked
 * container as settled — pending = discovered − scanned − blocked − failed
 * reaches zero — and says "All 2 discovered containers scanned" directly
 * above a banner saying one of them has no SBOM. With one scanned and one
 * blocked, the summary should say so (InventoryProgress.tsx).
 */
test('the coverage summary does not call a blocked container scanned', async ({ page }) => {
    test.fixme(true, 'InventoryProgress says "All N discovered containers scanned" when the rest are blocked');
    await page.goto('/clusters');
    await page.getByRole('button', { name: stack.clusterName, exact: true }).click();
    await expect(page.getByText('All 2 discovered containers scanned')).toHaveCount(0);
    await expect(page.getByText(/1 of 2/)).toBeVisible();
});
