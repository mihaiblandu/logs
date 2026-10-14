# go-otel

Go (`net/http`) version of `../utils` with OpenTelemetry traces, metrics and logs (`slog` via the
`otelslog` bridge) over OTLP/HTTP, with the same request context as the other services.

```bash
go build -o go-otel . && OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 ./go-otel   # :4250
curl -i -H 'X-User-Id: mihai' -H 'X-Request-Id: demo-1' 'localhost:4250/api/echo?message=hi'
curl -H 'X-User-Id: mihai' 'localhost:4250/api/chain'   # Go -> Django -> .NET -> Laravel -> Spring
```

| Piece | What it does |
|-------|--------------|
| `otelhttp.NewHandler` / `otelhttp.NewTransport` | server + client spans and HTTP metrics; extracts / injects `traceparent` + `baggage` |
| `withContext` middleware | `X-Request-Id` / `X-User-Id` (or upstream baggage) → span attributes + baggage in `ctx`; response gets `X-Request-Id`, `X-Trace-Id` |
| `contextHandler` (slog) | adds `request.id` / `user.id` from baggage to every record; `otelslog` adds `trace_id` / `span_id` from `ctx` - always log with `*Context(ctx, ...)` |
| `handleEcho` | `echo.process` child span with events, `RecordError` + ERROR status, `echo.requests` counter, `echo.message.length` histogram |

Gotcha: `resource.Merge(resource.Default(), resource.NewWithAttributes(semconv.SchemaURL, ...))` panics
("conflicting Schema URL") when your `semconv/vX` import differs from the SDK's - use `NewSchemaless`.
Needs Go >= 1.26 (pulled automatically via `GOTOOLCHAIN=auto`).
