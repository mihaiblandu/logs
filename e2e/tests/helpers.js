import { createHmac } from 'node:crypto';
import { expect } from '@playwright/test';

export const LARAVEL = process.env.LARAVEL_URL || 'http://localhost:8000';
export const ELASTIC = process.env.ELASTIC_URL || 'http://localhost:9200';
export const SERVICES = {
  spring: 'http://localhost:4242',
  dotnet: 'http://localhost:5050',
  django: 'http://localhost:8001',
  go: 'http://localhost:4250',
  node: 'http://localhost:3005',
};

export async function login(request) {
  const res = await request.post(`${LARAVEL}/api/login`, { data: { email: 'demo@example.com', password: 'password' } });
  expect(res.status()).toBe(200);
  return res.json(); // { token, user }
}

/** Creates a todo and waits until its cascade finished; returns the todo. */
export async function runTodo(request, token, title, scenario = 'all-ok') {
  const headers = { Authorization: `Bearer ${token}` };
  const created = await request.post(`${LARAVEL}/api/todos`, { headers, data: { title, scenario } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();

  let todo;
  await expect.poll(async () => {
    todo = await (await request.get(`${LARAVEL}/api/todos/${id}`, { headers })).json();
    return todo.cascade_status;
  }, { timeout: 60_000, intervals: [500] }).toMatch(/^(ok|error)$/);
  return todo;
}

/** Flattens a cascade result tree into a list of nodes. */
export function nodes(result) {
  return [result, ...(result.children ?? []).flatMap(nodes)];
}

/** Elasticsearch search; retries because ingestion lags a few seconds behind. */
export async function search(request, index, body) {
  // a missing index (e.g. right after a purge) is an empty result, not an error
  const res = await request.post(`${ELASTIC}/${index}/_search?ignore_unavailable=true&allow_no_indices=true`, { data: body });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

export function forgedToken() {
  // right claims, wrong secret
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: '1', iss: 'laravel-otel', aud: 'otel-demo', exp: Math.floor(Date.now() / 1000) + 300 })}.c2lnbmF0dXJl`;
}

export const JAEGER = process.env.JAEGER_URL || 'http://localhost:16686';

/** The six services and what the telemetry standard expects from each of them. */
export const APPS = [
  // unauthorized: a request that answers 401 without a token
  { app: 'spring', service: 'spring-otel-api', url: SERVICES.spring, echo: '/echo', language: 'java', unauthorized: ['POST', '/api/cascade'] },
  { app: 'laravel', service: 'laravel-otel-api', url: LARAVEL, echo: '/api/echo', language: 'php', unauthorized: ['GET', '/api/todos'] },
  { app: 'django', service: 'django-otel-api', url: SERVICES.django, echo: '/api/echo', language: 'python', unauthorized: ['POST', '/api/cascade'] },
  { app: 'dotnet', service: 'dotnet-otel-api', url: SERVICES.dotnet, echo: '/api/echo', language: 'dotnet', unauthorized: ['POST', '/api/cascade'] },
  { app: 'go', service: 'go-otel-api', url: SERVICES.go, echo: '/api/echo', language: 'go', unauthorized: ['POST', '/api/cascade'] },
  { app: 'node', service: 'node-otel-api', url: SERVICES.node, echo: '/api/echo', language: 'nodejs', unauthorized: ['POST', '/api/cascade'] },
];

/** log4j level names; the collector maps every SDK's severity onto them. */
export const LOG4J_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

/** Calls a service until it answers 2xx (every /echo and /chain fails ~10% of the time on purpose). */
export async function callUntilOk(request, url, headers = {}, attempts = 30) {
  let res;
  for (let i = 0; i < attempts; i++) {
    res = await request.get(url, { headers });
    if (res.ok()) return res;
  }
  throw new Error(`${url}: no 2xx in ${attempts} attempts (last ${res.status()})`);
}

/** Number of documents matching `query` in `index` (0 when the index doesn't exist). */
export async function count(request, index, query) {
  const res = await request.post(`${ELASTIC}/${index}/_count?ignore_unavailable=true&allow_no_indices=true`, { data: { query } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).count;
}

export const randomTraceId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

// --- Jaeger (traces with span events; Elasticsearch has the same spans without events) ---

/** One trace from Jaeger by id, or undefined while it is not there yet. */
export async function jaegerTrace(request, traceId) {
  const res = await request.get(`${JAEGER}/api/traces/${traceId}`);
  return res.ok() ? (await res.json()).data?.[0] : undefined;
}

/** Traces of a service whose spans carry all the given tags, e.g. { 'request.id': 'x' }. */
export async function jaegerFind(request, service, tags) {
  const params = new URLSearchParams({ service, tags: JSON.stringify(tags), limit: '20', lookback: '1h' });
  const res = await request.get(`${JAEGER}/api/traces?${params}`);
  return res.ok() ? (await res.json()).data ?? [] : [];
}

export const servicesOf = (trace) => [...new Set(Object.values(trace?.processes ?? {}).map((p) => p.serviceName))].sort();
/** span or process tags as an object */
export const tagsOf = (x) => Object.fromEntries((x?.tags ?? []).map((t) => [t.key, t.value]));
/** spans of one service in a trace, each with its resource (process) tags as `resource` */
export const spansOf = (trace, service) => (trace?.spans ?? [])
  .filter((s) => trace.processes[s.processID]?.serviceName === service)
  .map((s) => ({ ...s, attributes: tagsOf(s), resource: tagsOf(trace.processes[s.processID]) }));

/**
 * A valid OAuth2 JWT access token (RFC 9068 style: client_id + scope) signed with the shared dev secret,
 * accepted by every service; its `sub` must show up as context.sub in the request log.
 */
export function oauth2Token(sub = '1') {
  const secret = process.env.JWT_SECRET || 'dev-only-shared-secret-change-me-0123456789abcdef';
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'HS256', typ: 'at+jwt' })}.${b64({
    iss: 'laravel-otel', aud: 'otel-demo', sub, client_id: 'e2e-client', scope: 'todos:read', iat: now, exp: now + 300,
  })}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}
