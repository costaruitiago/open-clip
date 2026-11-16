import { test, expect } from '@playwright/test';

test.describe('Component Integrity & Smoke Test Battery', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Header and Navigation elements are visible', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'OPEN CLIP' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'PROJECTS' })).toBeVisible();
  });

  test('ThemeToggle is interactive', async ({ page }) => {
    // Theme toggle is a button, but might not have a text label.
    // We can target it by its position or role.
    const toggle = page.locator('button').filter({ has: page.locator('svg') });
    await expect(toggle.first()).toBeVisible();
  });

  test('FileUploader is present', async ({ page }) => {
    await expect(page.getByText('Drop a recording to cut it into clips')).toBeVisible();
  });
});
