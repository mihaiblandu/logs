# dotnet-otel

ASP.NET Core (.NET 9) minimal API with OpenTelemetry traces, metrics and logs over OTLP, with the same
request context as `../spring-otel` and `../laravel-otel`.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
ASPNETCORE_URLS=http://localhost:5050 dotnet run
curl -i -H 'X-User-Id: mihai' -H 'X-Request-Id: demo-1' 'localhost:5050/api/echo?message=hi'
curl -H 'X-User-Id: mihai' 'localhost:5050/api/chain'   # .NET -> Laravel (:8000) -> Spring (:4242), one trace
```

Note: the .NET exporter defaults to gRPC on 4317; set `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` for 4318.

| Piece | What it does |
|-------|--------------|
| `AddAspNetCoreInstrumentation` / `AddHttpClientInstrumentation` | server + client spans and HTTP metrics; HttpClient injects `traceparent` + `baggage` |
| `TelemetryContextMiddleware` | `X-Request-Id` / `X-User-Id` (or upstream baggage) → span tags, `ILogger.BeginScope`, `Baggage`; response gets `X-Request-Id`, `X-Trace-Id` |
| `WithLogging(..., IncludeScopes = true)` | every `ILogger` record carries `request.id`, `user.id`, `trace_id`; message template args (`{echo.message}`) become attributes |
| `ContextForwardingHandler` | adds `X-Request-Id` / `X-User-Id` to outgoing calls for services that read plain headers |
| `/api/echo` | `echo.process` child span with events, `AddException` + ERROR status on failure, `echo.requests` counter, `echo.message.length` histogram |
