/** Display helpers. Values are never rounded for display: we show what the report bound. */
export function clock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19);
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
}

export function windowText(w: { start: string; end: string } | null): string {
  if (!w) return 'none (nothing was queried)';
  const sameDay = w.start.slice(0, 10) === w.end.slice(0, 10);
  return sameDay ? `${dateTime(w.start)} to ${clock(w.end)}` : `${dateTime(w.start)} to ${dateTime(w.end)}`;
}

export const toolLabel: Record<string, string> = {
  query_metric: 'Metric query',
  search_logs: 'Log search',
  log_patterns: 'Log patterns',
  log_volume: 'Log volume',
};

export function evidenceTitle(e: { tool: string; args: unknown }): string {
  const a = e.args as Record<string, unknown> | null;
  if (e.tool === 'query_metric' && a && typeof a.metric === 'string') return a.metric;
  return toolLabel[e.tool] ?? e.tool;
}
