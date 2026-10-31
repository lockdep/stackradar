import { expect, test } from '@playwright/test';
import { nginx } from '../src/api';
import { stack } from '../src/stack';

/** One running container's page, reached from the org-wide list. */
test('a container opens from the list to its page with SBOM and findings', async ({ page }) => {
    await page.goto('/containers');
    const row = page.getByRole('row').filter({ hasText: nginx.workload }).filter({ hasText: nginx.namespace }).first();
    await row.getByRole('button').first().click();

    await expect(page).toHaveURL(/\/clusters\/[0-9a-f-]{36}\/containers\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(nginx.workload);
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(stack.clusterName);

    // The findings tab counts in its name and lists vulnerable components, worst first.
    await expect(page.getByRole('tab', { name: /^Vulnerabilities [1-9]\d*$/ })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(page.getByRole('tabpanel').getByRole('row').nth(1)).toContainText(/Critical|High|Medium|Low/);

    await page.getByRole('tab', { name: 'Dependencies' }).click();
    await expect(page.getByRole('tabpanel').getByRole('row').nth(1)).toBeVisible();

    await page.getByRole('tab', { name: 'SBOM' }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
});

/**
 * The default lens. Nothing in the suite's sign-in state applies here: the
 * stored choice is cleared, so the page falls back to the organisation's
 * default, "application packages", under which the nginx image's findings —
 * all in the base image — fold behind one row that says where they are.
 */
test.describe('under the default application lens', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => window.localStorage.removeItem('sr.findings-lens'));
    });

    test('base-image findings are folded behind a notice', async ({ page }) => {
        await page.goto('/containers');
        const row = page
            .getByRole('row')
            .filter({ hasText: nginx.workload })
            .filter({ hasText: nginx.namespace })
            .first();
        await row.getByRole('button').first().click();
        await expect(page).toHaveURL(/\/containers\/[0-9a-f-]{36}$/);
        // Either the fold-away notice alone, or — once the KEV feed has landed —
        // the exploited base-image components shown despite the lens, each
        // marked as such, with the notice for the rest.
        await expect(page.getByRole('tabpanel')).toContainText(
            /Nothing in your application packages\. \d+ findings are in the base image|Base image · exploited/,
        );
    });
});
