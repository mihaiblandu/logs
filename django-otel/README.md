# django-otel

Django 6 REST API under OpenTelemetry auto-instrumentation (`opentelemetry-instrument`), with the
same request context as the Spring / Laravel / .NET apps.

```bash
./run.sh                                  # :8001, sends to the agent collector (:4308); OTEL_EXPORTER_OTLP_ENDPOINT to change
curl -i -H 'X-User-Id: mihai' -H 'X-Request-Id: demo-1' 'localhost:8001/api/echo?message=hi'
curl 'localhost:8001/api/orders/5'                       # sqlite query span
curl -H 'X-User-Id: mihai' 'localhost:8001/api/chain'    # Django -> .NET -> Laravel -> Spring, one trace
```

| Piece | What it does |
|-------|--------------|
| `opentelemetry-instrument` + `opentelemetry-bootstrap` packages | server spans (django/wsgi), `requests` client spans with `traceparent` + `baggage`, sqlite3 query spans, Python `logging` → OTel logs |
| `api/middleware.py` | `X-Request-Id` / `X-User-Id` (or upstream baggage) → span attributes + baggage; response gets `X-Request-Id`, `X-Trace-Id` |
| `api/logging.py` `ContextLogFilter` | copies `request.id` / `user.id` from baggage onto every log record → log attributes (added to the root OTel handler in `ApiConfig.ready`) |
| `log.info("echo ok", extra={"echo.message": ...})` | `extra` keys become log attributes |
| `api/views.py` | `echo.process` child span with events, `record_exception` + ERROR status, `echo.requests` counter, `echo.message.length` histogram |

## Gotchas

- `runserver --noreload`: the autoreloader's child process is not instrumented.
- `OTEL_PYTHON_LOG_LEVEL=info`, not `debug`: at debug the exporter's own `urllib3` request logs are
  exported too, and each export logs again (a self-feeding loop, ~1 log/s).
- Don't configure the `root` logger in `LOGGING`: `dictConfig` would remove the OTel handler.
- sqlite3 queries show two nested CLIENT spans (Django's cursor wrapper + the DB-API cursor); the
  Django instrumentation itself creates none, so disabling sqlite3 removes DB spans entirely.
