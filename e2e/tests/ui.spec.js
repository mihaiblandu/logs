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

test('the scenario description follows the dropdown', async ({ page }) => {
  await page.getByLabel('Cascade scenario').selectOption('chain');
  await expect(page.getByTestId('scenario-description')).toContainText('all six services in one line');
});

test('"Run all scenarios" starts one cascade per scenario, shown in one row', async ({ page }) => {
  // the scenario list is loaded from the plan endpoint after login
  const options = page.getByLabel('Cascade scenario').locator('option');
  await expect.poll(() => options.count()).toBeGreaterThanOrEqual(15);
  const scenarios = await options.evaluateAll((os) => os.map((o) => o.value));

  const todos = page.locator('section.todos li');
  const before = await todos.count();
  await page.getByRole('button', { name: /Run all scenarios/ }).click();
  await expect(todos).toHaveCount(before + scenarios.length);
  // every cascade finishes: no todo left queued/running, every chip green (ok) or red (error)
  await expect(todos.locator('.badge.queued, .badge.running')).toHaveCount(0, { timeout: 110_000 });
  const strip = page.getByLabel('Scenarios');
  await expect(strip.locator('.chip.ok, .chip.error')).toHaveCount(scenarios.length);
  await expect(strip.locator('.chip[data-scenario="all-ok"]')).toHaveClass(/ok/);
  await expect(strip.locator('.chip[data-scenario="fail-node"]')).toHaveClass(/error/);
  // the chips are one row
  const tops = await strip.locator('.chip').evaluateAll((cs) => [...new Set(cs.map((c) => c.offsetTop))]);
  expect(tops).toHaveLength(1);

  // a chip opens that scenario's graph: the chain is six nodes on one line
  await strip.locator('.chip[data-scenario="chain"]').click();
  const graph = page.locator('.vue-flow');
  await expect(graph.locator('.vue-flow__node')).toHaveCount(6);
  await expect(graph.locator('.node.ok')).toHaveCount(6);
  await page.screenshot({ path: 'artifacts/run-all.png', fullPage: true });
});
