import { test, expect } from '@playwright/test';
import { LARAVEL, SERVICES, forgedToken, jaegerTrace, login, nodes, runTodo, search, servicesOf, tagsOf } from './helpers.js';

const ALL_NODES = ['laravel', 'node', 'go', 'django', 'spring-a', 'dotnet', 'spring-b'];
const ALL_SERVICES = ['laravel-otel-api', 'laravel-otel-worker', 'node-otel-api', 'go-otel-api',
  'django-otel-api', 'dotnet-otel-api', 'spring-otel-api'];

test.describe('JWT', () => {
  test('Laravel rejects requests without a valid token', async ({ request }) => {
    expect((await request.get(`${LARAVEL}/api/todos`)).status()).toBe(401);
    expect((await request.get(`${LARAVEL}/api/todos`, { headers: { Authorization: `Bearer ${forgedToken()}` } })).status()).toBe(401);
  });

  for (const [name, url] of Object.entries(SERVICES)) {
    test(`${name} /api/cascade rejects missing and forged tokens`, async ({ request }) => {
      const data = { id: 't', service: name, work_ms: 0, fail: false, children: [] };
      expect((await request.post(`${url}/api/cascade`, { data })).status()).toBe(401);
      expect((await request.post(`${url}/api/cascade`, { data, headers: { Authorization: `Bearer ${forgedToken()}` } })).status()).toBe(401);
    });

    test(`${name} /api/cascade accepts the Laravel token`, async ({ request }) => {
      const { token, user } = await login(request);
      const res = await request.post(`${url}/api/cascade`, {
        data: { id: 'solo', service: name, work_ms: 0, fail: false, children: [] },
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ id: 'solo', status: 'ok', user_id: String(user.id) });
    });
  }
});

test.describe('cascade started by a Laravel job', () => {
  test('all-ok reaches every service in one trace, as the logged-in user', async ({ request }) => {
    const { token, user } = await login(request);
    const todo = await runTodo(request, token, `e2e all-ok ${Date.now()}`);

    expect(todo.cascade_status).toBe('ok');
    const tree = nodes(todo.cascade);
    expect(tree.map((n) => n.id).sort()).toEqual([...ALL_NODES].sort());
    for (const n of tree) {
      expect(n, n.id).toMatchObject({ status: 'ok', user_id: String(user.id), trace_id: todo.trace_id });
    }

    // the trace in Jaeger: every service, one "cascade <node>" span per node
    await expect.poll(async () => {
      const trace = await jaegerTrace(request, todo.trace_id);
      return {
        services: servicesOf(trace),
        cascadeSpans: (trace?.spans ?? []).map((s) => s.operationName).filter((n) => n.startsWith('cascade ')).sort(),
      };
    }, { timeout: 60_000, intervals: [2000] }).toEqual({
      services: [...ALL_SERVICES].sort(),
      cascadeSpans: ALL_NODES.map((n) => `cascade ${n}`).sort(),
    });

    // logs of the whole cascade (API request, queue job, every service) share its trace_id and the JWT user
    await expect.poll(async () => {
      const r = await search(request, '*-otel-api-*,*-otel-worker-*', {
        size: 0,
        query: { bool: { filter: [{ term: { trace_id: todo.trace_id } }, { term: { 'context.userId': String(user.id) } }] } },
        aggs: { services: { terms: { field: 'service', size: 20 } } },
      });
      return (r.aggregations?.services.buckets ?? []).map((b) => b.key).sort();
    }, { timeout: 60_000, intervals: [2000] }).toEqual([...ALL_SERVICES].sort());
  });

  test('fail-django: Django fails, its subtree is never called, the rest still runs', async ({ request }) => {
    const { token } = await login(request);
    const todo = await runTodo(request, token, `e2e fail-django ${Date.now()}`, 'fail-django');

    expect(todo.cascade_status).toBe('error');
    const byId = Object.fromEntries(nodes(todo.cascade).map((n) => [n.id, n]));
    expect(byId.django).toMatchObject({ status: 'error', error: 'injected failure at django' });
    expect(byId['spring-a']).toBeUndefined();
    for (const id of ['laravel', 'node', 'go', 'dotnet', 'spring-b']) expect(byId[id].status, id).toBe('ok');

    await expect.poll(async () => {
      const span = (await jaegerTrace(request, todo.trace_id))?.spans.find((s) => s.operationName === 'cascade django');
      return tagsOf(span)['otel.status_code'];
    }, { timeout: 60_000, intervals: [2000] }).toBe('ERROR');
  });
});
