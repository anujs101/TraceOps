/**
 * Display formatting. Display only: the stored value is never changed, and the
 * exact value (exact()) is always shown next to it in the evidence drawer.
 */

/** Units that read as counts: integers shown exactly, prose usually names them. */
export const COUNT_UNITS = new Set(['connections', 'requests', 'count']);

export type Formatted = { text: string; unit: string };

/** ~3 significant figures; integers exact; anything ≥ 100 rounded to an integer. */
export function sig3(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) || Math.abs(v) >= 100) return Math.round(v).toLocaleString('en-US');
  if (v === 0) return '0';
  const p = v.toPrecision(3);
  return p.includes('e') ? String(Number(p)) : p;
}

export function formatValue(v: number, unit?: string | null): Formatted {
  if (!Number.isFinite(v)) return { text: String(v), unit: unit ?? '' };
  switch (unit) {
    case 's': {
      if (v !== 0 && Math.abs(v) < 0.9995) return { text: sig3(v * 1000), unit: 'ms' };
      return { text: sig3(v), unit: 's' };
    }
    case 'ratio':
      return { text: sig3(v * 100), unit: '%' };
    case undefined: case null: case '':
      return { text: sig3(v), unit: '' };
    default:
      return { text: sig3(v), unit };
  }
}

/** "59.8%", "2.37 s", "28.0 req/s", "10 connections" (withCount) or "10". */
export function formatWithUnit(v: number, unit?: string | null, withCount = false): string {
  const f = formatValue(v, unit);
  if (!f.unit || (!withCount && COUNT_UNITS.has(f.unit))) return f.text;
  return f.unit === '%' ? `${f.text}%` : `${f.text} ${f.unit}`;
}

/** The stored number, unrounded (JS shortest round-trip form). */
export const exact = (v: number): string => String(v);

// ── time ─────────────────────────────────────────────────────────────────

const valid = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** 10:44:15 (UTC) */
export function clock(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? d.toISOString().slice(11, 19) : '—';
}

/** 2026-11-19 10:44:15 UTC */
export function dateTime(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC` : '—';
}

/** 850 ms · 37.8 s · 2 m 15 s · 1 h 5 m */
export function duration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const a = Math.abs(ms), sign = ms < 0 ? '−' : '';
  if (a < 1000) return `${sign}${Math.round(a)} ms`;
  if (a < 60_000) return `${sign}${(a / 1000).toFixed(1)} s`;
  const totalS = Math.round(a / 1000);
  if (a < 3_600_000) { const m = Math.floor(totalS / 60), s = totalS % 60; return `${sign}${m} m${s ? ` ${s} s` : ''}`; }
  const h = Math.floor(totalS / 3600), m = Math.floor((totalS % 3600) / 60);
  return `${sign}${h} h${m ? ` ${m} m` : ''}`;
}

export function between(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = valid(from), b = valid(to);
  return a && b ? b.getTime() - a.getTime() : null;
}

/** "+15.0 s" relative to a reference time. */
export function offset(from: string | null | undefined, to: string | null | undefined): string {
  const ms = between(from, to);
  if (ms === null) return '';
  return ms < 0 ? duration(ms) : `+${duration(ms)}`;
}

/** "2 h ago" */
export function relative(iso: string | null | undefined, now = Date.now()): string {
  const d = valid(iso);
  if (!d) return '';
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 0) return 'in the future';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** "10:42:15 → 10:44:30" (date added when the window spans days). */
export function windowRange(w: { start: string; end: string } | null): string {
  if (!w) return 'none (nothing was queried)';
  const sameDay = w.start.slice(0, 10) === w.end.slice(0, 10);
  return sameDay ? `${dateTime(w.start).replace(' UTC', '')} → ${clock(w.end)} UTC` : `${dateTime(w.start)} → ${dateTime(w.end)}`;
}

/** Elapsed m:ss for a running clock. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
