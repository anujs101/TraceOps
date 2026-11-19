import { ReportApi, type Report } from '@traceops/contracts';
import type { ReportRow } from '../api.ts';
import { clock } from '../format.ts';
import { EvidenceChip, Statement, type BoundValue } from './Statement.tsx';

const CATEGORY: Record<string, string> = {
  db_pool_exhaustion: 'Connection pool exhaustion',
  cpu_saturation: 'CPU saturation',
  memory_pressure: 'Memory pressure',
  dependency_latency: 'Slow dependency',
  other: 'Other',
};

/** Validation status, violations and warnings: always visible, above the report. */
export function ValidationBand({ row }: { row: ReportRow }) {
  const passed = row.validation === 'passed';
  return (
    <section className={`band ${passed ? 'band-ok' : 'band-bad'}`} aria-label="Validation" data-testid="validation">
      <div className="band-head">
        <strong>{passed ? 'Validated' : 'Unvalidated'}</strong>
        <span>
          {passed
            ? 'Every claim cites stored evidence and every number matches it (rules V0–V8).'
            : `The report failed validation${row.repair_attempted ? ' after one repair round' : ''}. Treat its claims as unchecked.`}
        </span>
      </div>
      {row.violations.length > 0 && (
        <ul className="issues" aria-label="Violations">
          {row.violations.map((v, i) => <li key={i}><b>{v.rule}</b> <code>{v.path}</code> {v.message}</li>)}
        </ul>
      )}
      <div className="band-warn" aria-label="Warnings">
        {row.warnings.length === 0 ? <span className="muted">No warnings.</span> : (
          <ul className="issues">
            {row.warnings.map((w, i) => <li key={i}><b>Warning {w.rule}</b> <code>{w.path}</code> {w.message}</li>)}
          </ul>
        )}
      </div>
      {passed && row.repair_attempted && <p className="muted">Passed after one repair round.</p>}
    </section>
  );
}

export function ReportView({ row }: { row: ReportRow }) {
  const parsed = ReportApi.safeParse(row.report);
  if (!parsed.success) {
    return (
      <>
        <ValidationBand row={row} />
        <section className="sec">
          <h2>Raw report</h2>
          <p>The model's output does not have the report structure, so it is shown as returned.</p>
          <pre className="code small">{JSON.stringify(row.report, null, 2)}</pre>
        </section>
      </>
    );
  }
  return (
    <>
      <ValidationBand row={row} />
      <ReportBody r={parsed.data} />
    </>
  );
}

function ReportBody({ r }: { r: Report }) {
  const obsById = new Map(r.observations.map((o) => [o.id, o]));
  const valuesOf = (ids: string[]): BoundValue[] => ids.flatMap((id) => obsById.get(id)?.values ?? []);

  return (
    <>
      <section className="sec verdict">
        <p className="verdict-status">{r.status === 'probable_cause' ? 'Probable cause found' : 'Not enough evidence for a cause'}</p>
        <p className="summary">{r.summary}</p>
      </section>

      <section className="sec" aria-labelledby="h-hyp">
        <h2 id="h-hyp">Hypotheses</h2>
        {r.hypotheses.length === 0 && <p className="muted">No hypotheses.</p>}
        <ol className="hyps">
          {r.hypotheses.map((h, idx) => (
            <li key={h.id} className={`hyp ${idx === 0 ? 'hyp-top' : ''}`} data-testid={`hyp-${h.id}`}>
              <div className="hyp-head">
                <span className="hyp-cat">{CATEGORY[h.category] ?? h.category}</span>
                <span className={`conf conf-${h.confidence}`}>{h.confidence} confidence</span>
                <span className="muted id">{h.id}</span>
              </div>
              <p className="hyp-stmt"><Statement text={h.statement} values={valuesOf([...h.supporting_observation_ids, ...h.contradicting_observation_ids])} /></p>
              <ObsRefs label="Supported by" ids={h.supporting_observation_ids} obsById={obsById} kind="for" />
              <ObsRefs label="Contradicted by" ids={h.contradicting_observation_ids} obsById={obsById} kind="against" />
            </li>
          ))}
        </ol>
      </section>

      <section className="sec" aria-labelledby="h-obs">
        <h2 id="h-obs">Observations</h2>
        <ul className="obs">
          {r.observations.map((o) => (
            <li key={o.id} id={o.id} data-testid={`obs-${o.id}`}>
              <span className="muted id">{o.id}</span>
              <p><Statement text={o.statement} values={o.values} /></p>
              <p className="cites">{o.evidence_ids.map((e) => <EvidenceChip key={e} id={e} />)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="sec" aria-labelledby="h-tl">
        <h2 id="h-tl">Timeline</h2>
        {r.timeline.length === 0 ? <p className="muted">No timeline events.</p> : (
          <ol className="timeline">
            {r.timeline.map((t, i) => (
              <li key={i}>
                <time dateTime={t.at}>{clock(t.at)}</time>
                <span>{t.event}</span>
                <span className="cites">{t.evidence_ids.map((e) => <EvidenceChip key={e} id={e} />)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="sec" aria-labelledby="h-rec">
        <h2 id="h-rec">Recommendations</h2>
        {r.recommendations.length === 0 ? <p className="muted">No recommendations.</p> : (
          <ul className="recs">
            {r.recommendations.map((rec, i) => (
              <li key={i}>
                <p><strong>{rec.action}</strong></p>
                <p className="muted">{rec.rationale}</p>
                <p className="rec-meta"><span className={`risk risk-${rec.risk}`}>{rec.risk} risk</span> for {rec.hypothesis_id}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sec gaps" aria-labelledby="h-gaps" data-testid="gaps">
        <h2 id="h-gaps">What this investigation could not check</h2>
        {r.gaps.length === 0 ? <p className="muted">The report lists no gaps.</p> : <ul>{r.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>}
      </section>
    </>
  );
}

function ObsRefs({ label, ids, obsById, kind }: { label: string; ids: string[]; obsById: Map<string, Report['observations'][number]>; kind: 'for' | 'against' }) {
  if (ids.length === 0) return <p className="muted refs-empty">{label}: none.</p>;
  return (
    <div className={`refs refs-${kind}`}>
      <p className="refs-label">{label}</p>
      <ul>
        {ids.map((id) => {
          const o = obsById.get(id);
          return (
            <li key={id}>
              <span className="muted id">{id}</span>{' '}
              {o ? <Statement text={o.statement} values={o.values} /> : <span className="bad">unknown observation</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
