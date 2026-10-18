import { test, expect } from '@playwright/test';
import { APPS, LOG4J_LEVELS, SERVICES, callUntilOk, count, jaegerFind, jaegerTrace, search, spansOf } from './helpers.js';

// The telemetry standard (enforced at the source and by the ELK collector), checked in Elasticsearch
// for every service. One request through the whole chain gives each service spans and logs that carry
// the same request.id / user.id (propagated as baggage).
//   spans: Jaeger (with events) and traces-<app>.otel-default (OTel model, no span events)
//   metrics: metrics-<app>.otel-default (OTel model)
//   logs:  <service.name>-YYYY.MM.DD, one flat JSON document per log record:
//          timestamp, level, logger, service, environment, message, trace_id, span_id,
//          context {userId, username, sub, ipAddress}, request {method, url, body}, response {statusCode, body}, tags
const RID = `std-${Date.now()}`;
const USER = 'e2e-standard';
const poll = { timeout: 60_000, intervals: [2000] };
const LOG_KEYS = ['timestamp', 'level', 'logger', 'service', 'environment', 'message', 'trace_id', 'span_id',
  'context', 'request', 'response', 'tags'];
const CONTEXT_KEYS = ['userId', 'username', 'sub', 'ipAddress'];

let TRACE; // trace of the successful chain request: every service's logs of it carry this trace_id
test.beforeAll(async ({ request }) => {
  TRACE = (await callUntilOk(request, `${SERVICES.node}/api/chain`, { 'X-Request-Id': RID, 'X-User-Id': USER })).headers()['x-trace-id'];
});

const logByRequest = { term: { trace_id: '' } };
test.beforeEach(() => { logByRequest.term.trace_id = TRACE; });
const firstDoc = async (request, index, query) =>
  (await search(request, index, { size: 1, query })).hits?.hits[0]?._source;
// whole-index checks look only at documents written during this run (older ones may predate a format change)
const SINCE = new Date(Date.now() - 5_000).toISOString();
const recent = { range: { timestamp: { gte: SINCE } } };
const allDocs = async (request, index) =>
  (await search(request, index, { size: 500, query: recent })).hits?.hits.map((h) => h._source) ?? [];
const recentCount = (request, index, query) => count(request, index, { bool: { filter: [recent, query] } });

