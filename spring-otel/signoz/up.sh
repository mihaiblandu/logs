#!/bin/sh
# Regenerates the SigNoz deployment from casting.yaml and starts it with our port override.
set -e
cd "$(dirname "$0")"
.bin/foundryctl forge -f casting.yaml --no-ledger --no-updater
docker compose -f pours/deployment/compose.yaml -f compose.override.yaml up -d
