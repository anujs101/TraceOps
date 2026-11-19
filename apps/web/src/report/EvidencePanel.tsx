import { resolveField, valueMatches } from '@traceops/contracts';
import type { Evidence } from '../api.ts';
import { clock, evidenceTitle, toolLabel, windowText } from '../format.ts';
import type { Selection } from './Statement.tsx';

/** The evidence behind a number or a citation: rendered query, window, status and result. */
export function EvidencePanel({ selection, evidence, onClose }: { selection: Selection; evidence: Evidence | undefined; onClose: () => void }) {
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
  const seriesAt = selection.field?.match(/series@(.+)$/)?.[1];

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
            <span className="claim-v">{String(selection.claimed)}</span>
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

      {series && series.length > 1 && <Sparkline points={series} highlightAt={seriesAt} />}

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

function seriesOf(e: Evidence): [string, number][] | null {
  const r = e.result as { series?: unknown } | null;
  return e.tool === 'query_metric' && Array.isArray(r?.series) ? (r.series as [string, number][]) : null;
}

function Sparkline({ points, highlightAt }: { points: [string, number][]; highlightAt?: string }) {
  const W = 320, H = 72, P = 4;
  const vals = points.map((p) => p[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const x = (i: number) => P + (i * (W - 2 * P)) / (points.length - 1);
  const y = (v: number) => H - P - (max === min ? 0.5 : (v - min) / (max - min)) * (H - 2 * P);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const hi = highlightAt ? points.findIndex((p) => p[0] === highlightAt) : -1;
  return (
    <figure className="spark">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Series from ${clock(points[0]![0])} to ${clock(points.at(-1)![0])}, min ${min}, max ${max}`}>
        <path d={d} fill="none" />
        {hi >= 0 && <circle cx={x(hi)} cy={y(points[hi]![1])} r={4} />}
      </svg>
      <figcaption><span>{clock(points[0]![0])}</span><span>min {min} · max {max}</span><span>{clock(points.at(-1)![0])}</span></figcaption>
    </figure>
  );
}
