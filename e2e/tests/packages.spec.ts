import { expect, test } from '@playwright/test';
import { nginx } from '../src/api';

/** The org-wide package list: the nginx SBOM's components, searchable. */
test('the packages page lists the SBOM’s components and searches them', async ({ page }) => {
    await page.goto('/packages');
    await expect(page.getByRole('heading', { level: 1, name: /Packages/ })).toBeVisible();
    await expect(
        page.getByRole('table', { name: 'Packages across all clusters' }).getByRole('row').nth(1),
    ).toBeVisible();

    const search = page.getByPlaceholder('Search by name or purl');
    await search.fill(nginx.repository);
    await expect(page.getByRole('cell', { name: new RegExp(`^${nginx.repository}\\b`) }).first()).toBeVisible();

    await search.fill('zzz-no-such-package');
    await expect(page.getByText('No packages match “zzz-no-such-package” in any cluster.')).toBeVisible();
});
