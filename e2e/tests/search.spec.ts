import { expect, test } from '@playwright/test';
import { nginx } from '../src/api';

/** The ⌘K palette, opened from the sidebar: a hit navigates, a miss says so. */
test('search finds the image and opens it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Search…' }).click();
    const input = page.getByRole('combobox', { name: 'Search this organization' });
    await expect(input).toBeFocused();

    await input.fill(nginx.repository);
    // Packages come first, then the image as "<registry>/<repository> <cluster>",
    // then "Search packages for …" and "Search vulnerabilities for …".
    const hit = page
        .getByRole('option')
        .filter({ hasText: `${nginx.registry}/${nginx.repository}` })
        .filter({ hasNotText: 'Search packages for' })
        .first();
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page).toHaveURL(/\/(images|clusters)\/[0-9a-f-]{36}/);
});

test('a term that matches nothing offers only the two fallback searches', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Search…' }).click();
    await page.getByRole('combobox', { name: 'Search this organization' }).fill('zzz-nothing-here');
    const options = page.getByRole('option');
    await expect(options.filter({ hasText: 'Search packages for “zzz-nothing-here”' })).toBeVisible();
    await expect(options.filter({ hasText: 'Search vulnerabilities for “zzz-nothing-here”' })).toBeVisible();
    await expect(options).toHaveCount(2);
});

/**
 * A package hit lands on the Packages page opened on that package: the list
 * narrowed to the name, the row unfolded to where it runs. The nginx SBOM
 * carries an `nginx` apk package, so the image's name is also a package hit.
 */
test('a package hit opens the Packages page on that row, unfolded', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Search…' }).click();
    await page.getByRole('combobox', { name: 'Search this organization' }).fill(nginx.repository);

    const hit = page
        .getByRole('option')
        .filter({ has: page.locator(`[title="${nginx.repository}"]`) })
        .filter({ hasNotText: `${nginx.registry}/${nginx.repository}` })
        .filter({ hasNotText: 'Search packages for' })
        .first();
    await expect(hit).toBeVisible();
    await hit.click();

    await expect(page).toHaveURL(new RegExp(`/packages\\?name=${nginx.repository}(&version=[^&]+)?$`));
    const table = page.getByRole('table', { name: 'Packages across all clusters' });
    // The whole row is the expander and carries the state (as on the vulnerability list).
    const open = table.locator('tr[aria-expanded="true"]');
    await expect(open).toHaveCount(1);
    await expect(open.getByRole('cell').nth(1)).toContainText(nginx.repository);
    await expect(page.getByRole('table', { name: /^Containers running / })).toContainText(nginx.namespace);
});
