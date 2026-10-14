import logging
import uuid

from opentelemetry import baggage, context, trace

from .auth import verify_bearer

log = logging.getLogger(__name__)


class TelemetryContextMiddleware:
    """
    Attaches per-request context to the server span, every log record (via ContextLogFilter, which
    reads baggage) and OTel baggage (propagated downstream via the W3C "baggage" header by `requests`),
    and writes one "request completed" log record per request (same fields in every service).
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # user: valid JWT sub first, then X-User-Id, then baggage from an upstream service
        request_id = request.headers.get("X-Request-Id") or baggage.get_baggage("request.id") or str(uuid.uuid4())
        _, claims, _ = verify_bearer(request.headers.get("Authorization")) if request.headers.get("Authorization") else (None, None, None)
        user_id = (claims and str(claims["sub"])) or request.headers.get("X-User-Id") or baggage.get_baggage("user.id") or "anonymous"

        span = trace.get_current_span()  # server span created by the Django instrumentation
        span.set_attribute("request.id", request_id)
        span.set_attribute("user.id", user_id)
        span.set_attribute("client.address", request.META.get("REMOTE_ADDR", ""))

        ctx = baggage.set_baggage("request.id", request_id)
        ctx = baggage.set_baggage("user.id", user_id, context=ctx)
        token = context.attach(ctx)
        try:
            response = self.get_response(request)
            log_request_completed(request, response, claims)
        finally:
            context.detach(token)

        response["X-Request-Id"] = request_id
        response["X-Trace-Id"] = format(span.get_span_context().trace_id, "032x")
        return response


MAX_BODY = 4096


def json_body(content_type, body):
    """JSON bodies up to MAX_BODY bytes; secrets are masked by the collector."""
    if content_type and "json" in content_type and body and len(body) <= MAX_BODY:
        return body.decode("utf-8", "replace")
    return None


def log_request_completed(request, response, claims):
    """request.id / user.id come from baggage (ContextLogFilter)."""
    status = response.status_code
    match = request.resolver_match
    level = logging.ERROR if status >= 500 else logging.WARNING if status >= 400 else logging.INFO
    log.log(level, "request completed", extra={k: v for k, v in {
        "http.request.method": request.method,
        "http.route": "/" + match.route if match and match.route else request.path,
        "url.path": request.path,
        "http.response.status_code": status,
        "client.address": request.META.get("REMOTE_ADDR"),
        "user.name": (claims or {}).get("name"),
        # OAuth2 JWT access token (RFC 9068: client_id, scope/scp): its subject
        "user.sub": str(claims["sub"]) if claims and ({"client_id", "scope", "scp"} & claims.keys()) else None,
        "http.request.body": json_body(request.headers.get("Content-Type"), request.body),
        "http.response.body": None if response.streaming else json_body(response.get("Content-Type"), response.content),
    }.items() if v not in (None, "")})
