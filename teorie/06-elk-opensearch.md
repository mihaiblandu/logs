# 6. ELK și OpenSearch

<!-- cuprins -->
**Cuprins**

- [6.1 ELK / Elastic Stack](#61-elk--elastic-stack)
- [6.2 OpenSearch](#62-opensearch)
- [6.3 Concepte de bază](#63-concepte-de-bază)
- [6.4 Implementare pas cu pas](#64-implementare-pas-cu-pas)
- [6.5 Mărime și performanță (reguli orientative)](#65-mărime-și-performanță-reguli-orientative)
- [6.6 Alternative](#66-alternative)
<!-- /cuprins -->

## 6.1 ELK / Elastic Stack

**ELK** = **E**lasticsearch + **L**ogstash + **K**ibana; azi se numește *Elastic Stack* și include și
Beats / Elastic Agent.

| Componentă | Rol |
|------------|-----|
| **Elasticsearch** | motor de căutare și analiză distribuit (bazat pe Apache Lucene): stochează documente JSON în indexuri și le face căutabile full-text și pe câmpuri |
| **Logstash** | pipeline de procesare: input → filter (grok, mutate, geoip) → output; greu (JVM), puternic |
| **Kibana** | interfața: Discover (căutare loguri), dashboard-uri, alerte, APM |
| **Beats** (Filebeat…) / **Elastic Agent** | agenți ușori care citesc fișiere / stdout și trimit mai departe |

Varianta modernă înlocuiește des Logstash/Beats cu **OpenTelemetry Collector**, care trimite direct în
Elasticsearch (exporterul `elasticsearch`).

## 6.2 OpenSearch

**OpenSearch** este un fork open-source al Elasticsearch 7.10.2 și Kibana 7.10.2, pornit de AWS în 2021,
după ce Elastic a schimbat licența (din Apache 2.0 în SSPL / Elastic License). Azi e sub Linux Foundation
(OpenSearch Software Foundation), licență Apache 2.0.

| Elastic | OpenSearch |
|---------|------------|
| Elasticsearch | OpenSearch |
| Kibana | OpenSearch Dashboards |
| Logstash / Beats / Elastic Agent | Data Prepper, Fluent Bit, Logstash (cu plugin OpenSearch), OTel Collector |
| ILM (Index Lifecycle Management) | ISM (Index State Management) |
| Security (în licențele plătite, parțial gratuit) | Security plugin inclus |
| Elastic APM | Trace Analytics (prin Data Prepper / OTel) |

API-urile de bază (index, search, mapping, bulk) sunt foarte apropiate; din 2021 cele două au evoluat separat,
așa că versiunile noi nu mai sunt interschimbabile 1:1.

**Cum alegi:** Elastic dacă vrei funcțiile lor avansate (APM, ML, EDOT) și accepți licența/abonamentul;
OpenSearch dacă vrei complet open-source (Apache 2.0) sau rulezi pe AWS (Amazon OpenSearch Service).

## 6.3 Concepte de bază

| Concept | Ce este |
|---------|---------|
| **Document** | un obiect JSON (un log = un document) |
| **Index** | colecție de documente cu același mapping; ex. `go-otel-api-2026.10.12` (`[app-name]-[data]`, un index pe zi) |
| **Mapping** | schema: tipul fiecărui câmp (`date`, `keyword`, `text`, `long`, `object`) |
| **keyword vs text** | `keyword` = valoare exactă (filtre, agregări: `level`, `service`); `text` = analizat pentru căutare full-text (`message`) |
| **Index template** | mapping + setări aplicate automat indexurilor noi după un tipar (`*-otel-api-*`) |
| **Shard / replică** | indexul e împărțit în shard-uri (paralelism); replicile sunt copii pentru toleranță la erori |
| **Data stream** | un nume logic peste mai multe indexuri create în timp (rollover), doar adăugare, cu `@timestamp` obligatoriu — potrivit pentru loguri |
| **Rollover** | indexul activ se închide la o mărime/vârstă și se creează altul |
| **ILM / ISM** | politici de viață: hot → warm → cold → delete după N zile |
| **Ingest pipeline** | procesare în Elasticsearch la indexare (parsare, câmpuri noi) |

## 6.4 Implementare pas cu pas

### 1. Pornește clusterul (dev, un singur nod)

Elastic (cum e în `spring-otel/elk/docker-compose.yml`):

```yaml
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:9.1.0
    environment: [discovery.type=single-node, xpack.security.enabled=false, ES_JAVA_OPTS=-Xms1g -Xmx1g]
    ports: ["9200:9200"]
  kibana:
    image: docker.elastic.co/kibana/kibana:9.1.0
    environment: [ELASTICSEARCH_HOSTS=http://elasticsearch:9200]
    ports: ["5601:5601"]
```

OpenSearch:

```yaml
services:
  opensearch:
    image: opensearchproject/opensearch:2.19.1
    environment:
      - discovery.type=single-node
      - DISABLE_SECURITY_PLUGIN=true          # doar local!
      - OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g
    ports: ["9200:9200"]
  dashboards:
    image: opensearchproject/opensearch-dashboards:2.19.1
    environment: [OPENSEARCH_HOSTS=["http://opensearch:9200"], DISABLE_SECURITY_DASHBOARDS_PLUGIN=true]
    ports: ["5601:5601"]
```

În producție: securitatea **pornită** (TLS + utilizatori/roluri), minimum 3 noduri, replici ≥ 1.

### 2. Definește formatul și mapping-ul (index template)

Hotărăște întâi standardul de câmpuri (vezi [07](07-implementare-in-proiect.md)), apoi tipurile:

```json
PUT _index_template/app-logs
{
  "index_patterns": ["*-otel-api-*", "*-otel-worker-*"],
  "template": {
    "mappings": {
      "dynamic_templates": [{ "strings": { "match_mapping_type": "string", "mapping": { "type": "keyword" } } }],
      "properties": {
        "timestamp": { "type": "date" },
        "level":     { "type": "keyword" },
        "logger":    { "type": "keyword" },
        "service":   { "type": "keyword" },
        "message":   { "type": "text" },
        "trace_id":  { "type": "keyword" },
        "response":  { "properties": { "statusCode": { "type": "integer" } } }
      }
    }
  }
}
```

Același API funcționează în OpenSearch (`PUT _index_template/...`).

### 3. Trimite logurile

Variante:

| Cale | Când |
|------|------|
| SDK OTel → **OTel Collector** → exporter `elasticsearch` / `opensearch` | aplicații noi, corelare cu traces — **recomandat** |
| stdout → **Fluent Bit / Filebeat** → Elasticsearch / OpenSearch | aplicații existente, Kubernetes |
| fișiere / syslog → **Logstash** sau **Data Prepper** → stocare | parsare grea, surse vechi |

Collector → OpenSearch (exporterul din *contrib*):

```yaml
exporters:
  opensearch:
    http: { endpoint: https://opensearch:9200 }
    logs_index: app-logs
```

Collector → Elasticsearch (cum e în proiect, documentul = corpul logului):

```yaml
exporters:
  elasticsearch/logs:
    endpoints: [http://elasticsearch:9200]
    mapping: { mode: bodymap }
```

### 4. Retenție

Elastic (ILM):

```json
PUT _ilm/policy/logs-14d
{ "policy": { "phases": {
  "hot":    { "actions": { "rollover": { "max_age": "1d", "max_primary_shard_size": "30gb" } } },
  "delete": { "min_age": "14d", "actions": { "delete": {} } } } } }
```

OpenSearch (ISM): `PUT _plugins/_ism/policies/logs-14d` cu stări `hot` → `delete` și o tranziție
`min_index_age: 14d`.

### 5. Vizualizare și alerte

- Kibana: *Data view* `*-otel-api-*,*-otel-worker-*` cu câmpul de timp `timestamp` → **Discover**: `level:ERROR and service:go-otel-api`
- OpenSearch Dashboards: *Index pattern* echivalent → **Discover**, **Alerting** (monitor pe interogare)
- Alerte tipice: rata de `ERROR` pe serviciu, 5xx în `response.statusCode`, `WARN` 401 în rafală (atac)

## 6.5 Mărime și performanță (reguli orientative)

- index zilnic `[app-name]-[data]`: retenția devine simplă (ștergi zilele vechi), dar fiecare zi = încă un shard —
  ține 1 shard primar / index la aplicații mici;
- shard-uri de ~10–50 GB; nu crea mii de shard-uri mici (un index pe zi pe serviciu mic e prea mult);
- `keyword` pentru tot ce filtrezi/agregi, `text` doar unde chiar cauți full-text;
- limitează câmpurile dinamice (explozia de mapping): pune detaliile variabile într-un obiect (`tags`);
- heap JVM ~50% din RAM, maximum ~31 GB;
- trimite în batch (bulk API) — collectorul face asta (`batch`, `flush`).

## 6.6 Alternative

| Sistem | Idee |
|--------|------|
| **Grafana Loki** | indexează doar etichetele, nu conținutul — ieftin, căutare mai lentă (în `spring-otel/loki`) |
| **ClickHouse** | bază columnară, foarte rapidă și ieftină la volum mare (în `spring-otel/clickhouse`) |
| **SigNoz** | platformă OTel-nativă pe ClickHouse (în `spring-otel/signoz`) |

<!-- nav -->
---
[← 5. OpenTelemetry](05-opentelemetry.md) · [Cuprins](README.md) · [7. Implementarea din proiect →](07-implementare-in-proiect.md)
<!-- /nav -->
