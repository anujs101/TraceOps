import { z } from 'zod';

/**
 * Raw backend response shapes (as captured in fixtures/). Adapters parse these,
 * never hand-written mocks. Shapes observed from Prometheus /api/v1/query_range
 * and Loki /loki/api/v1/query_range (with X-Loki-Response-Encoding-Flags:
 * categorize-labels) behind grafana/otel-lgtm:0.40.0.
 */
const PromSample = z.tuple([z.number(), z.string()]); // [unix seconds, value as string; may be "NaN"]

export const PromRangeResponse = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('matrix'),
    result: z.array(z.object({ metric: z.record(z.string(), z.string()), values: z.array(PromSample) })),
  }),
});

export const PromErrorResponse = z.object({
  status: z.literal('error'), errorType: z.string(), error: z.string(),
});

const LokiEntryMeta = z.object({
  structuredMetadata: z.record(z.string(), z.string()).optional(),
  parsed: z.record(z.string(), z.string()).optional(),
});
export const LokiStreamsResponse = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('streams'),
    encodingFlags: z.array(z.string()).optional(),
    result: z.array(z.object({
      stream: z.record(z.string(), z.string()),
      values: z.array(z.union([z.tuple([z.string(), z.string()]), z.tuple([z.string(), z.string(), LokiEntryMeta])])), // [ns, line, meta?]
    })),
    stats: z.unknown(),
  }),
});

export const LokiMatrixResponse = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('matrix'),
    result: z.array(z.object({ metric: z.record(z.string(), z.string()), values: z.array(PromSample) })),
    stats: z.unknown(),
  }),
});
