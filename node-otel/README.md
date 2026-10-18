# node-otel

Express 5 API with the OpenTelemetry Node SDK + auto-instrumentations (traces, metrics, logs over
OTLP/HTTP), with the same request context as the other services.

```bash
npm install
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4308 npm start          # :3005
curl -i -H 'X-User-Id: mihai' -H 'X-Request-Id: demo-1' 'localhost:3005/api/echo?message=hi'
curl -H 'X-User-Id: mihai' 'localhost:3005/api/chain'   # Node -> Go -> Django -> .NET -> Laravel -> Spring
```

| Piece | What it does |
|-------|--------------|
| `instrumentation.js` (`--require`) | NodeSDK: http server spans, `fetch` (undici) client spans with `traceparent` + `baggage`, pino → OTel logs |
| context middleware in `app.js` | `X-Request-Id` / `X-User-Id` (or upstream baggage) → server span attributes + baggage (`context.with`); response gets `X-Request-Id`, `X-Trace-Id` |
| pino `mixin` | adds `request.id` / `user.id` from baggage to every record; the pino instrumentation adds `trace_id` / `span_id` |
| `/api/echo` | `echo.process` child span with events, `recordException` + ERROR status, `echo.requests` counter, `echo.message.length` histogram |

## Gotchas

- CommonJS on purpose: with `"type": "module"` auto-instrumentation needs ESM loader hooks.
- Express 5 is built on `router`: `instrumentation-router` adds `middleware - patched` / `request handler`
  spans, and makes the *middleware* span the active one, so context attributes miss the server span.
  It's disabled (plus `fs` and `net` for noise).
- `BatchLogRecordProcessor` takes `{ exporter }` in sdk-logs 0.2xx; passing the exporter directly
  fails at export time with `Cannot read properties of undefined (reading 'export')` and no logs leave.
- A hand-built `PeriodicExportingMetricReader` ignores `OTEL_METRIC_EXPORT_INTERVAL` (default 60s).
