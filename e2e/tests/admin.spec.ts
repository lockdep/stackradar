import { expect, test } from '@playwright/test';
import { stack } from '../src/stack';

/** The platform admin's tabs on a community install: build, mirror, accounts. */
test('the System tab names both builds', async ({ page }) => {
    await page.goto('/admin?tab=system');
    await expect(page.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByText('Server', { exact: true })).toBeVisible();
    await expect(panel.getByText('Client', { exact: true })).toBeVisible();
});

test('the OSV Sync tab shows the scoped mirror', async ({ page }) => {
    await page.goto('/admin?tab=osv');
    await expect(page.getByRole('tab', { name: 'OSV Sync' })).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByRole('heading', { name: 'Mirror State' })).toBeVisible();
    await expect(panel.getByText('Mirror scope')).toBeVisible();
    await expect(panel.getByText('Alpine').first()).toBeVisible();
});

test('the Users tab lists the bootstrap admin as a platform admin', async ({ page }) => {
    await page.goto('/admin?tab=users');
    await expect(page.getByRole('tab', { name: 'Users' })).toHaveAttribute('aria-selected', 'true');
    const row = page.getByRole('row').filter({ hasText: stack.admin.email });
    await expect(row).toBeVisible();
    // The signed-in admin cannot revoke itself, so its row carries the mark as an icon, not a switch.
    await expect(row.getByRole('img', { name: 'Platform admin' })).toBeVisible();
    await expect(row).toContainText('owner');
    await expect(page.getByRole('button', { name: 'New local user' })).toBeVisible();
});

test('the Jobs tab opens', async ({ page }) => {
    await page.goto('/admin?tab=jobs');
    await expect(page.getByRole('tab', { name: 'Jobs' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toBeVisible();
});
