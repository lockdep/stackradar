import { expect, test } from '@playwright/test';

/**
 * Every sidebar destination renders its page: a smoke pass over the shell.
 * Each page is reached by its link, as a user would, so a renamed route or
 * a broken link fails here rather than in a deeper test.
 */
const pages: { link: string; heading: RegExp; path: RegExp }[] = [
    { link: 'Vulnerabilities', heading: /Vulnerabilities/, path: /\/vulnerabilities$/ },
    { link: 'Packages', heading: /Packages/, path: /\/packages$/ },
    { link: 'Containers', heading: /^Containers$/, path: /\/containers$/ },
    { link: 'Images', heading: /^Images$/, path: /\/images$/ },
    { link: 'Feed', heading: /^Feed$/, path: /\/feed$/ },
    { link: 'Clusters', heading: /^Clusters$/, path: /\/clusters$/ },
];

test('the dashboard is the home page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
});

for (const { link, heading, path } of pages) {
    test(`the sidebar reaches ${link}`, async ({ page }) => {
        await page.goto('/');
        await page.getByRole('navigation').getByRole('link', { name: link, exact: true }).click();
        await expect(page).toHaveURL(path);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    });
}

test('the admin area opens for the bootstrap admin', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1, name: /Administration|Admin Dashboard/ })).toBeVisible();
});

test('the profile page names the signed-in account', async ({ page }) => {
    await page.goto('/profile');
    await expect(page.getByRole('heading', { name: 'Profile', level: 1 })).toBeVisible();
});
