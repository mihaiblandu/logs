# spring-otel

Spring Boot port of `../utils` (the Go `/echo` server), instrumented with the
[OpenTelemetry Spring Boot starter](https://opentelemetry.io/docs/zero-code/java/spring-boot-starter/).
It exports **traces, metrics and logs** over OTLP.

## Run

```bash
docker compose up -d                 # Grafana LGTM stack (OTLP on 4317/4318, UI on 3000)
mvn spring-boot:run                  # app on :4242
curl 'localhost:4242/echo?message=hello'
```

Open http://localhost:3000 → Explore:
- **Tempo**: traces `GET /echo` → child span `echo.process`; failed requests (~10%) have status ERROR
- **Loki**: `{service_name="spring-otel-api"}`, each log line carries `trace_id` → jump to the trace
- **Prometheus**: `echo_requests_total` split by `outcome`, plus `http_server_request_duration_seconds_*`

Without Docker, print everything to the console:

```bash
OTEL_TRACES_EXPORTER=console OTEL_METRICS_EXPORTER=console OTEL_LOGS_EXPORTER=none mvn spring-boot:run
```

## What produces what

| Signal  | Source |
|---------|--------|
| Traces  | auto: HTTP server span (Spring MVC); manual: `@WithSpan` in `EchoService`, attributes/status in `EchoController` |
| Metrics | auto: HTTP server duration, JVM; manual: `echo.requests` counter |
| Logs    | auto: Logback appender sends logs via OTLP; `trace_id`/`span_id` added to MDC (see console pattern) |

## Request context

Send `X-User-Id` / `X-Request-Id` (generated if missing); the response returns `X-Request-Id` and `X-Trace-Id`:

```bash
curl -i -H 'X-User-Id: mihai' -H 'X-Request-Id: demo-123' 'localhost:4242/echo?message=hi'
```

| Where | Context added |
|-------|---------------|
| Every signal (resource) | `service.namespace`, `team`, `deployment.environment.name` (`APP_ENV`) |
| `GET /echo` span | `request.id`, `user.id`, `client.address`, `echo.message`, `echo.message.length`; on failure an `exception` event + ERROR status |
| `echo.process` span | `work.duration_ms`, events `work.started` / `work.finished` |
| Logs | MDC `request.id`, `user.id` + key-values (`echo.message`, `http.response.status_code`), code location, thread |
| Baggage | `request.id`, `user.id` (propagated to downstream calls) |
| Metrics | `echo.requests{outcome, error.type}`, `echo.message.length` histogram |

Loki examples: `{service_name="spring-otel-api"} | user_id="mihai"`, `{service_name="spring-otel-api"} | detected_level="ERROR"`.

## Backend variants

The app is unchanged; only `OTEL_EXPORTER_OTLP_ENDPOINT` changes. All stacks can run at the same time.

| Variant | Start | OTLP endpoint | UI | Stores |
|---------|-------|---------------|----|--------|
| Grafana LGTM | `docker compose up -d` | `http://localhost:4318` | http://localhost:3000 (admin/admin) | logs (Loki), traces (Tempo), metrics (Prometheus) |
| ELK | `cd elk && docker compose up -d` | `http://localhost:4328` | Kibana http://localhost:5601 | logs, traces, metrics in Elasticsearch 9 |
| ClickHouse | `cd clickhouse && docker compose up -d` | `http://localhost:4338` | Grafana http://localhost:3001, SQL http://localhost:8123/play (default/otel) | logs, traces, metrics in ClickHouse tables |
| Loki only | `cd loki && docker compose up -d` | `http://localhost:4348` | Grafana http://localhost:3002 | logs only (traces/metrics dropped) |

```bash
SERVER_PORT=4243 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4328 java -jar target/spring-otel-0.0.1-SNAPSHOT.jar  # ELK
SERVER_PORT=4244 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4338 java -jar target/spring-otel-0.0.1-SNAPSHOT.jar  # ClickHouse
SERVER_PORT=4245 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4348 java -jar target/spring-otel-0.0.1-SNAPSHOT.jar  # Loki
```

### ELK notes
- The Collector `elasticsearch` exporter in `otel` mapping mode writes to data streams `logs-generic.otel-default`, `traces-generic.otel-default`, `metrics-generic.otel-default`. This needs Elasticsearch 9 and Collector >= 0.122. With 8.x / 0.120, traces fail with `index_not_found_exception`.
- `cumulativetodelta` is required because Elasticsearch drops cumulative histograms.
- `kibana-setup` creates the data views `otel-logs`, `otel-traces`, `otel-metrics` (Kibana → Discover). KQL: `attributes.user.id : "mihai"`.

### ClickHouse notes
- `CLICKHOUSE_DB=otel` must exist before the exporter starts (it does not create the db it connects to).
- Tables: `otel_logs`, `otel_traces`, `otel_metrics_{sum,gauge,histogram,...}`.

```sql
-- log -> trace correlation
SELECT Timestamp, SeverityText, Body, LogAttributes['user.id'] AS user, TraceId
FROM otel.otel_logs WHERE LogAttributes['request.id'] = 'demo-123';

SELECT SpanName, Duration / 1e6 AS ms, StatusCode
FROM otel.otel_traces WHERE TraceId = '<trace id>' ORDER BY Timestamp;

-- p95 latency per minute
SELECT toStartOfMinute(Timestamp) AS t, quantile(0.95)(Duration) / 1e6 AS p95_ms
FROM otel.otel_traces WHERE SpanName = 'GET /echo' GROUP BY t ORDER BY t;
```

## SigNoz variant (ClickHouse-backed)

SigNoz now installs only through **Foundry** (`foundryctl`); the repo no longer ships compose files.
`signoz/casting.yaml` is the input, `foundryctl forge` generates `signoz/pours/` (don't edit it),
and `compose.override.yaml` moves OTLP to 4357/4358 so it can run next to LGTM.

```bash
signoz/up.sh                      # forge + docker compose up (UI http://localhost:8080)
SERVER_PORT=4246 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4358 java -jar target/spring-otel-0.0.1-SNAPSHOT.jar
signoz/down.sh                    # stop (add -v to delete data)
```

- **First run:** create the admin account at http://localhost:8080. Until an organization exists,
  the ingester gets no config over OpAMP (`cannot create agent without orgId`) and traces/logs are not stored.
- After sign-up the ingester restarts its pipelines; exports during those few seconds fail (`Connection reset`) and are dropped.
- Data lives in SigNoz's own ClickHouse (`signoz_traces`, `signoz_logs`, `signoz_metrics`):

```bash
docker exec signoz-telemetrystore-clickhouse-0-0 clickhouse-client -q \
  "SELECT body, attributes_string['user.id'], trace_id FROM signoz_logs.distributed_logs_v2 WHERE attributes_string['request.id']='demo-123'"
```

## Load test: 1M logs

```bash
curl -X POST 'localhost:4246/load/logs?count=1000000&rate=5000'   # starts in background
curl localhost:4246/load/status                                   # {"emitted":..., "done":...}
```

`LoadController` writes through the OTel Logs API (not SLF4J, so the console isn't flooded); every 5 logs share
one trace (`load /orders`, ...). Attributes: `load.run_id`, `user.id` (50 users), `request.id`, `http.route`,
`http.response.status_code`, `latency_ms`; ~5% of traces end in an ERROR log.

**Pick the rate for the backend.** The SDK drops logs silently when its queue is full (no error in the app log).
With SigNoz on a laptop, 20k/s lost 13% (130,177 of 1M); 5k/s lost nothing. Drops show up as the SDK metric
`processedLogs{dropped="true"}`; check the real count in ClickHouse:

```bash
docker exec signoz-telemetrystore-clickhouse-0-0 clickhouse-client -q \
  "SELECT attributes_string['load.run_id'] run, count() FROM signoz_logs.distributed_logs_v2 GROUP BY run"
```
