import { test, expect } from '@playwright/test';
import { APPS, callUntilOk, randomTraceId } from './helpers.js';

// The shared /echo contract: same request context headers and W3C trace propagation in every language.
for (const { app, url, echo } of APPS) {
  test.describe(`${app} /echo`, () => {
    const endpoint = `${url}${echo}`;

    test('returns the message', async ({ request }) => {
      const res = await callUntilOk(request, `${endpoint}?message=hello-${app}`);
      expect(await res.text()).toContain(`hello-${app}`);
    });

    test('echoes the X-Request-Id it was given', async ({ request }) => {
      const res = await callUntilOk(request, `${endpoint}?message=x`, { 'X-Request-Id': `rid-${app}-1` });
      expect(res.headers()['x-request-id']).toBe(`rid-${app}-1`);
    });

    test('generates an X-Request-Id when none is sent', async ({ request }) => {
      const res = await callUntilOk(request, `${endpoint}?message=x`);
      expect(res.headers()['x-request-id']).toBeTruthy();
    });

    test('returns a W3C trace id in X-Trace-Id', async ({ request }) => {
      const res = await callUntilOk(request, `${endpoint}?message=x`);
      expect(res.headers()['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    });

    test('continues an incoming traceparent', async ({ request }) => {
      const traceId = randomTraceId();
      const res = await callUntilOk(request, `${endpoint}?message=x`, { traceparent: `00-${traceId}-b7ad6b7169203331-01` });
      expect(res.headers()['x-trace-id']).toBe(traceId);
    });

    test('starts a new trace per request', async ({ request }) => {
      const a = await callUntilOk(request, `${endpoint}?message=x`);
      const b = await callUntilOk(request, `${endpoint}?message=x`);
      expect(a.headers()['x-trace-id']).not.toBe(b.headers()['x-trace-id']);
    });

    test('injected failures are 5xx and still carry the trace id', async ({ request }) => {
      let failure;
      for (let i = 0; i < 150 && !failure; i++) {
        const res = await request.get(`${endpoint}?message=x`);
        if (!res.ok()) failure = res;
      }
      expect(failure, 'no injected failure in 150 calls').toBeTruthy();
      expect(failure.status()).toBeGreaterThanOrEqual(500);
      expect(failure.headers()['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    });
  });
}
