import { expect, test } from '@playwright/test';

/**
 * The home page over a seeded stack. The metric cards depend on daily
 * snapshots a fresh install has not taken yet, so the page is allowed to
 * say so; "Most critical" reads live findings and must have rows.
 */
test('the dashboard ranks the most critical vulnerabilities', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Most critical', level: 2 })).toBeVisible();

    const table = page.getByRole('table', { name: 'Most critical vulnerabilities across all clusters' });
    await expect(table).toBeVisible();
    await expect(table.getByText(/CVE-\d{4}-\d+/).first()).toBeVisible();
});

test('the trend cards are drawn, or the page says no metrics exist yet', async ({ page }) => {
    await page.goto('/');
    await expect(
        page
            .getByRole('heading', { name: 'Trends', level: 2 })
            .or(page.getByRole('heading', { name: 'No metrics yet', level: 3 })),
    ).toBeVisible();
});
