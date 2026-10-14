#!/bin/sh
# Deletes all telemetry: every logs-* / app-logs-* / <service>-YYYY.MM.DD / traces-* / metrics-* data stream and index in Elasticsearch,
# and Jaeger's in-memory traces (container restart). Kibana data views and settings are kept.
#   ./purge-all.sh
#   ELASTIC=http://other:9200 ./purge-all.sh
cd "$(dirname "$0")"
ELASTIC=${ELASTIC:-http://localhost:9200}
PATTERNS='logs-*,app-logs-*,*-otel-api-*,*-otel-worker-*,traces-*,metrics-*'

# names, not wildcards: Elasticsearch refuses wildcard deletes (action.destructive_requires_name)
streams=$(curl -s "$ELASTIC/_data_stream/$PATTERNS" | python3 -c 'import json,sys; print(",".join(d["name"] for d in json.load(sys.stdin)["data_streams"]))')
[ -n "$streams" ] && curl -s -o /dev/null -XDELETE "$ELASTIC/_data_stream/$streams"

indices=$(curl -s "$ELASTIC/_cat/indices/$PATTERNS?format=json&h=index" | python3 -c 'import json,sys; print(",".join(i["index"] for i in json.load(sys.stdin)))')
[ -n "$indices" ] && curl -s -o /dev/null -XDELETE "$ELASTIC/$indices"

echo "data streams: ${streams:-none}" | tr ',' ' '
echo "indices:      ${indices:-none}" | tr ',' ' '
(cd spring-otel/elk && docker compose restart jaeger >/dev/null 2>&1) && echo "jaeger:       restarted (in-memory traces cleared)"
