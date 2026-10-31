import { expect, test } from '@playwright/test';
import { nginx } from '../src/api';

/**
 * The activity feed carries changes: the first inventory report made each
 * container "now tracked", and the first scan of the nginx image brought
 * its findings with it.
 */
test('the feed records the containers the scanner started tracking', async ({ page }) => {
    await page.goto('/feed');
    await expect(page.getByRole('heading', { name: 'Feed', level: 1 })).toBeVisible();
    await expect(page.getByText('now tracked').first()).toBeVisible();

    // The day group is a list item too, so take the entry's own <li>, not the
    // first ancestor that contains the text.
    const entry = page
        .getByText(`${nginx.namespace}/${nginx.workload} · ${nginx.container}`, { exact: true })
        .first()
        .locator('xpath=ancestor::li[1]');
    await expect(entry).toBeVisible();
    await expect(entry.getByRole('link', { name: nginx.tag })).toBeVisible();
    await expect(entry).toContainText('now tracked');
});

test('a feed entry unfolds to where the container runs and what it runs', async ({ page }) => {
    await page.goto('/feed');
    const entry = page
        .getByText(`${nginx.namespace}/${nginx.workload} · ${nginx.container}`, { exact: true })
        .first()
        .locator('xpath=ancestor::li[1]');
    await entry.getByRole('button', { name: 'Show details' }).click();
    await expect(entry.getByRole('term').filter({ hasText: 'Where' })).toBeVisible();
    await expect(entry.getByRole('definition').filter({ hasText: nginx.namespace }).first()).toContainText(
        'Deployment',
    );
    await expect(entry.getByRole('term').filter({ hasText: 'Image' })).toBeVisible();
});
