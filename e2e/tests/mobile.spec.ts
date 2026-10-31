import { expect, test } from '@playwright/test';
import { stack } from '../src/stack';

/** A phone: the shell collapses into a drawer and no page scrolls sideways. */
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function overflowsSideways(page: import('@playwright/test').Page): Promise<boolean> {
    return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

test('the dashboard fits a phone and the drawer reaches the images page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    expect(await overflowsSideways(page)).toBe(false);

    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Images', exact: true }).click();
    await expect(page).toHaveURL(/\/images$/);
    await expect(page.getByRole('heading', { name: 'Images', level: 1 })).toBeVisible();
    expect(await overflowsSideways(page)).toBe(false);
});

test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('the login page fits a phone', async ({ page }) => {
        await page.goto('/login');
        await expect(page.getByLabel('Email')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
        expect(await overflowsSideways(page)).toBe(false);
        await expect(page.getByText(stack.admin.email)).toHaveCount(0);
    });
});
