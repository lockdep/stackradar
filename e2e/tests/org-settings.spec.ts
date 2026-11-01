import { expect, test } from '@playwright/test';
import { stack } from '../src/stack';

/** The organisation page of a community install: one org, one member. */
test('the organization settings show the org and its one member', async ({ page }) => {
    await page.goto('/org-settings');
    await expect(page.getByRole('heading', { name: 'Organization Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('tabpanel').getByText(stack.orgName)).toBeVisible();

    await page.getByRole('tab', { name: 'Members' }).click();
    await expect(page.getByRole('table', { name: 'Members' })).toContainText(stack.admin.email);
});

/**
 * The alert channels are named for every role, not only to whoever may edit
 * them. The community stack has the webhook channel and says email is a
 * cloud feature; both words are on the card either way.
 */
test('the notifications tab names the alert channels', async ({ page }) => {
    await page.goto('/org-settings?tab=notifications');
    const card = page.getByRole('tabpanel').filter({ hasText: 'Critical & KEV alerts' });
    await expect(card).toContainText('Slack');
    await expect(card).toContainText('email');
    await expect(card.getByText('Delivered to a Slack incoming webhook', { exact: false })).toBeVisible();
});
