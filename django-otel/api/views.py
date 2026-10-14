import logging
import os
import random
import time

import requests
from django.db import connection
from django.http import JsonResponse
from opentelemetry import baggage, trace
from opentelemetry.trace import StatusCode

from .telemetry import echo_requests, message_length, tracer

log = logging.getLogger(__name__)


def echo(request):
    """Port of the Go/Spring/Laravel/.NET /echo: fails ~10% of the time."""
    message = request.GET.get("message", "")
    span = trace.get_current_span()
    span.set_attribute("echo.message", message)
    span.set_attribute("echo.message_length", len(message))

    if random.randint(0, 99) > 90:
        error = RuntimeError(f"random failure while echoing '{message}'")
        span.record_exception(error)  # span event "exception" with type, message, stacktrace
        span.set_status(StatusCode.ERROR, str(error))
        echo_requests.add(1, {"outcome": "error", "error.type": type(error).__name__})
        log.error("echo failed", extra={"echo.message": message, "http.response.status_code": 500})
        return JsonResponse({"error": "internal error"}, status=500)

    result = _process(message)
    echo_requests.add(1, {"outcome": "ok"})
    message_length.record(len(message))
    log.info("echo ok", extra={"echo.message": message, "http.response.status_code": 200})
    return JsonResponse({"message": result})


def order(request, order_id: int):
    """sqlite3 query span comes from auto-instrumentation."""
    with connection.cursor() as cursor:
        cursor.execute("select %s, %s, %s", [order_id, random.randint(10, 500), "paid"])
        oid, total, status = cursor.fetchone()
    log.info("order loaded", extra={"order.id": oid})
    return JsonResponse({"id": oid, "total": total, "status": status})


def chain(request):
    """Django -> .NET -> Laravel -> Spring: one trace across four services."""
    downstream = os.environ.get("DOWNSTREAM_URL", "http://localhost:5050").rstrip("/")
    # traceparent + baggage are injected by the requests instrumentation; the plain headers are
    # for services that read context from them
    headers = {h: v for h, k in (("X-Request-Id", "request.id"), ("X-User-Id", "user.id"))
               if (v := baggage.get_baggage(k)) is not None}
    response = requests.get(f"{downstream}/api/chain", params={"message": request.GET.get("message", "from-django")},
                            headers=headers, timeout=5)
    log.info("downstream call finished", extra={"downstream.url": downstream, "downstream.status": response.status_code})
    return JsonResponse({"downstream_status": response.status_code, "downstream_body": response.text},
                        status=200 if response.ok else 502)


def _process(message: str) -> str:
    with tracer.start_as_current_span("echo.process") as span:  # child of the server span
        delay = random.randint(5, 50)
        span.add_event("work.started", {"work.planned_ms": delay})
        time.sleep(delay / 1000)  # simulated work, visible as span duration
        span.add_event("work.finished")
        span.set_attribute("work.duration_ms", delay)
        log.debug("processed message", extra={"work.duration_ms": delay})
        return message
