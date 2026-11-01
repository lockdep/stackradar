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

/**
 * A row is the answer to "where is this package": a click unfolds it to the
 * images carrying it and the containers running them. Every library of the
 * nginx SBOM is in the nginx image, which runs as one Deployment, so any
 * row's panel names that image and its namespace.
 */
test('a package row unfolds to the image carrying it and the namespace running it', async ({ page }) => {
    await page.goto('/packages');
    const table = page.getByRole('table', { name: 'Packages across all clusters' });
    const firstRow = table.getByRole('row').nth(1);
    await expect(firstRow).toHaveAttribute('aria-expanded', 'false');

    await firstRow.click();
    await expect(firstRow).toHaveAttribute('aria-expanded', 'true');

    const images = page.getByRole('table', { name: /^Images carrying / });
    await expect(images.getByRole('link', { name: new RegExp(`${nginx.registry}/${nginx.repository}`) })).toBeVisible();
    const containers = page.getByRole('table', { name: /^Containers running / });
    await expect(containers.getByRole('link', { name: nginx.workload })).toBeVisible();
    await expect(containers).toContainText(nginx.namespace);

    // The row is an incident entry point, so the list leads with what has
    // findings rather than with the alphabet: the first row carries at
    // least one finding (the nginx image has them once the Alpine mirror is
    // live — `vulnerabilities.spec.ts` rests on the same fact), where a
    // name-sorted list would open on `alpine-baselayout`.
    await expect(firstRow.getByRole('img', { name: /^[1-9]\d* (critical|high|medium|low)/i })).not.toHaveCount(0);
});
