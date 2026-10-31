import { expect, test as setup } from '@playwright/test';
import { adminStorageState, stack } from './stack';

/**
 * The first sign-in, as a test the other projects depend on.
 *
 * A fresh stack has the bootstrap admin with the fixture password and
 * `must_change_password` set: signing in lands on /account/password and
 * nothing else is reachable until a new password is chosen. A stack that
 * has already run this suite has the admin on the e2e password. Both paths
 * end signed in on the dashboard, and the browser state is saved for every
 * other test to start from.
 */
setup('the bootstrap admin signs in, changing the fixture password when asked', async ({ page }) => {
    setup.setTimeout(6 * 60_000);
    await page.goto('/login');
    await page.getByLabel('Email').fill(stack.admin.email);
    await page.getByLabel('Password', { exact: true }).fill(stack.admin.bootstrapPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();

    const refused = page.getByText('Sign-in failed', { exact: false }).or(page.getByText('Invalid', { exact: false }));
    await expect(page.getByRole('heading', { name: 'Choose a new password' }).or(refused)).toBeVisible({
        timeout: 15_000,
    });

    if (await page.getByRole('heading', { name: 'Choose a new password' }).isVisible()) {
        // Fresh stack: the forced change. Until it is done, the app is off limits.
        await page.goto('/');
        await expect(page).toHaveURL(/\/account\/password$/);
        await page.getByLabel('Current password').fill(stack.admin.bootstrapPassword);
        await page.getByLabel('New password', { exact: true }).fill(stack.admin.password);
        await page.getByLabel('New password, again').fill(stack.admin.password);
        await page.getByRole('button', { name: 'Set password and continue' }).click();
    } else {
        // Seen stack: the fixture password is gone; sign in with the one this suite set.
        await page.getByLabel('Password', { exact: true }).fill(stack.admin.password);
        await page.getByRole('button', { name: 'Sign in' }).click();
    }

    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

    // The findings lens defaults to "application packages" (the org's
    // default_finding_tier), under which the nginx fixture — base-image
    // findings only — reads as zero everywhere until the KEV feed lets a few
    // through. The suite looks at everything; container-detail.spec.ts
    // covers the default lens on its own.
    await page.evaluate(() => window.localStorage.setItem('sr.findings-lens', 'all'));
    await page.context().storageState({ path: adminStorageState });

    // The tests read findings, so none of them starts before the mirror is
    // live and the seeded image has been matched against it. On a fresh
    // stack the Alpine bootstrap is about ten seconds after the server
    // reports ready and the match follows within seconds; the long ceiling
    // is for a slow connection, not the usual case.
    await expect
        .poll(
            async () => {
                const res = await page.request.get('/api/vulnerabilities/mirror');
                if (!res.ok()) return `mirror ${res.status()}`;
                const mirror = (await res.json()) as { osv?: { initialized?: boolean; lastError?: string | null } };
                if (!mirror.osv?.initialized)
                    return `mirror not initialized${mirror.osv?.lastError ? `: ${mirror.osv.lastError}` : ''}`;
                const images = await page.request.get('/api/images');
                if (!images.ok()) return `images ${images.status()}`;
                const rows = (await images.json()) as {
                    repository: string | null;
                    vulnerabilities: Record<string, number> | null;
                }[];
                const nginx = rows.find((r) => r.repository === 'nginx');
                const total = Object.values(nginx?.vulnerabilities ?? {}).reduce(
                    (a, b) => a + (typeof b === 'number' ? b : 0),
                    0,
                );
                return total > 0 ? 'matched' : 'nginx not matched yet';
            },
            { timeout: 5 * 60_000, intervals: [2_000, 5_000] },
        )
        .toBe('matched');
});
