"""
POST /api/cascade: same contract in every demo service. Runs a "cascade <id>" span with simulated
work, then calls each child's /api/cascade (in parallel) with the caller's JWT; traceparent + baggage
are injected by the requests instrumentation.
"""
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from opentelemetry import context, trace
from opentelemetry.trace import StatusCode

from .auth import verify_bearer
from .telemetry import tracer

SERVICE = "django"
log = logging.getLogger(__name__)
pool = ThreadPoolExecutor(max_workers=8)


@csrf_exempt
@require_POST
def cascade(request):
    token, claims, error = verify_bearer(request.headers.get("Authorization"))
    if claims is None:
        trace.get_current_span().add_event("auth.failed", {"auth.error": error})
        log.warning("cascade rejected: invalid token", extra={"auth.error": error})
        return JsonResponse({"error": "unauthorized", "reason": error}, status=401)

    spec = json.loads(request.body or b"{}")
    user_id = str(claims["sub"])
    with tracer.start_as_current_span(f"cascade {spec['id']}", attributes={
        "cascade.node": spec["id"], "cascade.service": SERVICE, "user.id": user_id,
    }) as span:
        started = time.monotonic()
        time.sleep(int(spec.get("work_ms", 0)) / 1000)  # simulated work
        status, err, children = "ok", None, []
        if spec.get("fail"):
            err = f"injected failure at {spec['id']}"
            span.record_exception(RuntimeError(err))
            span.set_status(StatusCode.ERROR, err)
            log.error("cascade step failed", extra={"cascade.node": spec["id"]})
            status = "error"
        else:
            # the OTel context is per thread: hand the current one to each worker thread
            ctx = context.get_current()
            children = list(pool.map(lambda child: _in_context(ctx, _call_child, child, token), spec.get("children", [])))
            log.info("cascade step ok", extra={"cascade.node": spec["id"], "cascade.children": len(children)})

        span_ctx = span.get_span_context()
        result = {
            "id": spec["id"], "service": SERVICE, "status": status, "error": err, "user_id": user_id,
            "trace_id": format(span_ctx.trace_id, "032x"), "span_id": format(span_ctx.span_id, "016x"),
            "duration_ms": round((time.monotonic() - started) * 1000), "children": children,
        }
    return JsonResponse(result, status=200 if status == "ok" else 500)


def _in_context(ctx, fn, *args):
    token = context.attach(ctx)
    try:
        return fn(*args)
    finally:
        context.detach(token)


def _call_child(child: dict, token: str) -> dict:
    started = time.monotonic()
    try:
        response = requests.post(f"{child['url'].rstrip('/')}/api/cascade", json=child, timeout=15,
                                 headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict) and body.get("id"):
            return body  # ok, or the child's own error result
        return _failed(child, f"HTTP {response.status_code}", started)
    except requests.RequestException as e:
        log.error("cascade child unreachable", extra={"cascade.node": child["id"], "error": str(e)})
        return _failed(child, str(e), started)


def _failed(child: dict, error: str, started: float) -> dict:
    return {"id": child["id"], "service": child["service"], "status": "error", "error": error,
            "duration_ms": round((time.monotonic() - started) * 1000), "children": []}
