import { expect, test } from '@playwright/test';
import { nginx } from '../src/api';

/** One image's page: its findings, the vulnerable components, and where it runs. */
test('the image page shows findings, components and workloads', async ({ page }) => {
    await page.goto('/images');
    await page
        .getByRole('link', { name: `${nginx.repository}:${nginx.tag}` })
        .filter({ visible: true })
        .first()
        .click();
    await expect(page).toHaveURL(/\/images\/[0-9a-f-]{36}$/);

    const vulnerabilities = page.getByRole('tab', { name: /Vulnerabilities/ });
    await expect(vulnerabilities).toHaveAttribute('aria-selected', 'true');
    const findings = page.getByRole('tabpanel');
    await expect(findings.getByText(/CVE-\d{4}-\d+/).first()).toBeVisible();

    // One findings figure for the page: the tab carries no count of its own
    // (its name is the bare word), and the list's heading badge under it is
    // the number — whatever it is this week.
    await expect(vulnerabilities).toHaveAccessibleName(/^\s*Vulnerabilities\s*$/);
    const heading = findings.getByRole('heading', { level: 2, name: /Vulnerabilities/ });
    await expect(heading).toContainText(/\d/);
    // The sentence under it names both numbers with their nouns, so the
    // advisory count and the findings count read as two units.
    await expect(
        findings.getByText(/\d+ advisor(y|ies) · \d+ findings? across .*packages in this image\./),
    ).toBeVisible();

    await page.getByRole('tab', { name: /Vulnerable components/ }).click();
    await expect(page.getByRole('tabpanel').getByRole('row').nth(1)).toBeVisible();

    // "Workloads", not "Deployments": the table lists StatefulSets too, each row with its kind.
    await expect(page.getByRole('tab', { name: /Deployments/ })).toHaveCount(0);
    await page.getByRole('tab', { name: /Workloads/ }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel).toContainText(nginx.namespace);
    await expect(panel).toContainText(nginx.workload);
});

/**
 * Where the image runs is on the header, not a tab away: a "Runs in" line
 * under the title names the seed namespace and the cluster, and opens the
 * Workloads tab. The workload count is one here; it is not asserted beyond
 * the noun, as the seed may grow.
 */
test('the image header says where it runs and opens the Workloads tab from it', async ({ page }) => {
    await page.goto('/images');
    await page
        .getByRole('link', { name: `${nginx.repository}:${nginx.tag}` })
        .filter({ visible: true })
        .first()
        .click();
    await expect(page).toHaveURL(/\/images\/[0-9a-f-]{36}$/);

    const runsIn = page.getByText(/^Runs in/);
    await expect(runsIn).toBeVisible();
    await expect(runsIn).toContainText(nginx.namespace);
    await expect(runsIn).toContainText(/\d+ workloads?/);

    await runsIn.getByRole('button').click();
    await expect(page.getByRole('tab', { name: /Workloads/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toContainText(nginx.workload);
});

/**
 * The History tab: the Feed scoped to this image, last in the strip. What it
 * holds depends on the stack's past — a fresh stack has the seed's
 * "now tracked" line and the first scan; a stack the stateful suite has run
 * against has moves off and onto the digest too; the `chromium` project
 * cannot count on either — so the assertion is that the tab answers: rows,
 * or the sentence that says there are none.
 */
test('the image page has a History tab, last, that lists events or says there are none', async ({ page }) => {
    await page.goto('/images');
    await page
        .getByRole('link', { name: `${nginx.repository}:${nginx.tag}` })
        .filter({ visible: true })
        .first()
        .click();
    await expect(page).toHaveURL(/\/images\/[0-9a-f-]{36}$/);

    const history = page.getByRole('tab', { name: /History/ });
    await expect(history).toBeVisible();
    await expect(page.getByRole('tab').last()).toHaveAccessibleName(/History/);

    await history.click();
    await expect(history).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel');
    const rows = panel.getByRole('list', { name: 'History of this image' }).getByRole('listitem');
    const empty = panel.getByText('No events recorded for this image yet.');
    await expect(rows.first().or(empty)).toBeVisible();
});
