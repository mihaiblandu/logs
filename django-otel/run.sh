#!/bin/sh
# Starts Django under OpenTelemetry auto-instrumentation (no autoreload: the reloader's child
# process would not be instrumented). Override OTEL_EXPORTER_OTLP_ENDPOINT for other backends.
cd "$(dirname "$0")"
export DJANGO_SETTINGS_MODULE=config.settings
export OTEL_SERVICE_NAME=django-otel-api
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=local,service.namespace=demo,service.version=0.1.0,team=observability"
export OTEL_SEMCONV_STABILITY_OPT_IN=http   # stable HTTP attribute names (http.request.method, ...) like the other services
export OTEL_TRACES_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"
export OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED=true   # Python logging -> OTel logs
export OTEL_PYTHON_LOG_CORRELATION=true                        # otelTraceID/otelSpanID on records (console format)
# info, not debug: at debug the exporter's own urllib3 logs get exported, which logs again (loop)
export OTEL_PYTHON_LOG_LEVEL=info
export DOWNSTREAM_URL="${DOWNSTREAM_URL:-http://localhost:5050}"   # the .NET app
exec uv run opentelemetry-instrument python manage.py runserver "${PORT:-8001}" --noreload
