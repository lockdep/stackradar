import { expect, test } from '@playwright/test';
import { nginx } from '../src/api';
import { stack } from '../src/stack';

/**
 * What the scanner reported shows up where it should. global-setup.ts
 * reported one namespace, one Deployment and one container running
 * nginx:1.27-alpine, and uploaded that image's SBOM; these tests read the
 * same facts back through the UI.
 */
test('the install’s cluster is listed', async ({ page }) => {
    await page.goto('/clusters');
    await expect(page.getByRole('heading', { name: 'Clusters', level: 1 })).toBeVisible();
    // The row is a button that opens the cluster; its name is the cluster's.
    await expect(page.getByRole('button', { name: stack.clusterName, exact: true })).toBeVisible();
});

test('the reported container is listed under its namespace', async ({ page }) => {
    await page.goto('/containers');
    await expect(page.getByRole('heading', { name: 'Containers', level: 1 })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: nginx.workload }).filter({ hasText: nginx.namespace });
    await expect(row.first()).toBeVisible();
});

test('the uploaded image is listed and opens its own page', async ({ page }) => {
    await page.goto('/images');
    await expect(page.getByRole('heading', { name: 'Images', level: 1 })).toBeVisible();

    // The link's accessible name is the scan state, the ref and the registry
    // ("Scanned nginx:1.27-alpine docker.io"); the ref is the stable part. The
    // row renders the name twice, for the phone and the desktop layout, and
    // only one of the two is on screen.
    const link = page
        .getByRole('link', { name: `${nginx.repository}:${nginx.tag}` })
        .filter({ visible: true })
        .first();
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/images\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(nginx.repository);
    await expect(page.getByRole('tab', { name: /Vulnerabilities/ })).toBeVisible();
});

/**
 * Known defect, found by this suite: /images is `table-fixed` and its other
 * columns carry fixed widths that add up to 928px once the Cluster column
 * appears at the xl breakpoint, which at a 1280px viewport is the whole
 * table. The Image column, the only one without a width, gets 0px and the
 * image's name is not drawn. From about 1400px up it is fine (the project
 * runs at 1440). Enable this once the column has a minimum width.
 */
test.describe('at a 1280px viewport', () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test('the image name is visible in the images table', async ({ page }) => {
        test.fixme(true, 'the Image column of /images collapses to 0px at 1280px wide');
        await page.goto('/images');
        await expect(
            page.getByRole('link', { name: `${nginx.repository}:${nginx.tag}` }).filter({ visible: true }),
        ).toBeVisible();
    });
});

test('the cluster page sees the same container', async ({ page }) => {
    await page.goto('/clusters');
    await page.getByRole('button', { name: stack.clusterName, exact: true }).click();
    await expect(page).toHaveURL(/\/clusters\/[0-9a-f-]{36}$/);
    await page.goto(`${page.url()}/containers`);
    await expect(page.getByRole('row').filter({ hasText: nginx.workload }).first()).toBeVisible();
});

/**
 * The one test that depends on the vulnerability mirror. A fresh stack
 * bootstraps the Alpine mirror (compose.e2e.yml) in the first minutes and
 * re-matches every uploaded image when the generation goes live; this
 * waits for that, reloading the vulnerabilities list until the fixture's
 * findings are in it. Not how many: the advisories move, the fact that
 * matching ran end to end does not.
 */
test('findings for the uploaded image arrive once the mirror is live', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await page.goto('/vulnerabilities');
    await expect(page.getByRole('heading', { level: 1, name: /Vulnerabilities/ })).toBeVisible();

    await expect
        .poll(
            async () => {
                await page.reload();
                await page.getByRole('heading', { level: 1, name: /Vulnerabilities/ }).waitFor();
                return page.getByText(/CVE-\d{4}-\d+/).count();
            },
            { timeout: 9 * 60_000, intervals: [5_000, 10_000, 15_000] },
        )
        .toBeGreaterThan(0);
});
