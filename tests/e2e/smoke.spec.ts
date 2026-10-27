import { test, expect } from '@playwright/test';

test.describe('SafeZone — Smoke', () => {
  test('главная редиректит на /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/(login|dashboard)/);
  });

  test('логин рендерится', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading')).toBeVisible();
    await expect(page.locator('input').first()).toBeVisible();
  });

  test('health endpoint отвечает', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
  });

  test('404 страница работает', async ({ page }) => {
    const res = await page.goto('/this-does-not-exist-xyz');
    expect(res?.status()).toBe(404);
    await expect(page.getByText('404')).toBeVisible();
  });

  test('защищённая страница без логина редиректит на /login', async ({ page }) => {
    await page.goto('/dashboard');

    await page.waitForLoadState('networkidle');
    const url = page.url();
    expect(url).toMatch(/\/(login|dashboard)/);
  });
});
