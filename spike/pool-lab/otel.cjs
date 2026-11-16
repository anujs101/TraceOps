// SPIKE ONLY (pool lab). Preload: node --require ./otel.cjs app.cjs
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { PeriodicExportingMetricReader, AggregationType } = require('@opentelemetry/sdk-metrics');
// instrumentation-pg's pool gauges are event-driven and go stale when a leaked
// pool stops emitting events (pending stuck at 0 in S1). Drop them; app.cjs
// emits export-time observable gauges instead. Keep its db.client.operation.duration.
const PG_SCOPE = '@opentelemetry/instrumentation-pg';
const dropPgPool = ['db.client.connection.count', 'db.client.connection.max', 'db.client.connection.pending_requests']
  .map((instrumentName) => ({ instrumentName, meterName: PG_SCOPE, aggregation: { type: AggregationType.DROP } }));
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
const { PinoInstrumentation } = require('@opentelemetry/instrumentation-pino');
const { RuntimeNodeInstrumentation } = require('@opentelemetry/instrumentation-runtime-node');

const OTLP = process.env.OTLP_ENDPOINT ?? 'http://localhost:4318';
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': process.env.SERVICE_NAME ?? 'lab-service',
    'service.version': process.env.SERVICE_VERSION ?? '1.0.0',
    'deployment.environment.name': 'lab',
  }),
  metricReaders: [new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${OTLP}/v1/metrics` }),
    exportIntervalMillis: 5000,
  })],
  views: dropPgPool,
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${OTLP}/v1/logs` }) })],
  instrumentations: [
    new HttpInstrumentation(), new ExpressInstrumentation(), new PgInstrumentation(),
    new PinoInstrumentation(), new RuntimeNodeInstrumentation(), // default precision 10ms; values include this floor
  ],
});
sdk.start();
globalThis.__otelShutdown = () => sdk.shutdown();
