import { test, expect } from '@playwright/test';

// every test gets a fresh browser context: log in through the form (demo credentials are prefilled)
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByLabel('New todo')).toBeVisible();
});

test('a new todo shows its cascade graph turning green', async ({ page }) => {
  const title = `ui cascade ${Date.now()}`;
  await page.getByLabel('New todo').fill(title);
  await page.getByRole('button', { name: 'Add' }).click();

  await expect(page.locator('li', { hasText: title })).toBeVisible();
  const graph = page.locator('.vue-flow');
  await expect(graph.locator('.vue-flow__node')).toHaveCount(7);
  await expect(graph.locator('.node.ok')).toHaveCount(7, { timeout: 60_000 });
  await expect(page.getByRole('link', { name: 'Trace in Jaeger' })).toHaveAttribute('href', /:16686\/trace\/[0-9a-f]{32}$/);
  await expect(page.getByRole('link', { name: 'Logs in Discover' })).toHaveAttribute('href', /trace_id/);

  await graph.locator('.vue-flow__node', { hasText: 'django' }).click();
  await expect(page.locator('.details')).toContainText('Django');
  await page.screenshot({ path: 'artifacts/cascade-ok.png', fullPage: true });
});

test('a failing scenario marks the node red and skips its subtree', async ({ page }) => {
  await page.getByLabel('New todo').fill(`ui fail ${Date.now()}`);
  await page.getByLabel('Cascade scenario').selectOption('fail-dotnet');
  await page.getByRole('button', { name: 'Add' }).click();

  const graph = page.locator('.vue-flow');
  await expect(graph.locator('.node.error')).toHaveCount(1, { timeout: 60_000 });
  await expect(graph.locator('.node.error')).toContainText('.NET');
  await expect(graph.locator('.node.skipped')).toContainText('spring-b');
  await page.screenshot({ path: 'artifacts/cascade-fail.png', fullPage: true });
});
