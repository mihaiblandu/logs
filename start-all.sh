#!/bin/sh
# Starts the shared agent collector (otel-collector/, OTLP :4308) and the six demo services, which all
# send to it; the agent forwards to one OTLP backend (default: ELK via the EDOT collector).
#   ./start-all.sh                                   # ELK      (Kibana http://localhost:5601)
#   OTLP=http://localhost:4318 ./start-all.sh        # LGTM     (Grafana http://localhost:3000)
#   SIGNOZ=1 ./start-all.sh                          # ELK + a copy of everything to SigNoz (http://localhost:8080)
# Backends themselves are started separately (spring-otel/elk, spring-otel/docker-compose.yml, ...).
set -e
cd "$(dirname "$0")"
ROOT=$PWD
OTLP=${OTLP:-http://localhost:4328}   # the backend; services never send to it directly
DOCKER_OTLP=$(echo "$OTLP" | sed 's/localhost/host.docker.internal/')
AGENT=http://localhost:4308           # the shared agent collector
export JWT_SECRET=${JWT_SECRET:-dev-only-shared-secret-change-me-0123456789abcdef}
export OTEL_EXPORTER_OTLP_ENDPOINT=$AGENT OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_METRIC_EXPORT_INTERVAL=15000

"$ROOT/stop-all.sh" >/dev/null 2>&1 || true

AGENT_EXTRA=extra-none
[ -n "$SIGNOZ" ] && AGENT_EXTRA=extra-signoz
echo "OTLP -> agent collector $AGENT -> $OTLP${SIGNOZ:+ + SigNoz http://localhost:4358}"
(cd otel-collector && BACKEND_OTLP_ENDPOINT=$DOCKER_OTLP AGENT_EXTRA=$AGENT_EXTRA docker compose up -d >/dev/null 2>&1)
(cd spring-otel && SERVER_PORT=4242 nohup java -jar target/spring-otel-0.0.1-SNAPSHOT.jar > app.log 2>&1 &)
(cd dotnet-otel && ASPNETCORE_URLS=http://localhost:5050 nohup dotnet bin/Debug/net9.0/dotnet-otel.dll > app.log 2>&1 &)
(cd django-otel && nohup ./run.sh > app.log 2>&1 &)
(cd go-otel && nohup ./go-otel > app.log 2>&1 &)
(cd node-otel && nohup node --require ./instrumentation.js app.js > app.log 2>&1 &)
(cd laravel-otel && docker compose up -d --remove-orphans >/dev/null 2>&1)

wait_for() { # name url
  i=0
  until curl -s -o /dev/null --max-time 2 "$2"; do
    i=$((i + 1)); [ $i -gt 90 ] && { echo "  $1: NOT UP ($2)"; return 1; }
    sleep 1
  done
  echo "  $1: up"
}
wait_for spring  "http://localhost:4242/echo?message=up"
wait_for dotnet  "http://localhost:5050/api/echo?message=up"
wait_for django  "http://localhost:8001/api/echo?message=up"
wait_for go      "http://localhost:4250/api/echo?message=up"
wait_for node    "http://localhost:3005/api/echo?message=up"
wait_for laravel "http://localhost:8000/up"
