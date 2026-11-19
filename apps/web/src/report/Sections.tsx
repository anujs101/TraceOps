import { useContext } from 'react';
import type { Report } from '@traceops/contracts';
import { markIndex, seriesOf, unitFor } from '../lib/evidence.ts';
import { CATEGORY, Confidence, Risk } from '../ui/Badge.tsx';
import { Card, CardHeader } from '../ui/Card.tsx';
import { Chart } from '../ui/Chart.tsx';
import { EvidenceContext, EvidenceRef, Statement } from './Statement.tsx';
import { hypothesisValues } from './Verdict.tsx';

type Obs = Report['observations'][number];

export function Hypotheses({ r }: { r: Report }) {
  const obsById = new Map(r.observations.map((o) => [o.id, o]));
  return (
    <Card aria-labelledby="h-hyp">
      <CardHeader id="h-hyp" title="Hypotheses" meta={`${r.hypotheses.length}, ranked`} />
      {r.hypotheses.length === 0 && <p className="card-empty">The report lists no hypotheses.</p>}
      <ol className="hyps">
        {r.hypotheses.map((h, idx) => (
          <li key={h.id} className={`hyp${idx === 0 ? ' hyp-top' : ''}`} data-testid={`hyp-${h.id}`}>
            <details open={idx === 0}>
              <summary>
                <span className="hyp-rank">{idx + 1}</span>
                <span className="hyp-cat">{CATEGORY[h.category] ?? h.category}</span>
                <Confidence value={h.confidence} />
                <span className="hyp-tally">
                  <span className="tally for">{h.supporting_observation_ids.length} for</span>
                  <span className="tally against">{h.contradicting_observation_ids.length} against</span>
                </span>
                <svg className="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 6l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </summary>
              <div className="hyp-body">
                <p className="hyp-stmt"><Statement text={h.statement} values={hypothesisValues(r, h)} /></p>
                <div className="sides">
                  <ObsSide kind="for" ids={h.supporting_observation_ids} obsById={obsById} />
                  <ObsSide kind="against" ids={h.contradicting_observation_ids} obsById={obsById} />
                </div>
              </div>
            </details>
          </li>
        ))}
      </ol>
    </Card>
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
    <Card aria-labelledby="h-obs">
      <CardHeader id="h-obs" title="Observations" meta={r.observations.length} />
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
                <div className="refs">{o.evidence_ids.map((e) => <EvidenceRef key={e} id={e} />)}</div>
              </div>
              {pts && pts.length > 1 && (
                <Chart points={pts} unit={unitFor(metricEv)} splitAt={incidentStart} mark={markIndex(metricEv, cited?.field, pts)} size="mini" />
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function Recommendations({ r }: { r: Report }) {
  const rank = new Map(r.hypotheses.map((h, i) => [h.id, { n: i + 1, cat: CATEGORY[h.category] ?? h.category }]));
  return (
    <Card aria-labelledby="h-rec">
      <CardHeader id="h-rec" title="Recommendations" meta={r.recommendations.length} />
      {r.recommendations.length === 0 ? <p className="card-empty">The report makes no recommendations.</p> : (
        <ul className="recs">
          {r.recommendations.map((rec, i) => {
            const h = rank.get(rec.hypothesis_id);
            return (
              <li key={i}>
                <div className="rec-head">
                  <p className="rec-action"><Statement text={rec.action} /></p>
                  <Risk value={rec.risk} />
                </div>
                <p className="rec-why"><Statement text={rec.rationale} /></p>
                <p className="rec-meta">For hypothesis {h ? `${h.n}, ${h.cat}` : <span className="fault-text">not in the report</span>}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function Gaps({ r }: { r: Report }) {
  return (
    <Card aria-labelledby="h-gaps" data-testid="gaps">
      <CardHeader id="h-gaps" title="Not checked" meta={r.gaps.length} />
      {r.gaps.length === 0 ? <p className="card-empty">The report lists no gaps.</p> : (
        <ul className="gaps">{r.gaps.map((g, i) => <li key={i}><Statement text={g} /></li>)}</ul>
      )}
    </Card>
  );
}
