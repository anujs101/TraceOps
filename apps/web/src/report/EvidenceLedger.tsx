import { useContext } from 'react';
import type { Evidence, LlmCall } from '../api.ts';
import { evidenceLabel, headline, markIndex, seriesOf, TOOL_LABEL, unitFor } from '../lib/evidence.ts';
import { between, clock, duration, formatWithUnit, sig3 } from '../lib/format.ts';
import { Status } from '../ui/Badge.tsx';
import { Card, CardHeader } from '../ui/Card.tsx';
import { Chart } from '../ui/Chart.tsx';
import { EvidenceContext, SourceIcon } from './Statement.tsx';

/** Every tool call the investigation made, in order. Each row opens the drawer. */
export function EvidenceLedger({ evidence, live = false }: { evidence: Evidence[]; live?: boolean }) {
  const { open, selected, incidentStart } = useContext(EvidenceContext);
  return (
    <Card aria-labelledby="h-ev">
      <CardHeader id="h-ev" title="Evidence" meta={`${evidence.length}${live ? ', collecting' : ''}`} />
      {evidence.length === 0 ? <p className="card-empty">{live ? 'No tool calls yet.' : 'No tool calls were made.'}</p> : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr><th scope="col">What</th><th scope="col">Status</th><th scope="col">Window</th><th scope="col" className="r">Headline</th><th scope="col"><span className="sr-only">Series</span></th></tr>
            </thead>
            <tbody>
              {evidence.map((e) => {
                const h = headline(e);
                const pts = seriesOf(e);
                const span = e.window ? between(e.window.start, e.window.end) : null;
                return (
                  <tr key={e.id} className={selected?.evidenceId === e.id ? 'is-active' : undefined} data-testid={`ledger-${e.id}`}>
                    <td>
                      <button type="button" className="ledger-open" onClick={() => open({ evidenceId: e.id })} aria-label={`Show evidence ${e.id}: ${evidenceLabel(e)}`}>
                        <SourceIcon source={e.source} /> <span>{evidenceLabel(e)}</span>
                      </button>
                      <span className="ledger-tool">{TOOL_LABEL[e.tool]}</span>
                    </td>
                    <td><Status value={e.status} /></td>
                    <td>{e.window ? <span className="stack"><span className="num-cell">{clock(e.window.start)}–{clock(e.window.end)}</span><span className="sub">{span !== null ? duration(span) : ''}</span></span> : <span className="quiet">none</span>}</td>
                    <td className="r">{h ? <span className="stack"><span className="num-cell">{formatWithUnit(h.value, unitFor(e, h.field), true)}</span><span className="sub">{h.field}</span></span> : <span className="quiet">—</span>}</td>
                    <td>{pts && pts.length > 1 ? <Chart points={pts} unit={unitFor(e)} splitAt={incidentStart} mark={markIndex(e, 'max', pts)} size="micro" /> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function ModelCalls({ calls }: { calls: LlmCall[] }) {
  const sum = (k: 'input_tokens' | 'output_tokens' | 'latency_ms') => calls.reduce((s, c) => s + (c[k] ?? 0), 0);
  const errors = calls.filter((c) => c.status !== 'ok').length;
  return (
    <Card aria-labelledby="h-llm">
      <CardHeader id="h-llm" title="Model calls" meta={calls.length} />
      {calls.length === 0 ? <p className="card-empty">No model calls were recorded.</p> : (
        <details className="calls-wrap">
          <summary>
            {sum('input_tokens').toLocaleString('en-US')} tokens in, {sum('output_tokens').toLocaleString('en-US')} out, {duration(sum('latency_ms'))} total latency
            {errors > 0 && <span className="fault-text">, {errors} failed</span>}
          </summary>
          <div className="table-wrap">
            <table className="calls">
              <thead><tr><th>Turn</th><th>Try</th><th>Stage</th><th>Result</th><th className="r">Input tokens</th><th className="r">Output tokens</th><th className="r">Latency</th></tr></thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td className="num-cell">{c.turn}</td><td className="num-cell">{c.attempt}</td><td>{c.stage}</td>
                    <td>{c.status === 'ok' ? (c.stop_reason ?? 'ok') : <span className="fault-text">{c.error_kind}{c.error_status ? ` (${c.error_status})` : ''}</span>}</td>
                    <td className="r num-cell">{c.input_tokens?.toLocaleString('en-US') ?? '—'}</td>
                    <td className="r num-cell">{c.output_tokens?.toLocaleString('en-US') ?? '—'}</td>
                    <td className="r num-cell">{c.latency_ms < 1000 ? `${c.latency_ms} ms` : `${sig3(c.latency_ms / 1000)} s`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Card>
  );
}
