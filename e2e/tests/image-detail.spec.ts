import { expect, test } from '@playwright/test';
import { nginx } from '../src/api';

/** One image's page: its findings, the vulnerable components, and where it runs. */
test('the image page shows findings, components and deployments', async ({ page }) => {
    await page.goto('/images');
    await page
        .getByRole('link', { name: `${nginx.repository}:${nginx.tag}` })
        .filter({ visible: true })
        .first()
        .click();
    await expect(page).toHaveURL(/\/images\/[0-9a-f-]{36}$/);

    const vulnerabilities = page.getByRole('tab', { name: /Vulnerabilities/ });
    await expect(vulnerabilities).toHaveAttribute('aria-selected', 'true');
    await expect(
        page
            .getByRole('tabpanel')
            .getByText(/CVE-\d{4}-\d+/)
            .first(),
    ).toBeVisible();

    await page.getByRole('tab', { name: /Vulnerable components/ }).click();
    await expect(page.getByRole('tabpanel').getByRole('row').nth(1)).toBeVisible();

    await page.getByRole('tab', { name: /Deployments/ }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel).toContainText(nginx.namespace);
    await expect(panel).toContainText(nginx.workload);
});
