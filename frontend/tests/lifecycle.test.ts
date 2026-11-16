import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('Project Lifecycle - UI Validation', () => {
  test('should verify the upload UI elements and state', async ({ page }) => {
    await page.goto('/');

    // Verify critical upload UI elements are visible
    await expect(page.getByText('Drop a recording to cut it into clips')).toBeVisible();
    
    // Verify FileUploader is rendered correctly (non-destructive check)
    const fileUploader = page.locator('input[type="file"]');
    await expect(fileUploader).toBeHidden(); // Input should be hidden as per design
  });
});
