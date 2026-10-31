import { expect, test } from '@playwright/test';
import { nginx } from '../src/api';

/**
 * The org-wide advisory list and one advisory's page: what the matcher
 * found in the nginx SBOM, opened the way a user drills in.
 */
test('an advisory opens from the list to its own page', async ({ page }) => {
    await page.goto('/vulnerabilities');
    await expect(page.getByRole('heading', { level: 1, name: /Vulnerabilities/ })).toBeVisible();

    const firstId = await page
        .getByText(/^CVE-\d{4}-\d+$/)
        .first()
        .textContent();
    expect(firstId).toMatch(/^CVE-/);

    // The whole row is the expander; its own button is aria-hidden.
    await page.getByRole('row').filter({ hasText: firstId! }).first().click();
    await page.getByRole('link', { name: 'Open full page' }).click();

    await expect(page).toHaveURL(new RegExp(`/vulnerabilities/${firstId}$`));
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(firstId!);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(firstId!);
    // The page draws the table twice (phone and desktop layout); either carries the image.
    await expect(page.getByRole('table', { name: `Images affected by ${firstId}` }).first()).toContainText(
        nginx.repository,
    );
});

test('the search box narrows the list and says when nothing matches', async ({ page }) => {
    await page.goto('/vulnerabilities');
    const firstId = (await page
        .getByText(/^CVE-\d{4}-\d+$/)
        .first()
        .textContent())!;

    const search = page.getByPlaceholder('Search by advisory or package');
    await search.fill(firstId);
    await expect(page.getByText(firstId, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/^CVE-\d{4}-\d+$/).filter({ hasNotText: firstId })).toHaveCount(0);

    await search.fill('CVE-1999-000000');
    await expect(page.getByText('No vulnerabilities match the current filter in any cluster.')).toBeVisible();
});
