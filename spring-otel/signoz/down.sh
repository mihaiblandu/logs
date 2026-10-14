#!/bin/sh
# Stops SigNoz. Pass -v to also delete its data volumes.
cd "$(dirname "$0")"
docker compose -f pours/deployment/compose.yaml -f compose.override.yaml down "$@"
