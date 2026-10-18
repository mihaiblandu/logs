#!/bin/sh
E=http://elasticsearch:9200
K=http://kibana:5601

# <service.name>-YYYY.MM.DD: one flat JSON document per log record (see transform/log-format in otel-collector.yaml).
# Explicit types for the fixed keys. Full-text search: message is analyzed text (+ message.keyword for exact
# match / aggregations); any other string (context.*, tags.*, bodies) is a keyword with a .text subfield.
# priority 250: Kibana's .fleet-fileds-* templates use 200 and overlap these wildcard patterns
# --fail-with-body: a rejected template must not pass silently
curl -s --fail-with-body -X PUT "$E/_index_template/app-logs" -H 'Content-Type: application/json' -d '{
  "index_patterns": ["*-otel-api-*", "*-otel-worker-*"],
  "priority": 250,
  "template": {
    "settings": { "number_of_replicas": 0 },
    "mappings": {
      "dynamic_templates": [{ "strings": { "match_mapping_type": "string", "mapping": {
        "type": "keyword", "ignore_above": 1024,
        "fields": { "text": { "type": "match_only_text" } } } } }],
      "properties": {
        "timestamp": { "type": "date" },
        "level": { "type": "keyword" },
        "logger": { "type": "keyword" },
        "service": { "type": "keyword" },
        "environment": { "type": "keyword" },
        "message": { "type": "text", "fields": { "keyword": { "type": "keyword", "ignore_above": 1024 } } },
        "trace_id": { "type": "keyword" },
        "span_id": { "type": "keyword" },
        "request": { "properties": { "method": { "type": "keyword" }, "url": { "type": "keyword" } } },
        "response": { "properties": { "statusCode": { "type": "integer" } } },
        "context": { "type": "object" },
        "tags": { "type": "object" }
      }
    }
  }
}' >/dev/null && echo "index template app-logs -> *-otel-api-*, *-otel-worker-*" || { echo "index template app-logs FAILED"; exit 1; }

until curl -s "$K/api/status" | grep -q '"level":"available"'; do echo "waiting for kibana"; sleep 3; done
for v in "logs:*-otel-api-*,*-otel-worker-*:timestamp" "otel-traces:traces-*.otel-*:@timestamp" "otel-metrics:metrics-*.otel-*:@timestamp"; do
  id=${v%%:*}; rest=${v#*:}; pattern=${rest%%:*}; ts=${rest#*:}
  curl -s -X POST "$K/api/data_views/data_view" -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
    -d "{\"override\":true,\"data_view\":{\"id\":\"$id\",\"name\":\"$id\",\"title\":\"$pattern\",\"timeFieldName\":\"$ts\"}}" >/dev/null \
    && echo "data view $id -> $pattern"
done
for old in otel-logs otel-span-events; do   # replaced by "logs"
  curl -s -X DELETE "$K/api/data_views/data_view/$old" -H 'kbn-xsrf: true' >/dev/null
done