for (const { app, service, language, url, echo } of APPS) {
  test.describe(`${app} telemetry standard`, () => {
    const logs = `${app}-otel-*`;
    const logsArrived = (request) => expect.poll(() => count(request, logs, logByRequest), poll).toBeGreaterThan(0);

    // --- spans (Jaeger) ---
    // this service's spans of the chain request, found by the request.id tag
    const requestSpans = async (request) => {
      const [trace] = await jaegerFind(request, service, { 'request.id': RID });
      return spansOf(trace, service);
    };
    const firstSpan = async (request) => (await requestSpans(request))[0];
    const serverSpan = async (request) => (await requestSpans(request)).find((s) => s.attributes['span.kind'] === 'server');

    test('spans are in Jaeger', async ({ request }) => {
      await expect.poll(async () => (await requestSpans(request)).length, poll).toBeGreaterThan(0);
    });

    test('service.name, service.namespace and deployment.environment.name', async ({ request }) => {
      await expect.poll(async () => (await firstSpan(request))?.resource, poll)
        .toMatchObject({ 'service.namespace': 'demo', 'deployment.environment.name': 'local' });
    });

    test('service.version is set', async ({ request }) => {
      await expect.poll(async () => (await firstSpan(request))?.resource['service.version'], poll).toBeTruthy();
    });

    test('service.instance.id is set', async ({ request }) => {
      await expect.poll(async () => (await firstSpan(request))?.resource['service.instance.id'], poll).toBeTruthy();
    });

    test('team owner attribute', async ({ request }) => {
      await expect.poll(async () => (await firstSpan(request))?.resource.team, poll).toBe('observability');
    });

    test(`telemetry.sdk.language is ${language}`, async ({ request }) => {
      await expect.poll(async () => (await firstSpan(request))?.resource['telemetry.sdk.language'], poll).toBe(language);
    });

    test('resource has no host.*, os.*, process.*, container.* or telemetry.distro/auto attributes', async ({ request }) => {
      let span;
      await expect.poll(async () => (span = await firstSpan(request)), poll).toBeTruthy();
      const noise = /^(host|os|process|container)\.|^telemetry\.(distro|auto)\.|^deployment\.environment$/;
      expect(Object.keys(span.resource).filter((k) => noise.test(k))).toEqual([]);
    });

    test('echo span uses the shared custom attribute names', async ({ request }) => {
      const res = await callUntilOk(request, `${url}${echo}?message=abcd`, { 'X-Request-Id': `${RID}-${app}-echo` });
      let span;
      await expect.poll(async () => (span = spansOf(await jaegerTrace(request, res.headers()['x-trace-id']), service)
        .find((s) => 'echo.message_length' in s.attributes)), poll).toBeTruthy();
      expect(span.attributes['echo.message']).toBe('abcd');
      expect(Number(span.attributes['echo.message_length'])).toBe(4);
      expect(Object.keys(span.attributes)).not.toContain('echo.message.length');
    });

    test('spans use current code.* attribute names', async ({ request }) => {
      await expect.poll(async () => (await requestSpans(request)).length, poll).toBeGreaterThan(0);
      const legacy = ['code.filepath', 'code.lineno', 'code.function', 'code.namespace'];
      expect((await requestSpans(request)).flatMap((s) => Object.keys(s.attributes)).filter((k) => legacy.includes(k))).toEqual([]);
    });

    test('server span uses the stable HTTP semantic conventions', async ({ request }) => {
      let span;
      await expect.poll(async () => (span = await serverSpan(request)), poll).toBeTruthy();
      expect(span.attributes['http.request.method']).toBe('GET');
      expect(span.attributes['http.method']).toBeUndefined();
      expect(span.attributes['http.status_code']).toBeUndefined();
      expect(Number(span.attributes['http.response.status_code'])).toBeGreaterThanOrEqual(200);
    });

    // --- logs (flat documents) ---

    test(`logs go to their own index (${logs})`, async ({ request }) => {
      await logsArrived(request);
    });

    test('log documents have only the standard keys', async ({ request }) => {
      await logsArrived(request);
      const keys = (await allDocs(request, logs)).flatMap((d) => Object.keys(d));
      expect([...new Set(keys)].filter((k) => !LOG_KEYS.includes(k))).toEqual([]);
    });

    test('service and environment', async ({ request }) => {
      await logsArrived(request);
      expect(await firstDoc(request, logs, logByRequest)).toMatchObject({ service, environment: 'local' });
      // laravel-otel-* covers laravel-otel-api and laravel-otel-worker
      expect(await recentCount(request, logs, { bool: { must_not: { prefix: { service: `${app}-otel-` } } } })).toBe(0);
    });

    test('every document has timestamp, level, logger and message', async ({ request }) => {
      await logsArrived(request);
      for (const field of ['timestamp', 'level', 'logger', 'message']) {
        expect(await recentCount(request, logs, { bool: { must_not: { exists: { field } } } }), field).toBe(0);
      }
    });

    test('levels use log4j names', async ({ request }) => {
      await logsArrived(request);
      expect(await recentCount(request, logs, { bool: { must_not: { terms: { level: LOG4J_LEVELS } } } })).toBe(0);
    });

    test('logs written during a request carry context.userId', async ({ request }) => {
      await logsArrived(request);
      expect(await firstDoc(request, logs, logByRequest)).toMatchObject({ trace_id: TRACE, context: { userId: USER } });
      expect(await recentCount(request, logs, { bool: { filter: { exists: { field: 'trace_id' } }, must_not: { exists: { field: 'context.userId' } } } })).toBe(0);
    });

    test('logs written during a request carry trace_id and span_id of a span in Jaeger', async ({ request }) => {
      await logsArrived(request);
      const log = await firstDoc(request, logs, logByRequest);
      expect(log.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(log.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(await recentCount(request, logs, { bool: { filter: { exists: { field: 'context.userId' } }, must_not: { exists: { field: 'span_id' } } } })).toBe(0);
      await expect.poll(async () => (await jaegerTrace(request, log.trace_id))?.spans.some((s) => s.spanID === log.span_id), poll).toBe(true);
    });

    test('the logger is a real logger name, not the OTel bridge library', async ({ request }) => {
      await logsArrived(request);
      const loggers = (await allDocs(request, logs)).map((d) => d.logger);
      // the scope names of the PHP and pino log bridges (real loggers like io.opentelemetry.api.GlobalOpenTelemetry are fine)
      const bridges = ['io.opentelemetry.contrib.php.laravel', '@opentelemetry/instrumentation-pino'];
      expect(loggers.filter((l) => bridges.includes(l))).toEqual([]);
    });

    test('tags hold the record\'s own fields, never the standard ones', async ({ request }) => {
      await logsArrived(request);
      const keys = (await allDocs(request, logs)).flatMap((d) => Object.keys(d.tags ?? {}));
      const standard = /^(log\.logger|request\.id|user\.id|user\.name|client\.address|user_agent\.original|http\.|url\.|trace_id|span_id|cascade\.|code\.)/;
      expect([...new Set(keys)].filter((k) => standard.test(k))).toEqual([]);
    });

    test('no OTel model fields: resource, attributes, scope', async ({ request }) => {
      await logsArrived(request);
      const telemetry = ['resource', 'attributes', 'scope', 'severity_text', 'severity_number', '@timestamp', 'data_stream', 'body'];
      const query = { bool: { should: telemetry.map((field) => ({ exists: { field } })), minimum_should_match: 1 } };
      expect(await recentCount(request, logs, query)).toBe(0);
    });

    test('context holds only userId, username, ipAddress and userAgent', async ({ request }) => {
      await logsArrived(request);
      const keys = (await allDocs(request, logs)).flatMap((d) => Object.keys(d.context ?? {}));
      expect([...new Set(keys)].filter((k) => !CONTEXT_KEYS.includes(k))).toEqual([]);
    });
  });
}

test.describe('index layout', () => {
  test('traces are stored in Elasticsearch in the OTel model, one data stream per app', async ({ request }) => {
    await expect.poll(async () => (await jaegerFind(request, 'node-otel-api', { 'request.id': RID })).length, poll).toBeGreaterThan(0);
    await expect.poll(() => count(request, 'traces-*', { term: { trace_id: TRACE } }), poll).toBeGreaterThan(0);
    const streams = (await (await request.get('http://localhost:9200/_data_stream/traces-*')).json()).data_streams.map((d) => d.name);
    expect(streams).toEqual(expect.arrayContaining(APPS.map((a) => `traces-${a.app}.otel-default`)));
  });

  test('no OTel-format log documents: no logs-* data streams', async ({ request }) => {
    await expect.poll(() => count(request, '*-otel-api-*,*-otel-worker-*', logByRequest), poll).toBeGreaterThan(0);
    const streams = (await (await request.get('http://localhost:9200/_data_stream/logs-*')).json()).data_streams.map((d) => d.name);
    expect(streams).toEqual([]);
  });

  test('metrics are stored in Elasticsearch in the OTel model', async ({ request }) => {
    await expect.poll(async () => {
      const res = await request.get('http://localhost:9200/_data_stream/metrics-*');
      return (await res.json()).data_streams.map((d) => d.name).filter((n) => n.endsWith('.otel-default')).length;
    }, poll).toBeGreaterThan(0);
  });

  test('log messages are full-text searchable (message: text, message.keyword: exact)', async ({ request }) => {
    const logs = '*-otel-api-*,*-otel-worker-*';
    await expect.poll(() => count(request, logs, { bool: { filter: [{ term: { trace_id: TRACE } }, { match: { message: 'COMPLETED request' } }] } }), poll).toBeGreaterThan(0);
    expect(await count(request, logs, { bool: { filter: [{ term: { trace_id: TRACE } }, { term: { 'message.keyword': 'request completed' } }] } })).toBeGreaterThan(0);
  });
});
