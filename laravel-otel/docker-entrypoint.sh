#!/bin/sh
# Runs migrations + demo seed (idempotent; skipped with SKIP_MIGRATIONS=1), then the given command.
set -e
touch database/database.sqlite
# only one container migrates: app and queue share the sqlite file, and running both at once fails
# ("duplicate column") and kills the worker
if [ "${SKIP_MIGRATIONS:-}" != "1" ]; then
  php artisan migrate --force --no-interaction >/dev/null
  php artisan db:seed --force --no-interaction >/dev/null
fi
exec "$@"
