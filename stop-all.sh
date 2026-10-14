#!/bin/sh
# Stops the six demo services started by start-all.sh (backends keep running).
cd "$(dirname "$0")"
for p in 4242 5050 8001 4250 3005; do
  pid=$(lsof -nP -tiTCP:$p -sTCP:LISTEN 2>/dev/null) && [ -n "$pid" ] && kill $pid 2>/dev/null
done
(cd laravel-otel && docker compose stop >/dev/null 2>&1)
echo stopped
