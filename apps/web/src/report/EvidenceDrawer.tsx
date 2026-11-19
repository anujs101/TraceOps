import { useContext, useEffect, useRef, useState } from 'react';
import { resolveField, valueMatches } from '@traceops/contracts';
import type { Evidence } from '../api.ts';
import { baselineFor, evidenceLabel, markIndex, seriesOf, TOOL_LABEL, unitFor } from '../lib/evidence.ts';
import { between, clock, duration, exact, formatWithUnit, windowRange } from '../lib/format.ts';
import { Status } from '../ui/Badge.tsx';
import { Chart } from '../ui/Chart.tsx';
import { EvidenceContext, SourceIcon, type Selection } from './Statement.tsx';

/** The evidence behind a number or a reference: claim check, chart, query, window, status, stats and raw result. */
export function EvidenceDrawer({ selection, evidence, onClose }: { selection: Selection; evidence: Evidence | undefined; onClose: () => void }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, [selection]);

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" aria-label={`Evidence ${selection.evidenceId}`} data-testid="evidence-panel">
        <div className="drawer-head">
          <div>
            <h2 ref={head} tabIndex={-1}>{evidence ? evidenceLabel(evidence) : selection.evidenceId}</h2>
            {evidence && (
              <p className="drawer-sub">
                <SourceIcon source={evidence.source} /> {evidence.source === 'prometheus' ? 'Metrics (Prometheus)' : 'Logs (Loki)'}, {TOOL_LABEL[evidence.tool]?.toLowerCase() ?? evidence.tool}
              </p>
            )}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close evidence">✕</button>
        </div>
        {evidence ? <Body selection={selection} evidence={evidence} /> : (
          <p className="fault-text" role="alert">The report cites {selection.evidenceId}, but no such evidence was stored for this investigation.</p>
        )}
      </aside>
    </>
  );
}

function Body({ selection, evidence: e }: { selection: Selection; evidence: Evidence }) {
  const { all, incidentStart } = useContext(EvidenceContext);
  const unit = unitFor(e, selection.field);
  const resolved = selection.field ? resolveField(e, selection.field) : undefined;
  const matches = selection.claimed !== undefined && resolved !== undefined && valueMatches(selection.claimed, resolved);
  const pts = seriesOf(e);
  const base = baselineFor(e, all);
  const step = (e.result as { step_s?: unknown } | null)?.step_s;
  const span = e.window ? between(e.window.start, e.window.end) : null;
  const stats = Object.entries(e.stats);

  return (
    <div className="drawer-body">
      {selection.field && selection.claimed !== undefined && (
        <div className={`claim ${matches ? 'claim-ok' : 'claim-bad'}`} data-testid="claim">
          <div className="claim-main">
            <span className="claim-k">Report says</span>
            <span className="claim-v">{formatWithUnit(selection.claimed, unit, true)}</span>
            <span className="claim-exact">exact <Copyable text={exact(selection.claimed)} testId="claim-exact" /></span>
          </div>
          <div className="claim-main">
            <span className="claim-k">Evidence <code>{selection.field}</code></span>
            <span className="claim-v">{resolved === undefined ? 'not found' : formatWithUnit(resolved, unit, true)}</span>
            {resolved !== undefined && <span className="claim-exact">exact <code>{exact(resolved)}</code></span>}
          </div>
          <p className="claim-verdict">
            <span aria-hidden="true">{matches ? '✓ ' : '! '}</span>
            {resolved === undefined ? 'This field does not exist in the evidence.' : matches ? 'Matches the evidence.' : 'Does not match the evidence.'}
          </p>
        </div>
      )}

      {pts && (
        <figure className="drawer-chart">
          <Chart points={pts} unit={unitFor(e)} size="drawer" splitAt={incidentStart} baseline={base?.avg} mark={markIndex(e, selection.field, pts)} />
          <figcaption>
            <span className="chart-legend">
              {incidentStart && Date.parse(pts[0]![0]) < Date.parse(incidentStart) && <span className="lg lg-lead">before start</span>}
              <span className="lg lg-inc">incident</span>
              {base && <span className="lg lg-base">baseline avg {formatWithUnit(base.avg, unitFor(e), true)}</span>}
            </span>
          </figcaption>
        </figure>
      )}

      <dl className="facts">
        <dt>Status</dt>
        <dd data-testid="ev-status"><Status value={e.status} />{e.error && <span className="fault-text"> {e.error}</span>}</dd>
        <dt>Window</dt>
        <dd>
          <span data-testid="ev-window">{windowRange(e.window)}</span>
          {span !== null && <span className="quiet"> ({duration(span)}{typeof step === 'number' ? `, step ${step} s` : ''})</span>}
        </dd>
        <dt>Query</dt>
        <dd>{e.rendered_query ? <Copyable text={e.rendered_query} testId="ev-query" block /> : <span className="quiet">Nothing was sent to the backend.</span>}</dd>
        <dt>Arguments</dt>
        <dd><pre className="code small">{JSON.stringify(e.args)}</pre></dd>
      </dl>

      {stats.length > 0 && (
        <table className="stats">
          <caption>Stats the report may cite</caption>
          <thead><tr><th scope="col">Field</th><th scope="col" className="r">Value</th><th scope="col" className="r">Exact</th></tr></thead>
          <tbody>
            {stats.map(([k, v]) => (
              <tr key={k} className={k === selection.field ? 'is-active' : undefined}>
                <th scope="row"><code>{k}</code></th>
                <td className="r num-cell">{formatWithUnit(v, unitFor(e, k), true)}</td>
                <td className="r num-cell exact-cell">{exact(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details className="raw" open={!selection.field}>
        <summary>Result the model saw</summary>
        <pre className="code small" data-testid="ev-result">{JSON.stringify(e.result, null, 2)}</pre>
      </details>

      <p className="drawer-id">Evidence id <code>{e.id}</code>, recorded {clock(e.created_at)} UTC in {duration(e.duration_ms)}</p>
    </div>
  );
}

function Copyable({ text, testId, block = false }: { text: string; testId?: string; block?: boolean }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* clipboard blocked: text stays selectable */ }
  };
  return (
    <span className={block ? 'copy copy-block' : 'copy'}>
      {block ? <pre className="code" data-testid={testId}>{text}</pre> : <code data-testid={testId}>{text}</code>}
      <button type="button" className="copy-btn" onClick={copy} aria-label="Copy">{done ? 'Copied' : 'Copy'}</button>
    </span>
  );
}
