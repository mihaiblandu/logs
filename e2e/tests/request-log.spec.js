import { test, expect } from '@playwright/test';
import { APPS, LARAVEL, SERVICES, login, oauth2Token, search } from './helpers.js';

// Every service writes one "request completed" log per request, stored in the index <service.name>-YYYY.MM.DD:
//   timestamp, level, logger, service, environment, message, trace_id, span_id,
//   context {userId, username, sub (OAuth2 JWT only), ipAddress}, request {method, url, body},
//   response {statusCode, body}, tags (only when the record has extra fields)
// Not repeated (already in the trace): request id, duration, user agent, headers.
const KEYS = ['context', 'environment', 'level', 'logger', 'message', 'request', 'response', 'service',
  'span_id', 'timestamp', 'trace_id'];
const CONTEXT_KEYS = ['ipAddress', 'sub', 'userId', 'username'];
const poll = { timeout: 60_000, intervals: [2000] };

async function findHit(request, app, traceId, message) {
  const r = await search(request, `${app}-otel-*`, {
    size: 1,
    query: { bool: { filter: [{ term: { trace_id: traceId } }, { match_phrase: { message } }] } },
  });
  return r.hits?.hits[0];
}
const findLog = async (request, app, traceId, message) => (await findHit(request, app, traceId, message))?._source;
const requestLog = (request, app, traceId) => findLog(request, app, traceId, 'request completed');

/** GET until 2xx (/echo fails ~10% on purpose); returns that request's trace id. */
async function okTraceId(request, url, headers = {}) {
  for (let i = 0; i < 30; i++) {
    const res = await request.get(url, { headers });
    if (res.ok()) return res.headers()['x-trace-id'];
  }
  throw new Error(`${url}: no 2xx in 30 attempts`);
}

for (const { app, service, url, echo, unauthorized } of APPS) {
  test.describe(`${app} request log`, () => {
    test('stored in the index <service.name>-YYYY.MM.DD (UTC day of the record)', async ({ request }) => {
      const traceId = await okTraceId(request, `${url}${echo}?message=x`);
      let hit;
      await expect.poll(async () => (hit = await findHit(request, app, traceId, 'request completed')), poll).toBeTruthy();
      const day = hit._source.timestamp.slice(0, 10).replaceAll('-', '.');
      expect(hit._index).toBe(`${service}-${day}`);
      expect(hit._index).toMatch(/^[a-z0-9-]+-\d{4}\.\d{2}\.\d{2}$/);
    });

    test('one INFO "request completed" document in exactly the standard shape', async ({ request }) => {
      const traceId = await okTraceId(request, `${url}${echo}?message=x`, { 'X-User-Id': 'e2e-reqlog', 'User-Agent': 'e2e-agent/1.0' });
      let log;
      await expect.poll(async () => (log = await requestLog(request, app, traceId)), poll).toBeTruthy();

      expect(Object.keys(log).sort()).toEqual(KEYS);
      expect(log).toMatchObject({
        level: 'INFO',
        service,
        environment: 'local',
        message: 'request completed',
        trace_id: traceId,
        logger: expect.any(String),
        context: { userId: 'e2e-reqlog' },
        request: { method: 'GET', url: echo },
        response: { statusCode: 200 },
      });
      expect(Object.keys(log.context).sort()).toEqual(['ipAddress', 'userId']);
      expect(Object.keys(log.request).filter((k) => k !== 'body').sort()).toEqual(['method', 'url']);
      expect(log.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(new Date(log.timestamp).getTime()).toBeGreaterThan(Date.now() - 5 * 60_000);
    });

    test('nothing redundant: no request id, duration, user agent, headers or OTel model fields', async ({ request }) => {
      const traceId = await okTraceId(request, `${url}${echo}?message=x`, { 'User-Agent': 'e2e-agent/1.0', Accept: 'application/json' });
      let log;
      await expect.poll(async () => (log = await requestLog(request, app, traceId)), poll).toBeTruthy();
      for (const key of ['transactionId', 'duration', 'attributes', 'resource', 'scope', 'severity_text', '@timestamp', 'data_stream']) {
        expect(log, key).not.toHaveProperty(key);
      }
      expect(log.request).not.toHaveProperty('headers');
      expect(log.context).not.toHaveProperty('userAgent');
      expect(Object.keys(log.context).filter((k) => !CONTEXT_KEYS.includes(k))).toEqual([]);
    });

    test('an OAuth2 JWT access token adds its sub to the context', async ({ request }) => {
      const traceId = await okTraceId(request, `${url}${echo}?message=x`, { Authorization: `Bearer ${oauth2Token('1')}` });
      let log;
      await expect.poll(async () => (log = await requestLog(request, app, traceId)), poll).toBeTruthy();
      expect(log.context).toMatchObject({ sub: '1', userId: '1' });
    });

    test('the app\'s own log keeps its fields as tags, with logger and trace ids', async ({ request }) => {
      const traceId = await okTraceId(request, `${url}${echo}?message=tagged`);
      let log;
      await expect.poll(async () => (log = await findLog(request, app, traceId, 'echo ok')), poll).toBeTruthy();
      expect(log.tags['echo.message']).toBe('tagged');
      expect(log.logger).toBeTruthy();
      expect(log.span_id).toMatch(/^[0-9a-f]{16}$/);
    });

    test('a 401 is logged as WARN', async ({ request }) => {
      const [method, path] = unauthorized;
      const res = await request.fetch(`${url}${path}`, { method, data: method === 'POST' ? {} : undefined });
      expect(res.status()).toBe(401);
      let log;
      await expect.poll(async () => (log = await requestLog(request, app, res.headers()['x-trace-id'])), poll).toBeTruthy();
      expect(log).toMatchObject({ level: 'WARN', request: { method, url: path }, response: { statusCode: 401 } });
    });
  });
}

// with the Laravel login token (not an OAuth2 token: no sub), username from its `name`, JSON bodies
for (const [app, url] of Object.entries(SERVICES)) {
  test(`${app} request log has username and JSON bodies`, async ({ request }) => {
    const { token, user } = await login(request);
    const res = await request.post(`${url}/api/cascade`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { id: 'solo', service: app, work_ms: 0, fail: false, children: [] },
    });
    expect(res.status()).toBe(200);
    let log;
    await expect.poll(async () => (log = await requestLog(request, app, res.headers()['x-trace-id'])), poll).toBeTruthy();
    expect(log).toMatchObject({
      context: { userId: String(user.id), username: user.name },
      request: { method: 'POST', url: '/api/cascade', body: { id: 'solo', service: app } },
      response: { statusCode: 200, body: { id: 'solo', status: 'ok' } },
    });
    expect(log.context).not.toHaveProperty('sub');
    // the response's own trace ids repeat the log's trace_id / span_id
    expect(log.response.body).not.toHaveProperty('trace_id');
    expect(log.response.body).not.toHaveProperty('span_id');
  });
}

test('laravel login: password and token are masked in the request log', async ({ request }) => {
  const res = await request.post(`${LARAVEL}/api/login`, { data: { email: 'demo@example.com', password: 'password' } });
  expect(res.status()).toBe(200);
  let log;
  await expect.poll(async () => (log = await requestLog(request, 'laravel', res.headers()['x-trace-id'])), poll).toBeTruthy();
  expect(log.request.body).toEqual({ email: 'demo@example.com', password: '******' });
  expect(log.response.body.token).toBe('******');
  expect(JSON.stringify(log)).not.toContain((await res.json()).token);
});
