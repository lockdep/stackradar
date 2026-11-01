import { expect, test } from '@playwright/test';
import { nginx } from '../src/api';

/**
 * The org-wide advisory list and one advisory's page: what the matcher
 * found in the nginx SBOM, opened the way a user drills in.
 */
test('an advisory opens from the list to its own page', async ({ page }) => {
    await page.goto('/vulnerabilities');
    await expect(page.getByRole('heading', { level: 1, name: /Vulnerabilities/ })).toBeVisible();

    const firstId = await page
        .getByText(/^CVE-\d{4}-\d+$/)
        .first()
        .textContent();
    expect(firstId).toMatch(/^CVE-/);

    // The whole row is the expander; its own button is aria-hidden.
    await page.getByRole('row').filter({ hasText: firstId! }).first().click();
    await page.getByRole('link', { name: 'Open full page' }).click();

    await expect(page).toHaveURL(new RegExp(`/vulnerabilities/${firstId}$`));
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(firstId!);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(firstId!);
    // The page draws the table twice (phone and desktop layout); either carries the image.
    await expect(page.getByRole('table', { name: `Images affected by ${firstId}` }).first()).toContainText(
        nginx.repository,
    );

    // The advisory-level fix fact is about publication, never "fixable": which
    // of the two it reads depends on the mirror, but it is always one of them,
    // and the old word is gone (the per-image hint answers "is it scanned here").
    await expect(page.getByText(/^(Fix published|No fix published)$/).first()).toBeVisible();
    await expect(page.getByText('Fixable', { exact: true })).toHaveCount(0);

    // The exposure line names its two clocks before their numbers — how long
    // the advisory has been public, since when the image has been running
    // here — so the figures are facts, not a contradiction. The durations
    // themselves drift with the mirror and the clock, so only the names are
    // asserted.
    const exposureLine = page.locator('p').filter({ hasText: 'Advisory public' }).first();
    await expect(exposureLine).toBeVisible();
    // The running-since clock needs a closed presence interval, which a stack
    // seeded moments ago does not have yet; when it is there it is named, and
    // the old unnamed phrasing never is.
    await expect(exposureLine).not.toContainText(/running for|Exposed \d/);
    const text = (await exposureLine.textContent()) ?? '';
    if (/since/.test(text)) expect(text).toContain('running here since');

    // Where it runs is a table of workloads — the seeded nginx Deployment —
    // named as such, while the header's "Containers" keeps counting containers.
    await expect(page.getByRole('heading', { level: 2, name: /Running workloads/ })).toBeVisible();
    await expect(
        page.getByRole('table', { name: `Workloads running images affected by ${firstId}` }).first(),
    ).toContainText(nginx.workload);
    await expect(page.getByRole('table', { name: /^Containers running / })).toHaveCount(0);
});

test('the search box narrows the list and says when nothing matches', async ({ page }) => {
    await page.goto('/vulnerabilities');
    const firstId = (await page
        .getByText(/^CVE-\d{4}-\d+$/)
        .first()
        .textContent())!;

    const search = page.getByPlaceholder('Search by advisory or package');
    await search.fill(firstId);
    await expect(page.getByText(firstId, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/^CVE-\d{4}-\d+$/).filter({ hasNotText: firstId })).toHaveCount(0);

    await search.fill('CVE-1999-000000');
    await expect(page.getByText('No vulnerabilities match the current filter in any cluster.')).toBeVisible();
});
