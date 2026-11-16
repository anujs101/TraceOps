// Preloaded with `node --require ./otel.cjs app.cjs` so the SDK starts and
// patches http/pino BEFORE the app requires them. (ESM imports are hoisted,
// which is why starting the SDK inside an .mjs app silently patched nothing.)
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { PinoInstrumentation } = require('@opentelemetry/instrumentation-pino');

const OTLP = process.env.OTLP_ENDPOINT ?? 'http://localhost:4318';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': 'spike-service',
    'service.version': process.env.SERVICE_VERSION ?? '0.0.1',
    'deployment.environment.name': 'spike',
  }),
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${OTLP}/v1/metrics` }),
      exportIntervalMillis: 5000, // default 60s is too slow for detection
    }),
  ],
  // sdk-logs 3.x: options object, not a positional exporter
  logRecordProcessors: [
    new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${OTLP}/v1/logs` }) }),
  ],
  instrumentations: [new HttpInstrumentation(), new PinoInstrumentation()],
});
sdk.start();
globalThis.__otelShutdown = () => sdk.shutdown();
