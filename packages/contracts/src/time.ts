import { z } from 'zod';

/** Canonical timestamp on every interface: ISO 8601, UTC, millisecond precision. */
export const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const IsoUtcMs = z
  .string()
  .regex(ISO_UTC_MS, 'must be ISO 8601 UTC with milliseconds, e.g. 2026-11-16T18:03:21.123Z');
export type IsoUtcMs = z.infer<typeof IsoUtcMs>;

/** Normalise any supported backend time to IsoUtcMs. */
export function toIsoUtcMs(t: Date | number | string, unit: 'ms' | 's' | 'ns' = 'ms'): IsoUtcMs {
  let ms: number;
  if (t instanceof Date) ms = t.getTime();
  else if (typeof t === 'number') ms = unit === 's' ? t * 1000 : unit === 'ns' ? t / 1e6 : t;
  else if (/^\d+$/.test(t)) ms = unit === 'ns' ? Number(BigInt(t) / 1_000_000n) : unit === 's' ? Number(t) * 1000 : Number(t);
  else ms = Date.parse(t);
  if (!Number.isFinite(ms)) throw new Error(`invalid time: ${String(t)}`);
  return new Date(Math.round(ms)).toISOString();
}

/**
 * Model-supplied times (tool inputs) are accepted as any ISO 8601 date-time with a
 * zone and normalised; everything TraceOps emits or stores is IsoUtcMs.
 */
export const IsoInput = z
  .string()
  .refine((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)), 'must be ISO 8601 date-time with zone')
  .transform((s) => toIsoUtcMs(s));
