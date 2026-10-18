// Loaded with `node --require ./instrumentation.js` so instrumentations patch modules before the app
// requires them. Endpoint from OTEL_EXPORTER_OTLP_ENDPOINT (start-all.sh: the agent collector, http://localhost:4308).
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { defaultResource, envDetector, resourceFromAttributes } = require('@opentelemetry/resources');
const { randomUUID } = require('node:crypto');
const { version } = require('./package.json');

const sdk = new NodeSDK({
  // merged with defaultResource() so telemetry.sdk.* (name, language, version) is kept like in every other SDK
  resource: defaultResource().merge(resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME || 'node-otel-api',
    'service.namespace': 'demo',
    'service.version': version,
    'service.instance.id': randomUUID(),
    'deployment.environment.name': 'local',
    team: 'observability',
  })),
  // only OTEL_RESOURCE_ATTRIBUTES: the default host/os/process detectors are not part of the standard
  resourceDetectors: [envDetector],
  traceExporter: new OTLPTraceExporter(),
  // a manually built reader ignores OTEL_METRIC_EXPORT_INTERVAL, so read it here (default 60s)
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 60000),
  }),
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })], // options object since sdk-logs 0.2xx
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false }, // very noisy, not useful here
    '@opentelemetry/instrumentation-net': { enabled: false }, // tcp.connect spans
    // Express 5 runs on the `router` package: no span per middleware/handler. Keeps traces
    // readable, and makes the HTTP server span the active one inside middleware (so context
    // attributes land on it)
    '@opentelemetry/instrumentation-router': { enabled: false },
    '@opentelemetry/instrumentation-express': { ignoreLayersType: ['middleware', 'request_handler'] },
  })],
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
