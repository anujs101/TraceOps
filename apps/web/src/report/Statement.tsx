import { createContext, useContext, type ReactNode } from 'react';
import type { Evidence } from '../api.ts';
import { evidenceLabel, unitFor } from '../lib/evidence.ts';
import { COUNT_UNITS, exact, formatValue } from '../lib/format.ts';

export type Selection = { evidenceId: string; field?: string; claimed?: number; label?: string };
export type BoundValue = { key: string; evidence_id: string; field: string; value: number };

export type EvidenceCtx = {
  byId: Map<string, Evidence>;
  all: Evidence[];
  incidentStart: string | null;
  selected: Selection | null;
  open: (s: Selection) => void;
};

export const EvidenceContext = createContext<EvidenceCtx>({ byId: new Map(), all: [], incidentStart: null, selected: null, open: () => {} });

/** Units written after a placeholder in prose that we absorb into the formatted number ("{x} s" → "9.49 ms"). */
const ABSORBABLE = new Set(['s', 'req/s', 'timeouts/s']);

/**
 * A number from the report, bound to evidence. Display is rounded; the stored
 * value is in the tooltip and the drawer. Clicking opens that evidence.
 */
export function Num({ v, withCountUnit = false, showUnit = true }: { v: BoundValue; withCountUnit?: boolean; showUnit?: boolean }) {
  const { open, selected, byId } = useContext(EvidenceContext);
  const ev = byId.get(v.evidence_id);
  const unit = unitFor(ev, v.field);
  const f = formatValue(v.value, unit);
  const unitText = !showUnit || !f.unit || f.unit === 'count' || (!withCountUnit && COUNT_UNITS.has(f.unit)) ? '' : f.unit;
  const active = selected?.evidenceId === v.evidence_id && selected.field === v.field;
  const what = `${evidenceLabel(ev)} ${v.field}`;
  return (
    <button
      type="button"
      className={`num${ev ? '' : ' is-missing'}${active ? ' is-active' : ''}`}
      onClick={() => open({ evidenceId: v.evidence_id, field: v.field, claimed: v.value, label: v.key })}
      aria-label={`${f.text}${unitText ? ` ${unitText}` : ''}: ${what}, exact ${exact(v.value)}. Show evidence`}
      data-tip={`${what} · exact ${exact(v.value)} · ${v.evidence_id}`}
      data-testid={`num-${v.key}`}
    >
      {f.text}{unitText && <span className={unitText === '%' ? 'num-u num-pct' : 'num-u'}>{unitText}</span>}
    </button>
  );
}

/** A citation of a whole evidence row: icon + what it looked at. The id is in the tooltip and drawer only. */
export function EvidenceRef({ id }: { id: string }) {
  const { open, selected, byId } = useContext(EvidenceContext);
  const ev = byId.get(id);
  const active = selected?.evidenceId === id && !selected.field;
  const bad = !ev || ev.status !== 'ok';
  return (
    <button
      type="button"
      className={`ref${bad ? ' is-bad' : ''}${active ? ' is-active' : ''}`}
      onClick={() => open({ evidenceId: id })}
      aria-label={`Show evidence ${id}: ${evidenceLabel(ev)}${ev && ev.status !== 'ok' ? `, ${ev.status}` : ''}`}
      data-tip={`${id}${ev ? ` · ${ev.status}` : ' · not stored'}`}
      data-testid={`ref-${id}`}
    >
      <SourceIcon source={ev?.source} />
      <span>{evidenceLabel(ev)}</span>
    </button>
  );
}

export function SourceIcon({ source }: { source?: 'prometheus' | 'loki' }) {
  if (source === 'prometheus') {
    return <svg className="src-ico" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 9 L4 5 L7 7 L11 2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (source === 'loki') {
    return <svg className="src-ico" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 3h9M1.5 6h6M1.5 9h8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
  }
  return <svg className="src-ico" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

/**
 * Renders prose with {key} placeholders replaced by their bound values.
 * An unbound placeholder is shown as-is and marked, never guessed.
 * Evidence ids in prose ("ev_13") become evidence references; hyp_N / obs_N
 * read as "hypothesis N" / "observation N". Nothing else in the prose changes.
 */
export function Statement({ text, values = [] }: { text: string; values?: BoundValue[] }) {
  const { byId } = useContext(EvidenceContext);
  const byKey = new Map(values.map((v) => [v.key, v]));
  const parts = text.split(/(\{[a-z][a-z0-9_]*\}|\bev_[1-9]\d*\b|\b(?:hyp|obs)_[1-9]\d*\b)/g);
  const out: ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (/^ev_[1-9]\d*$/.test(p)) { out.push(<EvidenceRef key={i} id={p} />); continue; }
    const ref = /^(hyp|obs)_(\d+)$/.exec(p);
    if (ref) { out.push(<span key={i}>{ref[1] === 'hyp' ? 'hypothesis' : 'observation'} {ref[2]}</span>); continue; }
    const m = /^\{([a-z][a-z0-9_]*)\}$/.exec(p);
    if (!m) { if (p) out.push(<span key={i}>{p}</span>); continue; }
    const v = byKey.get(m[1]!);
    if (!v) { out.push(<span key={i} className="unbound" title="No bound value for this placeholder">{p}</span>); continue; }
    const unit = unitFor(byId.get(v.evidence_id), v.field);
    const next = parts[i + 1];
    if (unit && ABSORBABLE.has(unit) && next) {
      const re = new RegExp(`^ ${unit.replace(/[/]/g, '\\/')}(?![\\w/])`);
      if (re.test(next)) parts[i + 1] = next.replace(re, '');
    }
    out.push(<Num key={i} v={v} />);
  }
  return <>{out}</>;
}
