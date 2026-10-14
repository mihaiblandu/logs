# laravel-otel

Laravel 13 REST API instrumented with OpenTelemetry (traces, metrics, logs over OTLP), with the same
request context as `../spring-otel`. Runs in Docker because auto-instrumentation needs the
`opentelemetry` PHP extension.

```bash
docker compose up -d --build      # app on :8000, sends to the LGTM stack on :4318 by default
curl -i -H 'X-User-Id: mihai' -H 'X-Request-Id: demo-1' 'localhost:8000/api/echo?message=hi'
curl 'localhost:8000/api/orders/42'                       # DB span (+ cache events)
curl -H 'X-User-Id: mihai' 'localhost:8000/api/chain'     # Laravel -> Spring (:4242), one trace
BACKEND_OTLP_ENDPOINT=http://host.docker.internal:4358 docker compose up -d   # send to SigNoz instead
```

| Piece | What it does |
|-------|--------------|
| `opentelemetry-auto-laravel` | server span per request, DB query spans, cache/exception events, HTTP client spans, and **Laravel logs → OTel Logs** (incl. `Log::withContext`) |
| `TelemetryContext` middleware | `X-Request-Id` (generated if missing) / `X-User-Id` → server span attributes, `Log::withContext`, baggage; response gets `X-Request-Id`, `X-Trace-Id` |
| `AppServiceProvider` | global HTTP client middleware: injects `traceparent` + `baggage`, forwards `X-Request-Id`/`X-User-Id` |
| `EchoController` | `echo.process` child span with events, `recordException` + ERROR status on failure, `echo.requests` counter, `echo.message.length` histogram |
| `otel-collector` sidecar | fixes PHP metrics (see below), forwards everything to `BACKEND_OTLP_ENDPOINT` |

## PHP gotchas (found while building this)

- **Metrics:** PHP builds a fresh SDK per request, so each point is "cumulative since this request
  started" (value 1, new start time). Prometheus sees a counter stuck at 1. The sidecar relabels the
  points as delta (`transform`) and re-accumulates (`deltatocumulative`). `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`
  is ignored by the PHP SDK, and a `where metric.type == ...` OTTL condition didn't match in collector 0.130.
- **`process` resource detector is disabled** (`OTEL_PHP_DETECTORS`): under `artisan serve`,
  `process.command` contains the request's query string (leaks data into every span/log, and makes
  every request a separate metric stream); `process.pid` differs per worker.
- `service.instance.id` is fixed (`laravel-1`) so all requests feed one series.
- `opentelemetry-auto-guzzle` was dropped: together with the Laravel HTTP watcher it produced two
  CLIENT spans per call. Propagation is done explicitly in `AppServiceProvider` instead.
- `artisan serve` needs `--no-reload` for `PHP_CLI_SERVER_WORKERS` to take effect.

## Todos, JWT and the cascade

| Endpoint | |
|----------|-|
| `POST /api/login` | `{email, password}` → `{token, user}` (demo: `demo@example.com` / `password`, seeded at startup) |
| `GET/POST /api/todos`, `GET/PATCH/DELETE /api/todos/{id}` | JWT required; creating a todo dispatches `RunTodoCascade` |
| `POST /api/todos/{id}/run` | re-run the cascade (optionally another `scenario`) |
| `GET /api/cascade/plan?scenario=` | the planned tree, for drawing the graph before results exist |

- `app/Cascade/CascadePlan.php` defines the tree, `CascadeRunner.php` runs Laravel's node and calls the children.
- The `queue` container runs `php artisan queue:work`; jobs get a fresh short-lived JWT for the todo's owner.
- `php artisan test` runs on the host (warnings about the missing `opentelemetry` extension are harmless there).
