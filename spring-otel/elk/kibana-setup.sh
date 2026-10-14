#!/bin/sh
E=http://elasticsearch:9200
K=http://kibana:5601

# <service.name>-YYYY.MM.DD: one flat JSON document per log record (see transform/log-format in otel-collector.yaml).
# Explicit types for the fixed keys; any other string (context.*) is a keyword.
curl -s -X PUT "$E/_index_template/app-logs" -H 'Content-Type: application/json' -d '{
  "index_patterns": ["*-otel-api-*", "*-otel-worker-*"],
  "priority": 200,
  "template": {
    "settings": { "number_of_replicas": 0 },
    "mappings": {
      "dynamic_templates": [{ "strings": { "match_mapping_type": "string", "mapping": { "type": "keyword", "ignore_above": 1024 } } }],
      "properties": {
        "timestamp": { "type": "date" },
        "level": { "type": "keyword" },
        "logger": { "type": "keyword" },
        "service": { "type": "keyword" },
        "environment": { "type": "keyword" },
        "message": { "type": "text" },
        "trace_id": { "type": "keyword" },
        "span_id": { "type": "keyword" },
        "request": { "properties": { "method": { "type": "keyword" }, "url": { "type": "keyword" } } },
        "response": { "properties": { "statusCode": { "type": "integer" } } },
        "context": { "type": "object" },
        "tags": { "type": "object" }
      }
    }
  }
}' >/dev/null && echo "index template app-logs -> *-otel-api-*, *-otel-worker-*"

until curl -s "$K/api/status" | grep -q '"level":"available"'; do echo "waiting for kibana"; sleep 3; done
curl -s -X DELETE "$K/api/data_views/data_view/otel-metrics" -H 'kbn-xsrf: true' >/dev/null   # no metrics are stored
for v in "logs:*-otel-api-*,*-otel-worker-*:timestamp"; do
  id=${v%%:*}; rest=${v#*:}; pattern=${rest%%:*}; ts=${rest#*:}
  curl -s -X POST "$K/api/data_views/data_view" -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
    -d "{\"override\":true,\"data_view\":{\"id\":\"$id\",\"name\":\"$id\",\"title\":\"$pattern\",\"timeFieldName\":\"$ts\"}}" >/dev/null \
    && echo "data view $id -> $pattern"
done
for old in otel-logs otel-span-events otel-traces; do   # replaced by "logs"; traces are only in Jaeger
  curl -s -X DELETE "$K/api/data_views/data_view/$old" -H 'kbn-xsrf: true' >/dev/null
done
