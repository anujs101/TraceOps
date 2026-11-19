// Preloaded with `node --require ./dist/otel.js` (CommonJS). ESM import hoisting would load
// http/express/pg/pino before the SDK and silently disable instrumentation.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader, AggregationType } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';

process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'http';

// instrumentation-pg's pool gauges are event-driven and go stale under a leak: drop them.
// src/metrics.ts emits export-time observable gauges under the same names instead.
const PG_SCOPE = '@opentelemetry/instrumentation-pg';
const dropPgPool = ['db.client.connection.count', 'db.client.connection.max', 'db.client.connection.pending_requests'].map(
  (instrumentName) => ({ instrumentName, meterName: PG_SCOPE, aggregation: { type: AggregationType.DROP as const } }),
);

const OTLP = process.env.OTLP_ENDPOINT ?? 'http://localhost:4318';
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': 'demo-service',
    'service.version': process.env.SERVICE_VERSION ?? '1.0.0',
    'deployment.environment.name': 'local',
  }),
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${OTLP}/v1/metrics` }),
      exportIntervalMillis: 5000,
    }),
  ],
  views: dropPgPool,
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${OTLP}/v1/logs` }) })],
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new PgInstrumentation(),
    new PinoInstrumentation(),
    new RuntimeNodeInstrumentation(), // default monitoringPrecision: 1000 ms adds a 1 s floor
  ],
});
sdk.start();
(globalThis as { __otelShutdown?: () => Promise<void> }).__otelShutdown = () => sdk.shutdown();
