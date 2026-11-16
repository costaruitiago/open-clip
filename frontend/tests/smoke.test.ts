import { test, expect } from '@playwright/test';

test.describe('Core Application Smoke Test', () => {
  test('should load the home page and verify critical UI elements', async ({ page }) => {
    // Navigate to the home page
    await page.goto('/');

    // Verify critical elements are visible
    await expect(page.getByText('Open Clip')).toBeVisible();
    await expect(page.getByText('Drop a recording to cut it into clips')).toBeVisible();
  });

  test('should navigate to history page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'PROJECTS' }).click();
    await expect(page).toHaveURL(/.*history/);
  });
});
