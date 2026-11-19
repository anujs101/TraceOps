import { useContext, type ReactNode } from 'react';
import type { Report } from '@traceops/contracts';
import type { Incident } from '../api.ts';
import { markIndex, seriesOf, unitFor } from '../lib/evidence.ts';
import { clock, offset } from '../lib/format.ts';
import { CATEGORY, Confidence, Risk } from '../ui/Badge.tsx';
import { Sparkline } from '../ui/Sparkline.tsx';
import { EvidenceContext, EvidenceRef, Statement } from './Statement.tsx';
import { allValues, hypothesisValues } from './Verdict.tsx';

type Obs = Report['observations'][number];

export function Summary({ r }: { r: Report }) {
  return <p className="summary"><Statement text={r.summary} values={allValues(r)} /></p>;
}

export function Hypotheses({ r }: { r: Report }) {
  const obsById = new Map(r.observations.map((o) => [o.id, o]));
  return (
    <section className="sec" aria-labelledby="h-hyp">
      <h2 id="h-hyp">Hypotheses <span className="count">{r.hypotheses.length}, ranked</span></h2>
      {r.hypotheses.length === 0 && <p className="quiet">The report lists no hypotheses.</p>}
      <ol className="hyps">
        {r.hypotheses.map((h, idx) => (
          <li key={h.id} className={`hyp${idx === 0 ? ' hyp-top' : ''}`} data-testid={`hyp-${h.id}`}>
            <details open={idx === 0}>
              <summary>
                <span className="hyp-rank">{idx + 1}</span>
                <span className="hyp-cat">{CATEGORY[h.category] ?? h.category}</span>
                <Confidence value={h.confidence} />
                <span className="hyp-tally">
                  <span className="for">{h.supporting_observation_ids.length} for</span>
                  <span className="against">{h.contradicting_observation_ids.length} against</span>
                </span>
              </summary>
              <p className="hyp-stmt"><Statement text={h.statement} values={hypothesisValues(r, h)} /></p>
              <div className="sides">
                <ObsSide kind="for" ids={h.supporting_observation_ids} obsById={obsById} />
                <ObsSide kind="against" ids={h.contradicting_observation_ids} obsById={obsById} />
              </div>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ObsSide({ kind, ids, obsById }: { kind: 'for' | 'against'; ids: string[]; obsById: Map<string, Obs> }) {
  const title = kind === 'for' ? 'Supports' : 'Contradicts';
  return (
    <div className={`side side-${kind}`}>
      <h3>{title} <span className="count">{ids.length}</span></h3>
      {ids.length === 0 ? <p className="quiet">None.</p> : (
        <ul>
          {ids.map((id) => {
            const o = obsById.get(id);
            return (
              <li key={id}>
                <span className="side-mark" aria-hidden="true">{kind === 'for' ? '+' : '−'}</span>
                {o ? <span><Statement text={o.statement} values={o.values} /></span> : <span className="fault-text">Cites an observation that is not in the report.</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Observations({ r }: { r: Report }) {
  const { byId, incidentStart } = useContext(EvidenceContext);
  return (
    <section className="sec" aria-labelledby="h-obs">
      <h2 id="h-obs">Observations <span className="count">{r.observations.length}</span></h2>
      <ul className="obs">
        {r.observations.map((o, i) => {
          const metricEv = o.evidence_ids.map((id) => byId.get(id)).find((e) => seriesOf(e));
          const pts = seriesOf(metricEv);
          const cited = o.values.find((v) => v.evidence_id === metricEv?.id);
          return (
            <li key={o.id} id={o.id} data-testid={`obs-${o.id}`}>
              <span className="obs-n" aria-hidden="true">{i + 1}</span>
              <div className="obs-body">
                <p><Statement text={o.statement} values={o.values} /></p>
                <p className="refs">{o.evidence_ids.map((e) => <EvidenceRef key={e} id={e} />)}</p>
              </div>
              {pts && pts.length > 1 && (
                <Sparkline points={pts} unit={unitFor(metricEv)} splitAt={incidentStart} mark={markIndex(metricEv, cited?.field, pts)} />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Timeline({ r, incident }: { r: Report; incident: Incident | null }) {
  const values = allValues(r);
  type Row = { at: string; node: ReactNode; refs: string[]; detector?: boolean };
  const rows: Row[] = r.timeline.map((t) => ({ at: t.at, node: <Statement text={t.event} values={values} />, refs: t.evidence_ids }));
  if (incident) {
    rows.push({ at: incident.started_at, node: 'Symptoms started (detector)', refs: [], detector: true });
    rows.push({ at: incident.detected_at, node: `Detected: ${incident.trigger.map((t) => t.rule_id).join(', ')} (detector)`, refs: [], detector: true });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const ref = incident?.started_at ?? rows[0]?.at;
  return (
    <section className="sec" aria-labelledby="h-tl">
      <h2 id="h-tl">Timeline</h2>
      {r.timeline.length === 0 ? <p className="quiet">The report has no timeline events.</p> : (
        <ol className="timeline">
          {rows.map((t, i) => (
            <li key={i} className={t.detector ? 'is-detector' : undefined}>
              <time dateTime={t.at}>{clock(t.at)}</time>
              <span className="tl-off">{offset(ref, t.at)}</span>
              <span className="tl-event">{t.node}</span>
              {t.refs.length > 0 && <span className="refs">{t.refs.map((e) => <EvidenceRef key={e} id={e} />)}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function Recommendations({ r }: { r: Report }) {
  const rank = new Map(r.hypotheses.map((h, i) => [h.id, { n: i + 1, cat: CATEGORY[h.category] ?? h.category }]));
  return (
    <section className="sec" aria-labelledby="h-rec">
      <h2 id="h-rec">Recommendations <span className="count">{r.recommendations.length}</span></h2>
      {r.recommendations.length === 0 ? <p className="quiet">The report makes no recommendations.</p> : (
        <ul className="recs">
          {r.recommendations.map((rec, i) => {
            const h = rank.get(rec.hypothesis_id);
            return (
              <li key={i}>
                <p className="rec-action"><Statement text={rec.action} /></p>
                <p className="rec-why"><Statement text={rec.rationale} /></p>
                <p className="rec-meta"><Risk value={rec.risk} /> <span>for hypothesis {h ? `${h.n}, ${h.cat}` : <span className="fault-text">not in the report</span>}</span></p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function Gaps({ r }: { r: Report }) {
  return (
    <section className="sec" aria-labelledby="h-gaps" data-testid="gaps">
      <h2 id="h-gaps">Not checked <span className="count">{r.gaps.length}</span></h2>
      {r.gaps.length === 0 ? <p className="quiet">The report lists no gaps.</p> : (
        <ul className="gaps">{r.gaps.map((g, i) => <li key={i}><Statement text={g} /></li>)}</ul>
      )}
    </section>
  );
}
