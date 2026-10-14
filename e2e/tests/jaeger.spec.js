import { test, expect } from '@playwright/test';
import { APPS, JAEGER, SERVICES, callUntilOk, jaegerTrace, servicesOf } from './helpers.js';

// Traces are also sent to Jaeger (http://localhost:16686) by the ELK collector.
const poll = { timeout: 30_000, intervals: [1000] };

for (const { app, service, url, echo } of APPS) {
  test.describe(`${app} in Jaeger`, () => {
    test('is listed as a service', async ({ request }) => {
      await callUntilOk(request, `${url}${echo}?message=x`);
      await expect.poll(async () => (await (await request.get(`${JAEGER}/api/services`)).json()).data, poll).toContain(service);
    });

    test('a request can be looked up by its X-Trace-Id', async ({ request }) => {
      const res = await callUntilOk(request, `${url}${echo}?message=x`);
      const traceId = res.headers()['x-trace-id'];
      await expect.poll(async () => servicesOf(await jaegerTrace(request, traceId)), poll).toContain(service);
    });
  });
}

test('one /api/chain request is one Jaeger trace across all six services', async ({ request }) => {
  const res = await callUntilOk(request, `${SERVICES.node}/api/chain`);
  const traceId = res.headers()['x-trace-id'];
  await expect.poll(async () => servicesOf(await jaegerTrace(request, traceId)), poll)
    .toEqual(APPS.map((a) => a.service).sort());
});
