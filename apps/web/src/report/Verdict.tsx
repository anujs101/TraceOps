import { useContext } from 'react';
import type { Report } from '@traceops/contracts';
import type { Incident, InvestigationRow, ReportRow } from '../api.ts';
import { evidenceLabel, markIndex, seriesOf, unitFor } from '../lib/evidence.ts';
import { between, duration } from '../lib/format.ts';
import { CATEGORY, Confidence } from '../ui/Badge.tsx';
import { Sparkline } from '../ui/Sparkline.tsx';
import { TimeRuler } from '../ui/TimeRuler.tsx';
import { EvidenceContext, Num, Statement, type BoundValue } from './Statement.tsx';
import { ValidationSeal } from './Validation.tsx';

/** Values a hypothesis may use: those of the observations it cites (V3). */
export function hypothesisValues(r: Report, h: Report['hypotheses'][number]): BoundValue[] {
  const byId = new Map(r.observations.map((o) => [o.id, o]));
  return [...h.supporting_observation_ids, ...h.contradicting_observation_ids].flatMap((id) => byId.get(id)?.values ?? []);
}

/** Every bound value in the report, for the summary and timeline (keys are unique report-wide). */
export function allValues(r: Report): BoundValue[] {
  return r.observations.flatMap((o) => o.values);
}

/** Key numbers: the top hypothesis's placeholders, in statement order, at most 4. Deterministic. */
export function keyNumbers(r: Report): BoundValue[] {
  const top = r.hypotheses[0];
  if (!top) return [];
  const vals = new Map(hypothesisValues(r, top).map((v) => [v.key, v]));
  const seen = new Set<string>();
  const out: BoundValue[] = [];
  for (const m of top.statement.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) {
    const v = vals.get(m[1]!);
    if (v && !seen.has(v.key)) { seen.add(v.key); out.push(v); }
    if (out.length === 4) break;
  }
  return out;
}

export function timeToReport(incident: Incident | null, inv: InvestigationRow): number | null {
  return inv.finished_at ? between(incident?.detected_at, inv.finished_at) : null;
}

export function Verdict({ r, row, incident, inv }: { r: Report; row: ReportRow; incident: Incident | null; inv: InvestigationRow }) {
  const top = r.hypotheses[0];
  const ttr = timeToReport(incident, inv);
  const keys = keyNumbers(r);
  return (
    <section className="verdict" aria-labelledby="h-verdict">
      <div className="verdict-line">
        <span className={`verdict-status ${r.status === 'probable_cause' ? '' : 'is-insufficient'}`}>
          {r.status === 'probable_cause' ? 'Probable cause' : 'Not enough evidence for a cause'}
        </span>
        <ValidationSeal row={row} />
      </div>
      {top ? (
        <>
          <h1 id="h-verdict" className="verdict-title">
            {CATEGORY[top.category] ?? top.category}
            <Confidence value={top.confidence} />
          </h1>
          <p className="verdict-stmt"><Statement text={top.statement} values={hypothesisValues(r, top)} /></p>
        </>
      ) : <h1 id="h-verdict" className="verdict-title">No hypothesis</h1>}

      <TimeRuler marks={[
        { at: incident?.started_at ?? null, label: 'Symptoms started', tone: 'fault' },
        { at: incident?.detected_at ?? null, label: 'Detected', tone: 'fault' },
        { at: inv.started_at, label: 'Investigation began', tone: 'signal' },
        { at: inv.finished_at, label: 'Report', tone: row.validation === 'passed' ? 'proven' : 'fault' },
      ]} />

      <dl className="keys">
        <div className="key key-ttr">
          <dt>Detection to report</dt>
          <dd><span className="key-v" data-testid="ttr">{ttr === null ? '—' : duration(ttr)}</span></dd>
        </div>
        {keys.map((v) => <KeyNumber key={v.key} v={v} />)}
      </dl>
    </section>
  );
}

function KeyNumber({ v }: { v: BoundValue }) {
  const { byId, incidentStart } = useContext(EvidenceContext);
  const ev = byId.get(v.evidence_id);
  const pts = seriesOf(ev);
  return (
    <div className="key">
      <dt>{evidenceLabel(ev)} <span className="key-field">{v.field.replace(/^series@.*/, 'at a point')}</span></dt>
      <dd>
        <span className="key-v"><Num v={v} withCountUnit /></span>
        {pts && pts.length > 1 && <Sparkline points={pts} unit={unitFor(ev)} size="micro" splitAt={incidentStart} mark={markIndex(ev, v.field, pts)} />}
      </dd>
    </div>
  );
}
