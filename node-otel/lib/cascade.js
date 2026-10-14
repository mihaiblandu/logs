// POST /api/cascade: same contract in every demo service. Runs a "cascade <id>" span with simulated
// work, then calls each child's /api/cascade with the caller's JWT (traceparent + baggage are injected
// by the fetch instrumentation) and returns this node's result with the children's results.
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const SERVICE = 'node';

function cascadeHandler(tracer, log) {
  return async (req, res) => {
    const auth = req.auth;
    if (!auth?.claims) {
      trace.getActiveSpan()?.addEvent('auth.failed', { 'auth.error': auth?.error ?? 'missing token' });
      log.warn({ 'auth.error': auth?.error }, 'cascade rejected: invalid token');
      return res.status(401).json({ error: 'unauthorized', reason: auth?.error });
    }

    const spec = req.body ?? {};
    const userId = String(auth.claims.sub);
    const result = await tracer.startActiveSpan(`cascade ${spec.id}`, {
      attributes: { 'cascade.node': spec.id, 'cascade.service': SERVICE, 'user.id': userId },
    }, async (span) => {
      const started = Date.now();
      try {
        await new Promise((r) => setTimeout(r, Number(spec.work_ms || 0))); // simulated work
        if (spec.fail) {
          const error = new Error(`injected failure at ${spec.id}`);
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          log.error({ 'cascade.node': spec.id }, 'cascade step failed');
          return node(spec, span, userId, started, 'error', error.message, []);
        }
        const children = await Promise.all((spec.children ?? []).map((c) => callChild(c, auth.token, log)));
        log.info({ 'cascade.node': spec.id, 'cascade.children': children.length }, 'cascade step ok');
        return node(spec, span, userId, started, 'ok', null, children);
      } finally {
        span.end();
      }
    });
    res.status(result.status === 'ok' ? 200 : 500).json(result);
  };
}

async function callChild(child, token, log) {
  const started = Date.now();
  try {
    const response = await fetch(`${child.url.replace(/\/$/, '')}/api/cascade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(child),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    if (body?.id) return body; // ok, or the child's own error result
    return failed(child, `HTTP ${response.status}`, started);
  } catch (e) {
    log.error({ 'cascade.node': child.id, error: e.message }, 'cascade child unreachable');
    return failed(child, e.message, started);
  }
}

function node(spec, span, userId, started, status, error, children) {
  const ctx = span.spanContext();
  return {
    id: spec.id, service: SERVICE, status, error, user_id: userId,
    trace_id: ctx.traceId, span_id: ctx.spanId, duration_ms: Date.now() - started, children,
  };
}

function failed(child, error, started) {
  return { id: child.id, service: child.service, status: 'error', error, duration_ms: Date.now() - started, children: [] };
}

module.exports = { cascadeHandler };
