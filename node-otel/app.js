const crypto = require('node:crypto');
const express = require('express');
const pino = require('pino');
const { context, propagation, trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const { verifyBearer } = require('./lib/jwt');
const { cascadeHandler } = require('./lib/cascade');

const SCOPE = 'app.node-otel';
const tracer = trace.getTracer(SCOPE);
const meter = metrics.getMeter(SCOPE);
const echoRequests = meter.createCounter('echo.requests', { unit: '{request}', description: 'Echo requests by outcome' });
const messageLength = meter.createHistogram('echo.message.length', { unit: '{char}', description: 'Length of echoed messages' });

// pino instrumentation adds trace_id/span_id and sends every record to OTel Logs;
// the mixin adds request.id / user.id from the current baggage. log.logger names the logger (the OTel
// scope is the pino instrumentation's name, not the app's logger).
const rootLog = pino({
  level: 'debug',
  mixin() {
    const bag = propagation.getBaggage(context.active());
    return bag ? { 'request.id': bag.getEntry('request.id')?.value, 'user.id': bag.getEntry('user.id')?.value } : {};
  },
});
const log = rootLog.child({ 'log.logger': SCOPE });

// JSON bodies up to 4 KB for the request log; secrets are masked by the collector
const jsonBody = (contentType, body) => (contentType?.includes('json') && body && body.length <= 4096 ? body : undefined);

const app = express();
app.use(express.json());

// Attaches per-request context to the server span, every log record (mixin) and OTel baggage
// (propagated downstream via the W3C "baggage" header by the fetch/undici instrumentation).
// The user comes from a valid JWT `sub` first, then X-User-Id, then upstream baggage.
app.use((req, res, next) => {
  const upstream = propagation.getBaggage(context.active());
  req.auth = req.get('Authorization') ? verifyBearer(req.get('Authorization')) : null;
  const requestId = req.get('X-Request-Id') || upstream?.getEntry('request.id')?.value || crypto.randomUUID();
  const userId = (req.auth?.claims && String(req.auth.claims.sub))
    || req.get('X-User-Id') || upstream?.getEntry('user.id')?.value || 'anonymous';

  const span = trace.getActiveSpan(); // server span created by the http instrumentation
  span?.setAttributes({ 'request.id': requestId, 'user.id': userId, 'client.address': req.ip });

  const bag = (upstream ?? propagation.createBaggage())
    .setEntry('request.id', { value: requestId })
    .setEntry('user.id', { value: userId });

  res.set('X-Request-Id', requestId);
  res.set('X-Trace-Id', span?.spanContext().traceId ?? '');
  const ctx = propagation.setBaggage(context.active(), bag);
  // one "request completed" log record per request (same fields in every service), in the request's
  // context so it gets trace_id/span_id and request.id/user.id (mixin)
  // response body: JSON sent with res.json/res.send, kept for the request log
  const send = res.send.bind(res);
  res.send = (body) => { res.locals.body = body; return send(body); };
  res.on('finish', () => context.with(ctx, () => {
    const status = res.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    log[level]({
      'http.request.method': req.method,
      'http.route': req.route?.path ?? req.path,
      'url.path': req.path,
      'http.response.status_code': status,
      'client.address': req.ip,
      'user.name': req.auth?.claims?.name,
      // OAuth2 JWT access token (RFC 9068: client_id, scope/scp): its subject
      'user.sub': ['client_id', 'scope', 'scp'].some((k) => req.auth?.claims?.[k] != null) ? String(req.auth.claims.sub) : undefined,
      'http.request.body': jsonBody(req.get('Content-Type'), req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : undefined),
      'http.response.body': jsonBody(res.get('Content-Type'), typeof res.locals.body === 'string' ? res.locals.body : undefined),
    }, 'request completed');
  }));
  context.with(ctx, next);
});

// Port of the Go/Spring/... /echo: fails ~10% of the time.
app.get('/api/echo', async (req, res) => {
  const message = String(req.query.message ?? '');
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'echo.message': message, 'echo.message_length': message.length });

  if (Math.floor(Math.random() * 100) > 90) {
    const error = new Error(`random failure while echoing '${message}'`);
    span?.recordException(error); // span event "exception" with type, message, stacktrace
    span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    echoRequests.add(1, { outcome: 'error', 'error.type': error.name });
    log.error({ 'echo.message': message, 'http.response.status_code': 500 }, 'echo failed');
    return res.status(500).json({ error: 'internal error' });
  }

  const result = await processMessage(message);
  echoRequests.add(1, { outcome: 'ok' });
  messageLength.record(message.length);
  log.info({ 'echo.message': message, 'http.response.status_code': 200 }, 'echo ok');
  res.json({ message: result });
});

// Node -> Go -> Django -> .NET -> Laravel -> Spring: one trace across six services.
app.get('/api/chain', async (req, res) => {
  const downstream = (process.env.DOWNSTREAM_URL || 'http://localhost:4250').replace(/\/$/, '');
  const bag = propagation.getBaggage(context.active());
  // traceparent + baggage are injected by the undici (fetch) instrumentation; plain headers for
  // services that read context from them
  const response = await fetch(`${downstream}/api/chain`, {
    headers: { 'X-Request-Id': bag?.getEntry('request.id')?.value ?? '', 'X-User-Id': bag?.getEntry('user.id')?.value ?? '' },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  log.info({ 'downstream.url': downstream, 'downstream.status': response.status }, 'downstream call finished');
  res.status(response.ok ? 200 : 502).json({ downstream_status: response.status, downstream_body: body });
});

app.post('/api/cascade', cascadeHandler(tracer, rootLog.child({ 'log.logger': `${SCOPE}.cascade` })));

function processMessage(message) {
  return tracer.startActiveSpan('echo.process', async (span) => { // child of the server span
    try {
      const delay = 5 + Math.floor(Math.random() * 45);
      span.addEvent('work.started', { 'work.planned_ms': delay });
      await new Promise((r) => setTimeout(r, delay)); // simulated work, visible as span duration
      span.addEvent('work.finished');
      span.setAttribute('work.duration_ms', delay);
      log.debug({ 'work.duration_ms': delay }, 'processed message');
      return message;
    } finally {
      span.end();
    }
  });
}

const port = Number(process.env.PORT || 3005);
app.listen(port, () => log.info({ 'server.port': Number(port) }, 'server starting'));
