# OpenTelemetry polyglot demo

Seven services implement the same `/echo` API (fails ~10% of the time) with OpenTelemetry traces,
metrics and logs, and the same **request context**: `X-Request-Id` / `X-User-Id` headers (or upstream
W3C baggage) → span attributes, log attributes, baggage; responses return `X-Request-Id` + `X-Trace-Id`.

| Service | Dir | Port | Start |
|---------|-----|------|-------|
| Spring Boot 3.5 (Java) | `spring-otel/` | 4242 | `java -jar target/spring-otel-0.0.1-SNAPSHOT.jar` |
| Laravel 13 (PHP, Docker) | `laravel-otel/` | 8000 | `docker compose up -d --build` |
| ASP.NET Core 9 | `dotnet-otel/` | 5050 | see its README (needs `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`) |
| Django 6 (Python) | `django-otel/` | 8001 | `./run.sh` |
| Go 1.26 `net/http` | `go-otel/` | 4250 | `./go-otel` |
| Express 5 (Node) | `node-otel/` | 3005 | `npm start` |
| original Go server (no OTel) | `utils/` | 4242 | `go run .` |

Every `/api/chain` calls the next one, so one request produces a single trace across six services:

```
curl -H 'X-User-Id: mihai' -H 'X-Request-Id: demo-1' localhost:3005/api/chain
  Node :3005 -> Go :4250 -> Django :8001 -> .NET :5050 -> Laravel :8000 -> Spring :4242
```

`./start-all.sh` starts all six against **ELK** (EDOT collector :4328 → Elasticsearch 9 → Kibana
http://localhost:5601); `OTLP=http://localhost:4318 ./start-all.sh` sends to Grafana LGTM instead. Other
backends live in `spring-otel/`: ClickHouse (:4338), Loki (:4348), SigNoz (:4358). `./stop-all.sh` stops them.
Each service README lists the language-specific gotchas.

## Cascade todo app (JWT + queue job + Vue Flow)

```bash
cd spring-otel/elk && docker compose up -d && cd ../..   # ELK
./start-all.sh                                           # 6 services (Laravel + its queue worker in Docker)
cd todo-vue && npm install && npx vite                   # http://localhost:5173  (demo@example.com / password)
cd e2e && npm install && npx playwright install chromium && npx playwright test
```

- **JWT:** Laravel `POST /api/login` issues an HS256 token (`iss=laravel-otel`, `aud=otel-demo`, `sub`=user id).
  All services validate it with the shared `JWT_SECRET`; a valid token's `sub` becomes `user.id` on spans,
  logs and baggage.
- **Cascade:** creating a todo dispatches `RunTodoCascade` (Laravel queue worker). It walks this tree;
  each node is one service's `POST /api/cascade`, which does its work, then calls its children with the
  same JWT (traceparent + baggage propagate automatically):

  ```
  laravel (job) ─┬─ node ─┬─ go
                 │        └─ django ── spring (spring-a)
                 └─ dotnet ── spring (spring-b)
  ```

  Scenarios: `all-ok`, `fail-django`, `fail-dotnet` (the node fails, its subtree isn't called), `slow`.
- **Vue app** (`todo-vue/`): login, todo CRUD, and the cascade drawn with Vue Flow (the Vue port of
  xyflow) - live status per node, durations on edges, links to the trace in Kibana APM and the logs in Discover.
- **One trace** from `POST /api/todos` through the queue job and all services; logs from every
  service share its `trace_id` and carry the JWT user.
- **Tests:** `laravel-otel/` → `php artisan test` (JWT, todos, job with faked HTTP);
  `e2e/` → Playwright: JWT rejected/accepted by every service, full cascade + trace/log checks
  in Elasticsearch, failure scenario, and the UI graph.

## Telemetry standard (all services)

Set at the source (OTel SDK config) and enforced by the ELK collector (`spring-otel/elk/otel-collector.yaml`).

**Logs** - one JSON document per log record in the daily index `<service.name>-YYYY.MM.DD` (e.g. `spring-otel-api-2026.10.12`), in exactly the structured-log shape from
<https://opentelemetry.io/docs/concepts/signals/logs/> (the collector builds it, Elasticsearch stores it as-is):

```json
{
  "timestamp": "2026-10-11T19:25:50.37347Z",
  "level": "INFO",
  "logger": "app.go-otel",
  "service": "go-otel-api",
  "environment": "local",
  "message": "request completed",
  "trace_id": "4741e404d29f9a61884b88c4e99b99a6",
  "span_id": "45ff23706bc3c8c7",
  "context": { "userId": "1", "username": "Demo User", "ipAddress": "::1" },
  "request": { "method": "POST", "url": "/api/cascade", "body": { "id": "go", "work_ms": 30, "children": [] } },
  "response": { "statusCode": 200, "body": { "id": "go", "status": "ok", "user_id": "1" } }
}
```

- every service writes one `request completed` log per request (INFO, WARN for 4xx, ERROR for 5xx); its
  other logs have the same keys without `request`/`response`, plus `tags` for their own fields
  (e.g. `{"downstream.url": "...", "downstream.status": 200}`)
- `level`: log4j names `INFO WARN ERROR FATAL` (`TRACE`/`DEBUG` are dropped by the collector and never stored); `logger`: Java class, Python module,
  .NET category, `app.<service>` in Go/Node/Laravel
- `trace_id` / `span_id` on every log written during a request; one cascade (API request, queue job, all
  services) shares one `trace_id`
- `context`: `userId`; `username` (JWT `name`); `sub` only for an OAuth2 JWT access token (RFC 9068:
  `client_id`, `scope`/`scp`); `ipAddress`
- not repeated (already in the trace in Jaeger): request id, duration, user agent, headers; trace ids
  inside response bodies are dropped
- bodies: JSON only, up to 4 KB; `password`, `token`, `secret`, `access_token` are stored as `"******"`
- keys without a value are left out

**Traces** - OTel model in `traces-<app>.otel-default` (span events are not stored in Elasticsearch) and
**Jaeger** (in-memory, http://localhost:16686, span events included). Resource: `service.name` (`<app>-otel-api`),
`service.namespace=demo`, `service.version`, `service.instance.id`, `deployment.environment.name=local`,
`team=observability`, `telemetry.sdk.*`. Stable HTTP semconv.

**Metrics** - none stored (the collector accepts and drops them).

Kibana data views: `logs` (`*-otel-api-*,*-otel-worker-*`), `otel-traces`. `./purge-all.sh` deletes all
telemetry (Elasticsearch + Jaeger).

Tests: `cd e2e && npx playwright test` (199 tests: `/echo` contract, JWT, cascade, telemetry standard,
log format, Jaeger, UI).

### ELK notes
- The collector is Elastic's **EDOT** image. No metrics are stored, so the Kibana APM *Services* list
  stays empty; open traces in Jaeger, Discover (`otel-traces`) or the Vue app's links.
- Kibana's **service map** needs a Platinum/trial license; the Vue Flow graph shows the same topology.
- The queue worker uses `OTEL_TRACES_SAMPLER=parentbased_always_off`: jobs keep their dispatcher's
  trace, while the `queue:work` polling loop (a new root span every 0.2s, ~2k spans/15 min) is dropped.

Background: `traces-logs-telemetrie.md`.
