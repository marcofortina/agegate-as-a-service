// tracing.js - OpenTelemetry instrumentation
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

const metricExporter = new OTLPMetricExporter({
  url: process.env.OTEL_METRICS_ENDPOINT || 'http://otel-collector:4318/v1/metrics',
  temporalityPreference: 1, // Delta temporality
});

const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60000,
});

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'agegate-verifier',
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.3.0',
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_TRACES_ENDPOINT || 'http://otel-collector:4318/v1/traces',
  }),
  metricReader: metricReader,
  instrumentations: [getNodeAutoInstrumentations()],
});

// Graceful shutdown
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('OTel SDK shut down successfully'))
    .catch((error) => console.error('Error shutting down OTel SDK', error))
    .finally(() => process.exit(0));
});

sdk.start();
console.log(`✅ OpenTelemetry SDK started for service: ${process.env.OTEL_SERVICE_NAME || 'agegate-verifier'}`);
