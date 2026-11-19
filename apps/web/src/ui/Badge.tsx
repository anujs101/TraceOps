/** Small status marks. Each pairs its colour with a glyph and a word. */
import type { ReportRow } from '../api.ts';

const TONE: Record<string, 'proven' | 'caution' | 'fault' | 'quiet' | 'live'> = {
  // investigation / incident
  completed: 'quiet', running: 'live', failed: 'fault', cancelled: 'quiet',
  open: 'fault', resolved: 'proven',
  // evidence
  ok: 'proven', empty: 'quiet', error: 'fault', invalid_input: 'fault', budget_exhausted: 'caution', timeout: 'fault',
};

const GLYPH: Record<string, string> = { proven: '✓', caution: '!', fault: '●', quiet: '○', live: '◌' };

export function Status({ value, testId }: { value: string; testId?: string }) {
  const tone = TONE[value] ?? 'quiet';
  return (
    <span className={`badge tone-${tone}`} data-testid={testId}>
      <span className="glyph" aria-hidden="true">{value === 'open' ? '●' : value === 'running' ? '' : GLYPH[tone]}</span>
      {value === 'running' && <span className="pulse" aria-hidden="true" />}
      {value.replace(/_/g, ' ')}
    </span>
  );
}

export function Severity({ value }: { value: string }) {
  const tone = value === 'critical' ? 'fault' : value === 'warning' ? 'caution' : 'quiet';
  return <span className={`sev tone-${tone}`}><span className="sev-bar" aria-hidden="true" />{value}</span>;
}

/** Validated / Unvalidated. Unvalidated is always loud. */
export function Proof({ row, compact = false }: { row: Pick<ReportRow, 'validation'> | null; compact?: boolean }) {
  if (!row) return <span className="proof proof-none">{compact ? '—' : 'No report'}</span>;
  return row.validation === 'passed'
    ? <span className="proof proof-ok"><span aria-hidden="true">✓</span> Validated</span>
    : <span className="proof proof-bad"><span aria-hidden="true">!</span> Unvalidated</span>;
}

const LEVEL = { low: 1, medium: 2, high: 3 } as const;

export function Confidence({ value }: { value: 'low' | 'medium' | 'high' }) {
  const n = LEVEL[value];
  return (
    <span className={`conf conf-${value}`}>
      <span className="conf-meter" aria-hidden="true">{[1, 2, 3].map((i) => <i key={i} className={i <= n ? 'on' : ''} />)}</span>
      {value} confidence
    </span>
  );
}

export function Risk({ value }: { value: 'low' | 'medium' | 'high' }) {
  const tone = value === 'high' ? 'fault' : value === 'medium' ? 'caution' : 'quiet';
  return <span className={`risk tone-${tone}`}>{value} risk</span>;
}

export const CATEGORY: Record<string, string> = {
  db_pool_exhaustion: 'Connection pool exhaustion',
  cpu_saturation: 'CPU saturation',
  memory_pressure: 'Memory pressure',
  dependency_latency: 'Slow dependency',
  other: 'Other cause',
};
