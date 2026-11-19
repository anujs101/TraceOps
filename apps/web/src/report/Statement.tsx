import { createContext, useContext } from 'react';
import type { Evidence } from '../api.ts';

export type Selection = { evidenceId: string; field?: string; claimed?: number; label?: string };
export type BoundValue = { key: string; evidence_id: string; field: string; value: number };

export const EvidenceContext = createContext<{
  byId: Map<string, Evidence>;
  selected: Selection | null;
  open: (s: Selection) => void;
}>({ byId: new Map(), selected: null, open: () => {} });

/** A number from the report, bound to evidence. Clicking it opens that evidence. */
export function BoundNumber({ v }: { v: BoundValue }) {
  const { open, selected, byId } = useContext(EvidenceContext);
  const active = selected?.evidenceId === v.evidence_id && selected.field === v.field;
  const source = byId.get(v.evidence_id)?.source;
  return (
    <button
      type="button"
      className={`num src-${source ?? 'unknown'}${active ? ' is-active' : ''}`}
      onClick={() => open({ evidenceId: v.evidence_id, field: v.field, claimed: v.value, label: v.key })}
      aria-label={`${v.value}, ${v.field} of ${v.evidence_id}. Show evidence`}
      data-testid={`num-${v.key}`}
    >
      {String(v.value)}
      <sub>{v.evidence_id}</sub>
    </button>
  );
}

/** A citation of a whole evidence row. */
export function EvidenceChip({ id }: { id: string }) {
  const { open, selected, byId } = useContext(EvidenceContext);
  const ev = byId.get(id);
  const active = selected?.evidenceId === id && !selected.field;
  return (
    <button
      type="button"
      className={`chip src-${ev?.source ?? 'unknown'}${ev && ev.status !== 'ok' ? ' is-bad' : ''}${active ? ' is-active' : ''}`}
      onClick={() => open({ evidenceId: id })}
      aria-label={`Show evidence ${id}`}
      data-testid={`chip-${id}`}
    >
      {id}
    </button>
  );
}

/**
 * Renders prose with {key} placeholders replaced by their bound values.
 * An unbound placeholder is shown as-is and marked, never guessed.
 */
export function Statement({ text, values }: { text: string; values: BoundValue[] }) {
  const byKey = new Map(values.map((v) => [v.key, v]));
  const parts = text.split(/(\{[a-z][a-z0-9_]*\})/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\{([a-z][a-z0-9_]*)\}$/.exec(p);
        if (!m) return <span key={i}>{p}</span>;
        const v = byKey.get(m[1]!);
        return v ? <BoundNumber key={i} v={v} /> : <span key={i} className="unbound" title="No bound value for this placeholder">{p}</span>;
      })}
    </>
  );
}
