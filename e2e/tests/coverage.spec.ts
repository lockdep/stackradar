import { expect, test } from '@playwright/test';
import { hugeModel, privateApi } from '../src/api';
import { stack } from '../src/stack';

/**
 * The container the scanner could not pull (src/api.ts `privateApi`,
 * reported with a `registry_auth` failure and never given an SBOM): it is
 * listed as not scanned, the coverage says one of three (the too-large
 * image, `hugeModel`, is the third), and the cluster page explains that the
 * registry refused the pull.
 */
test('an unscannable container is listed as not scanned', async ({ page }) => {
    await page.goto('/containers');
    const row = page.getByRole('row').filter({ hasText: privateApi.workload }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('Not scanned');
    await expect(page.getByRole('button', { name: /^1\/3 scanned$/ })).toBeVisible();
});

test('the cluster page explains the registry failure', async ({ page }) => {
    await page.goto('/clusters');
    await page.getByRole('button', { name: stack.clusterName, exact: true }).click();
    await expect(page).toHaveURL(/\/clusters\/[0-9a-f-]{36}$/);

    const banner = page.getByRole('region', { name: 'Registry authentication failed' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(privateApi.registry);
    await expect(banner).toContainText('1 container on 1 image has no SBOM');
    // The too-large image is not a credentials problem and is not counted as one.
    await expect(banner).not.toContainText(hugeModel.workload);
    await expect(banner).not.toContainText(hugeModel.repository);
});

/**
 * The container whose image the scanner refused to unpack (src/api.ts
 * `hugeModel`, reported with an `image_too_large` failure): its row says so
 * in words, and the fix next to it is the scanner's two storage limits — not
 * the pull-Secret remediation, which is the wrong turn a "not scanned" row
 * invites.
 */
test('a too-large image is labelled as such and sent to the storage limits, not to pull Secrets', async ({ page }) => {
    await page.goto('/clusters');
    await page.getByRole('button', { name: stack.clusterName, exact: true }).click();
    await expect(page).toHaveURL(/\/clusters\/[0-9a-f-]{36}$/);

    const table = page.getByRole('table', { name: 'Containers without an SBOM' });
    const row = table.getByRole('row').filter({ hasText: hugeModel.workload });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Too large to scan');
    await expect(row).not.toContainText(/auth failed|pull secret|credential/i);

    const section = page.getByRole('region', { name: 'Too large to scan' });
    await expect(section).toBeVisible();
    await expect(section).toContainText('1 container on 1 image');
    await expect(section).toContainText('watcher.scratchSizeLimit');
    await expect(section).toContainText('watcher.resources.limits.ephemeral-storage');
    await expect(section).not.toContainText(/imagePullSecret|dockerConfigSecret|pull Secret/i);
    await expect(section.getByRole('link', { name: 'Helm values reference' })).toHaveAttribute(
        'href',
        'https://stackradar.io/docs/helm-values',
    );
});

/**
 * The questions someone evaluating the agent asks before trusting it — what
 * leaves the cluster, which ClusterRole it needs, what it costs to run — are
 * answered from the cluster page itself, as links to the docs. Named links,
 * since that is how a reader finds them; the targets are the docs site's.
 */
test('the cluster page links what the scanner sends, its permissions and its Helm values', async ({ page }) => {
    await page.goto('/clusters');
    await page.getByRole('button', { name: stack.clusterName, exact: true }).click();
    await expect(page).toHaveURL(/\/clusters\/[0-9a-f-]{36}$/);

    const about = page.getByRole('navigation', { name: 'About the scanner' });
    await expect(about.getByRole('link', { name: 'What the scanner sends' })).toHaveAttribute(
        'href',
        'https://stackradar.io/docs/architecture#data-leaving',
    );
    await expect(about.getByRole('link', { name: 'Permissions it needs' })).toHaveAttribute(
        'href',
        'https://stackradar.io/docs/architecture#permissions',
    );
    await expect(about.getByRole('link', { name: 'Helm values' })).toHaveAttribute(
        'href',
        'https://stackradar.io/docs/helm-values',
    );
});

/**
 * Known defect, found by this suite: the coverage summary treats a blocked
 * container as settled — pending = discovered − scanned − blocked − failed
 * reaches zero — and says "All 3 discovered containers scanned" directly
 * above a banner saying two of them have no SBOM. With one scanned, one
 * blocked and one too large, the summary should say so (InventoryProgress.tsx).
 */
test('the coverage summary does not call a blocked container scanned', async ({ page }) => {
    test.fixme(true, 'InventoryProgress says "All N discovered containers scanned" when the rest are blocked');
    await page.goto('/clusters');
    await page.getByRole('button', { name: stack.clusterName, exact: true }).click();
    await expect(page.getByText('All 3 discovered containers scanned')).toHaveCount(0);
    await expect(page.getByText(/1 of 3/)).toBeVisible();
});
