import { expect, test } from '@playwright/test';
import { nginx } from '../src/api';

/**
 * The home page over a seeded stack. The metric cards depend on daily
 * snapshots a fresh install has not taken yet, so the page is allowed to
 * say so; "Most critical" reads live findings and must have rows.
 */
test('the dashboard ranks the most critical vulnerabilities', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Most critical', level: 2 })).toBeVisible();

    const table = page.getByRole('table', { name: 'Most critical vulnerabilities across all clusters' });
    await expect(table).toBeVisible();
    await expect(table.getByText(/CVE-\d{4}-\d+/).first()).toBeVisible();
});

/**
 * The block says how it ranks and shows the number each row is ranked by:
 * the header names the Risk Score and the "Adds" column carries the sum.
 * The sums drift with the mirror, so only the rule and the column are asserted.
 */
test('the Most critical block says it ranks by Risk Score and shows what each row adds', async ({ page }) => {
    await page.goto('/');
    const block = page.getByRole('region', { name: /^Most critical/ });
    await expect(block).toBeVisible();
    await expect(block.getByText(/Ranked by the Risk Score/)).toBeVisible();

    const table = block.getByRole('table', { name: 'Most critical vulnerabilities across all clusters' });
    await expect(table.getByRole('columnheader', { name: 'Adds' })).toBeVisible();
});

test('the trend cards are drawn, or the page says no metrics exist yet', async ({ page }) => {
    await page.goto('/');
    await expect(
        page
            .getByRole('heading', { name: 'Trends', level: 2 })
            .or(page.getByRole('heading', { name: 'No metrics yet', level: 3 })),
    ).toBeVisible();
});

/**
 * The Risk Score is defined where it ranks: the trend card's subtitle says
 * what one finding is worth and that the total is not out of 100, and a
 * link beside the card opens the full write-up. The figure itself drifts
 * with the mirror and is not asserted; nor is the card's presence, which
 * waits on the first snapshot — the test skips until one has been taken.
 */
test('the Risk Score card says the total is not out of 100, in one line', async ({ page }) => {
    await page.goto('/');
    const trends = page.getByRole('heading', { name: 'Trends', level: 2 });
    const noMetrics = page.getByRole('heading', { name: 'No metrics yet', level: 3 });
    await expect(trends.or(noMetrics)).toBeVisible();
    test.skip(await noMetrics.isVisible(), 'no snapshot captured yet, so the trend cards are not drawn');

    const card = page.getByRole('link', { name: 'See what drives the score' });
    await expect(card).toBeVisible();
    await expect(card).toContainText(/not out of 100/i);
    // Nothing hangs under the card: the write-up is a click away, on the page the card opens.
    await expect(page.getByRole('link', { name: 'How the Risk Score is computed' })).toHaveCount(0);
});

/** The formula's write-up is linked where the number is taken apart. */
test('the Risk Score breakdown page links to how the score is computed', async ({ page }) => {
    await page.goto('/risk-score');
    await expect(page.getByRole('heading', { level: 1, name: /Risk Score/ })).toBeVisible();
    const docs = page.getByRole('link', { name: 'How the Risk Score is computed' });
    await expect(docs).toBeVisible();
    await expect(docs).toHaveAttribute('href', 'https://stackradar.io/docs/risk-score');
});

/**
 * One severity count per screen: the exposure strip and the Clusters section
 * both say what they count under — the page's findings lens and image scope
 * — in the same chip, and the strip's four labels are on the page from the
 * first paint, with placeholders until the counts land. Which lens the page
 * opens on is the reader's standing choice, so the test reads the strip's
 * chip and asserts the Clusters section agrees with it.
 */
const SCOPE_CHIP_TITLE = 'Which findings and images this block counts — set in the filter bar above';

test('the exposure strip and the Clusters section carry the same lens chip', async ({ page }) => {
    await page.goto('/');
    const strip = page.getByRole('region', { name: 'Current vulnerability exposure' });
    const clusters = page.getByRole('region', { name: /^Clusters/ });
    await expect(strip).toBeVisible();
    await expect(clusters).toBeVisible();

    const stripChip = strip.getByTitle(SCOPE_CHIP_TITLE);
    const clustersChip = clusters.getByTitle(SCOPE_CHIP_TITLE);
    await expect(stripChip).toBeVisible();
    await expect(clustersChip).toBeVisible();
    const scope = (await stripChip.textContent())!;
    expect(scope).toMatch(/findings/);
    await expect(clustersChip).toHaveText(scope);
});

test('the exposure strip reserves its four cards before the counts arrive', async ({ page }) => {
    await page.goto('/');
    const strip = page.getByRole('region', { name: 'Current vulnerability exposure' });
    await expect(strip.getByRole('heading', { name: 'Current vulnerability exposure', level: 2 })).toBeVisible();
    // The labels are drawn with the strip, not with the response; the figures drift weekly and are not asserted.
    for (const label of ['critical', 'high', 'medium', 'low']) {
        await expect(strip.getByText(label, { exact: true })).toBeVisible();
    }
});

/**
 * Where, as a page-wide filter: the bar carries a Cluster and a Namespace
 * menu beside the images and findings ones, the choice lands in the URL as
 * `/containers` spells it, the chips on the strip and the Clusters section
 * name it, and "Most critical" is still a ranked table — the nginx image's
 * findings are in the seed namespace. The menu reads as its value, so the
 * button is found by "Namespace: All namespaces".
 */
test('the filter bar scopes the page to a namespace, kept in the URL', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Cluster: All clusters' })).toBeVisible();
    await page.getByRole('button', { name: 'Namespace: All namespaces' }).click();
    await page.getByRole('menuitemradio', { name: nginx.namespace }).click();

    await expect(page).toHaveURL(new RegExp(`[?&]namespace=${nginx.namespace}(&|$)`));
    await expect(page.getByRole('button', { name: `Namespace: ${nginx.namespace}` })).toBeVisible();

    const strip = page.getByRole('region', { name: 'Current vulnerability exposure' });
    await expect(strip.getByTitle(SCOPE_CHIP_TITLE)).toContainText(`in namespace ${nginx.namespace}`);

    const block = page.getByRole('region', { name: /^Most critical/ });
    await expect(block).toBeVisible();
    const table = block.getByRole('table', { name: 'Most critical vulnerabilities in the chosen scope' });
    await expect(table.getByText(/CVE-\d{4}-\d+/).first()).toBeVisible();

    // A reload keeps the scope: it is the URL's, not the tab's.
    await page.reload();
    await expect(page.getByRole('button', { name: `Namespace: ${nginx.namespace}` })).toBeVisible();

    // Reset clears it, URL included.
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(page).not.toHaveURL(/namespace=/);
    await expect(page.getByRole('button', { name: 'Namespace: All namespaces' })).toBeVisible();
});
