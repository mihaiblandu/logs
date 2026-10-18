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

// Every scenario against the real services: which nodes succeed, which fail, which are never called
// (a failing node does not call its subtree), and how long the slow ones take.
const CHAIN = ['laravel', 'node', 'go', 'django', 'dotnet', 'spring'];
const SCENARIOS = {
  slow: { ok: ALL_NODES, minMs: { laravel: 400, 'spring-a': 400 } },
  chain: { ok: CHAIN },
  wide: { ok: CHAIN },
  'fail-laravel': { error: ['laravel'], missing: ALL_NODES.slice(1) },
  'fail-node': { ok: ['laravel', 'dotnet', 'spring-b'], error: ['node'], missing: ['go', 'django', 'spring-a'] },
  'fail-go': { ok: ['laravel', 'node', 'django', 'spring-a', 'dotnet', 'spring-b'], error: ['go'] },
  'fail-dotnet': { ok: ['laravel', 'node', 'go', 'django', 'spring-a'], error: ['dotnet'], missing: ['spring-b'] },
  'fail-spring': { ok: ['laravel', 'node', 'go', 'django', 'dotnet'], error: ['spring-a', 'spring-b'] },
  'fail-spring-a': { ok: ['laravel', 'node', 'go', 'django', 'dotnet', 'spring-b'], error: ['spring-a'] },
  'slow-node': { ok: ALL_NODES, minMs: { node: 1500 } },
  'slow-django': { ok: ALL_NODES, minMs: { django: 1500 } },
  'slow-spring': { ok: ALL_NODES, minMs: { 'spring-a': 1500, 'spring-b': 1500 } },
  mixed: { ok: ['laravel', 'node', 'django', 'spring-a', 'dotnet', 'spring-b'], error: ['go'], minMs: { dotnet: 1200 } },
  'chain-fail-django': { ok: ['laravel', 'node', 'go'], error: ['django'], missing: ['dotnet', 'spring'] },
  'wide-fail-go': { ok: ['laravel', 'node', 'django', 'dotnet', 'spring'], error: ['go'] },
};

test.describe('scenarios', () => {
  for (const [scenario, want] of Object.entries(SCENARIOS)) {
    test(`${scenario}: ok ${(want.ok ?? []).join(',') || '-'} / error ${(want.error ?? []).join(',') || '-'}`, async ({ request }) => {
      const { token, user } = await login(request);
      const todo = await runTodo(request, token, `e2e ${scenario} ${Date.now()}`, scenario);
      const byId = Object.fromEntries(nodes(todo.cascade).map((n) => [n.id, n]));

      expect(todo.cascade_status).toBe(want.error ? 'error' : 'ok');
      for (const id of want.ok ?? []) expect(byId[id], id).toMatchObject({ status: 'ok', user_id: String(user.id), trace_id: todo.trace_id });
      for (const id of want.error ?? []) expect(byId[id], id).toMatchObject({ status: 'error', error: `injected failure at ${id}` });
      for (const id of want.missing ?? []) expect(byId[id], `${id} must not be called`).toBeUndefined();
      expect(Object.keys(byId).sort()).toEqual([...(want.ok ?? []), ...(want.error ?? [])].sort());
      for (const [id, ms] of Object.entries(want.minMs ?? {})) expect(byId[id].duration_ms, id).toBeGreaterThanOrEqual(ms);

      // one trace: one "cascade <node>" span per node that ran, failed ones with ERROR status
      await expect.poll(async () => {
        const spans = (await jaegerTrace(request, todo.trace_id))?.spans ?? [];
        const cascade = spans.filter((s) => s.operationName.startsWith('cascade '));
        return {
          ran: cascade.map((s) => s.operationName.slice('cascade '.length)).sort(),
          errors: cascade.filter((s) => tagsOf(s)['otel.status_code'] === 'ERROR').map((s) => s.operationName.slice('cascade '.length)).sort(),
        };
      }, { timeout: 60_000, intervals: [2000] }).toEqual({ ran: Object.keys(byId).sort(), errors: [...(want.error ?? [])].sort() });
    });
  }

  test('chain: all six services in one line, each the parent of the next', async ({ request }) => {
    const { token } = await login(request);
    const todo = await runTodo(request, token, `e2e chain line ${Date.now()}`, 'chain');
    const line = [];
    for (let n = todo.cascade; n; n = n.children?.[0]) {
      expect(n.children.length, n.id).toBeLessThanOrEqual(1);
      line.push(n.service);
    }
    expect(line).toEqual(CHAIN);

    // in the trace every cascade span (except Laravel's) descends from the previous service's span
    await expect.poll(async () => {
      const trace = await jaegerTrace(request, todo.trace_id);
      return servicesOf(trace);
    }, { timeout: 60_000, intervals: [2000] }).toEqual(expect.arrayContaining(['laravel-otel-worker', 'node-otel-api', 'go-otel-api', 'django-otel-api', 'dotnet-otel-api', 'spring-otel-api']));
    const trace = await jaegerTrace(request, todo.trace_id);
    const byId = Object.fromEntries(trace.spans.map((s) => [s.spanID, s]));
    const ancestorOf = (span, op) => {
      for (let s = span; s; s = byId[s.references?.find((r) => r.refType === 'CHILD_OF')?.spanID]) if (s.operationName === op) return true;
      return false;
    };
    for (let i = 1; i < CHAIN.length; i++) {
      const span = trace.spans.find((s) => s.operationName === `cascade ${CHAIN[i]}`);
      expect(ancestorOf(span, `cascade ${CHAIN[i - 1]}`), `${CHAIN[i - 1]} -> ${CHAIN[i]}`).toBe(true);
    }
  });

  test('chaos: every run is a valid cascade (failed nodes have no children)', async ({ request }) => {
    const { token } = await login(request);
    const todo = await runTodo(request, token, `e2e chaos ${Date.now()}`, 'chaos');
    const all = nodes(todo.cascade);
    expect(todo.cascade_status).toBe(all.some((n) => n.status === 'error') ? 'error' : 'ok');
    for (const n of all.filter((x) => x.status === 'error')) expect(n.children, n.id).toEqual([]);
  });

  test('the plan endpoint lists every scenario with a description', async ({ request }) => {
    const { token } = await login(request);
    const res = await request.get(`${LARAVEL}/api/cascade/plan?scenario=wide`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    expect(body.scenarios).toEqual(expect.arrayContaining(['all-ok', 'fail-django', ...Object.keys(SCENARIOS), 'chaos']));
    for (const s of body.scenarios) expect(body.descriptions[s], s).toBeTruthy();
    expect(body.plan.children.map((c) => c.id)).toEqual(['node', 'go', 'django', 'dotnet', 'spring']);
  });
});
