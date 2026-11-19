import { resolveField, valueMatches } from '@traceops/contracts';
import type { Evidence } from '../api.ts';
import { evidenceTitle, toolLabel, windowText } from '../format.ts';
import { EvidenceContext, type Selection } from './Statement.tsx';
import { useContext } from 'react';
import { Sparkline } from '../ui/Sparkline.tsx';
import { baselineFor, markIndex, seriesOf, unitFor } from '../lib/evidence.ts';
import { exact, formatWithUnit } from '../lib/format.ts';

/** The evidence behind a number or a citation: rendered query, window, status and result. */
export function EvidencePanel({ selection, evidence, onClose }: { selection: Selection; evidence: Evidence | undefined; onClose: () => void }) {
  const { all, incidentStart } = useContext(EvidenceContext);
  if (!evidence) {
    return (
      <aside className="panel" aria-label="Evidence">
        <PanelHead title={selection.evidenceId} onClose={onClose} />
        <p className="bad">This report cites {selection.evidenceId}, but no such evidence was stored for this investigation.</p>
      </aside>
    );
  }
  const resolved = selection.field ? resolveField(evidence, selection.field) : undefined;
  const matches = selection.claimed !== undefined && resolved !== undefined && valueMatches(selection.claimed, resolved);
  const series = seriesOf(evidence);
  const unit = unitFor(evidence, selection.field);

  return (
    <aside className="panel" aria-label={`Evidence ${evidence.id}`} data-testid="evidence-panel">
      <PanelHead title={`${evidence.id} · ${evidenceTitle(evidence)}`} onClose={onClose} />
      <p className="panel-sub">
        <span className={`src-tag src-${evidence.source}`}>{evidence.source === 'prometheus' ? 'Metrics (Prometheus)' : 'Logs (Loki)'}</span>{' '}
        {toolLabel[evidence.tool]}
      </p>

      {selection.field && (
        <div className={`claim ${resolved === undefined ? 'claim-bad' : matches ? 'claim-ok' : 'claim-bad'}`} data-testid="claim">
          <div>
            <span className="claim-k">Report says</span>
            <span className="claim-v">{formatWithUnit(selection.claimed!, unit, true)}</span><span className="claim-k">exact {exact(selection.claimed!)}</span>
          </div>
          <div>
            <span className="claim-k">Evidence <code>{selection.field}</code></span>
            <span className="claim-v">{resolved === undefined ? 'not found' : String(resolved)}</span>
          </div>
          <p>{resolved === undefined ? 'This field does not exist in the evidence.' : matches ? 'Matches the evidence.' : 'Does not match the evidence.'}</p>
        </div>
      )}

      <dl className="facts">
        <dt>Status</dt>
        <dd data-testid="ev-status"><span className={`status status-${evidence.status}`}>{evidence.status}</span>{evidence.error && <span className="bad"> {evidence.error}</span>}</dd>
        <dt>Window</dt>
        <dd data-testid="ev-window">{windowText(evidence.window)}</dd>
        <dt>Query</dt>
        <dd>{evidence.rendered_query ? <pre className="code" data-testid="ev-query">{evidence.rendered_query}</pre> : <span className="muted">Nothing was sent to the backend.</span>}</dd>
        <dt>Arguments</dt>
        <dd><pre className="code small">{JSON.stringify(evidence.args)}</pre></dd>
      </dl>

      {series && <Sparkline points={series} unit={unit} size="large" splitAt={incidentStart} baseline={baselineFor(evidence, all)?.avg} mark={markIndex(evidence, selection.field, series)} />}

      {Object.keys(evidence.stats).length > 0 && (
        <table className="stats">
          <caption>Stats the report may cite</caption>
          <tbody>
            {Object.entries(evidence.stats).map(([k, v]) => (
              <tr key={k} className={k === selection.field ? 'is-active' : undefined}><th scope="row"><code>{k}</code></th><td>{String(v)}</td></tr>
            ))}
          </tbody>
        </table>
      )}

      <details className="result" open={!selection.field}>
        <summary>Result the model saw</summary>
        <pre className="code small" data-testid="ev-result">{JSON.stringify(evidence.result, null, 2)}</pre>
      </details>
    </aside>
  );
}

function PanelHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="panel-head">
      <h2>{title}</h2>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Close evidence">✕</button>
    </div>
  );
}
