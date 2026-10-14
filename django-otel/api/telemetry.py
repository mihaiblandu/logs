"""Tracer and instruments for manual instrumentation (auto-instrumentation covers HTTP, DB, requests, logs)."""
from opentelemetry import metrics, trace

SCOPE = "app.django-otel"

tracer = trace.get_tracer(SCOPE)
meter = metrics.get_meter(SCOPE)

echo_requests = meter.create_counter("echo.requests", unit="{request}", description="Echo requests by outcome")
message_length = meter.create_histogram("echo.message.length", unit="{char}", description="Length of echoed messages")
