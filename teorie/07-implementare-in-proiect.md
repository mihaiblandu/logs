# 7. Implementarea din proiect

<!-- cuprins -->
**Cuprins**

- [7.1 Fluxul](#71-fluxul)
- [7.2 Formatul unui log](#72-formatul-unui-log)
- [7.3 Cine face ce](#73-cine-face-ce)
- [7.4 Cum folosești](#74-cum-folosești)
- [7.5 Testele](#75-testele)
- [7.6 De reținut pentru alt proiect](#76-de-reținut-pentru-alt-proiect)
<!-- /cuprins -->

## 7.1 Fluxul

```mermaid
flowchart LR
  subgraph S[6 servicii]
    SP[Spring :4242] & LA[Laravel :8000] & DJ[Django :8001] & DN[.NET :5050] & GO[Go :4250] & NO[Node :3005]
  end
  S -->|OTLP http :4328<br/>logs, traces, metrics| C[EDOT Collector<br/>spring-otel/elk/otel-collector.yaml]
  C -->|logs: document plat<br/>&lt;service&gt;-YYYY.MM.DD| ES[(Elasticsearch :9200)]
  C -->|traces| J[Jaeger :16686]
  C -.->|metrics: aruncate| X[nop]
  ES --> K[Kibana :5601<br/>data view „logs"]
```

- **Logurile** → Elasticsearch, câte un index pe aplicație și pe zi, `[app-name]-[data]`: `spring-otel-api-2026.10.12`, `laravel-otel-worker-2026.10.12`, …
- **Trace-urile** → doar Jaeger (nu se salvează în Elasticsearch).
- **Metricile** → collectorul le primește și le aruncă (nu se stochează).

## 7.2 Formatul unui log

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
  "request": { "method": "POST", "url": "/api/cascade", "body": { "id": "go", "work_ms": 30 } },
  "response": { "statusCode": 200, "body": { "id": "go", "status": "ok" } }
}
```

| Cheie | De unde vine |
|-------|--------------|
| `timestamp` | timpul înregistrării (sau cel observat, dacă bridge-ul nu-l pune — PHP) |
| `level` | nume log4j calculat din `severity_number` |
| `logger` | scope-ul OTel (clasă Java, modul Python, categorie .NET) sau `log.logger` setat de serviciu (Go/Node/Laravel: `app.<serviciu>`) |
| `service`, `environment` | resursa: `service.name`, `deployment.environment.name` |
| `message` | corpul logului |
| `trace_id`, `span_id` | contextul activ — pe orice log scris în timpul unei cereri |
| `context.userId` | `sub` din JWT, altfel `X-User-Id`, altfel baggage din serviciul anterior |
| `context.username` | claim-ul `name` din JWT |
| `context.sub` | doar pentru un **JWT de acces OAuth2** (RFC 9068: are `client_id` sau `scope`/`scp`) |
| `context.ipAddress` | adresa clientului |
| `request`, `response` | doar pe logul „request completed": metodă, URL, status, corpuri JSON ≤ 4 KB |
| `tags` | câmpurile proprii ale logului (`echo.message`, `downstream.status`, `todo.id`) |

**Ce nu apare (redundant sau periculos):** request id, durată, user agent, header-e (sunt în trace, în Jaeger);
`trace_id`/`span_id` din corpul răspunsului; `host.*`, `process.*`, `code.*`; zgomot de framework
(`{OriginalFormat}`, `ConnectionId`…); secrete — `password`, `token`, `secret`, `access_token` devin `"******"`.

## 7.3 Cine face ce

1. **Serviciile** (la sursă):
   - resursa comună: `service.name=<app>-otel-api`, `service.namespace=demo`, `service.version`,
     `service.instance.id`, `deployment.environment.name=local`, fără detectoare host/os/process;
   - un middleware per serviciu scrie logul **„request completed"** (INFO, WARN pentru 4xx, ERROR pentru 5xx)
     cu metoda, ruta, statusul, IP-ul, utilizatorul și corpurile JSON;
   - `request.id` / `user.id` din baggage pe toate logurile (MDC, `Log::withContext`, scope-uri .NET, mixin pino…).
2. **Collectorul** (`filter/no-debug` + `transform/standard` + `transform/log-format`):
   - aruncă `DEBUG` / `TRACE` — în Elasticsearch ajung doar `INFO`, `WARN`, `ERROR`, `FATAL`;
   - niveluri log4j, scoate zgomotul și atributele interzise;
   - construiește documentul plat de mai sus, maschează secretele, alege indexul `<service.name>-YYYY.MM.DD` (ziua UTC a logului);
   - exporterul `elasticsearch` cu `mapping.mode: bodymap` salvează documentul exact așa.
3. **Elasticsearch**: index template `app-logs` pe tiparele `*-otel-api-*`, `*-otel-worker-*` (tipuri pentru câmpurile fixe; orice alt text = `keyword`),
   creat de `spring-otel/elk/kibana-setup.sh`, împreună cu data view-ul `logs` în Kibana.

## 7.4 Cum folosești

```bash
cd spring-otel/elk && docker compose up -d && cd ../..   # Elasticsearch, Kibana, collector, Jaeger
./start-all.sh                                           # cele 6 servicii
curl -H 'X-User-Id: johndoe' localhost:3005/api/chain    # o cerere prin toate serviciile
```

- Kibana → Discover → data view **logs**: `trace_id:"<X-Trace-Id>"` arată logurile tuturor serviciilor
  pentru cererea respectivă; `level:ERROR`, `response.statusCode >= 500`, `context.userId:"1"`.
- Jaeger → `http://localhost:16686/trace/<X-Trace-Id>`.
- `./purge-all.sh` șterge toate datele (Elasticsearch + Jaeger).

## 7.5 Testele

`cd e2e && npx playwright test` verifică standardul pentru fiecare serviciu: forma exactă a documentului,
nivelurile, `logger`, `trace_id`/`span_id` care trimit la un span real din Jaeger, `sub` doar pentru
tokenuri OAuth2, mascarea parolei/tokenului la login, lipsa câmpurilor redundante, a metricilor și a
trace-urilor în Elasticsearch.

## 7.6 De reținut pentru alt proiect

1. Alege **un format** și scrie-l (ca tabelul de mai sus) înainte de cod.
2. Pune-l **la sursă** (SDK, middleware) și **în collector** (plasă de siguranță pentru toate limbajele).
3. Corelează prin `trace_id`; nu dubla în log ce e deja în trace.
4. Nu loga secrete; maschează înainte să ajungă în stocare.
5. Testează formatul automat — altfel se strică la primul serviciu nou.

<!-- nav -->
---
[← 6. ELK și OpenSearch](06-elk-opensearch.md) · [Cuprins](README.md)
<!-- /nav -->
