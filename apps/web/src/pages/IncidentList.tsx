import type { MouseEvent } from 'react';
import type { Api } from '../api.ts';
import { between, clock, duration, elapsed, relative } from '../lib/format.ts';
import { summariseAll, type IncidentSummary } from '../lib/summaries.ts';
import { useLoad, useNow } from '../lib/useLoad.ts';
import { CATEGORY, Confidence, Proof, Severity, Status } from '../ui/Badge.tsx';
import { ApiProblem, Empty, Skeleton } from '../ui/States.tsx';

export function IncidentList({ api }: { api: Api }) {
  const load = useLoad(() => summariseAll(api), [api], (d) => (d?.some((s) => s.latest?.status === 'running') ? 2000 : null));
  const running = !!load.data?.some((s) => s.latest?.status === 'running');
  const now = useNow(running || !!load.data, running ? 1000 : 30_000);

  return (
    <main className="page page-wide">
      <h1 className="page-title">Incidents {load.data && <span className="count">{load.data.length}</span>}</h1>
      {load.error && !load.data && <ApiProblem text={load.error} onRetry={load.reload} />}
      {load.error && load.data && <p className="stale" role="status">Live updates paused: {load.error}. Showing the last data.</p>}
      {load.loading && !load.data && !load.error && <Skeleton rows={5} label="Loading incidents" />}
      {load.data && load.data.length === 0 && (
        <Empty title="No incidents yet.">The detector opens one when a symptom rule fires on Prometheus.</Empty>
      )}
      {load.data && load.data.length > 0 && (
        <div className="table-wrap">
          <table className="inc-table">
            <thead>
              <tr>
                <th scope="col">Status</th><th scope="col">Severity</th><th scope="col">Service</th><th scope="col">Started</th>
                <th scope="col" className="r">To report</th><th scope="col">Top hypothesis</th><th scope="col">Proof</th>
              </tr>
            </thead>
            <tbody>{load.data.map((s) => <Row key={s.incident.id} s={s} now={now} />)}</tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function Row({ s, now }: { s: IncidentSummary; now: number }) {
  const { incident: i, latest, row, top } = s;
  const href = `#/incidents/${i.id}`;
  const ttr = latest?.finished_at ? between(i.detected_at, latest.finished_at) : null;
  const go = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('a')) window.location.hash = href.slice(1); };
  return (
    <tr onClick={go} data-testid={`inc-${i.id}`}>
      <td><Status value={i.status} /></td>
      <td><Severity value={i.severity} /></td>
      <td>
        <span className="stack">
          <a href={href} className="inc-svc">{i.service}</a>
          <span className="sub">{i.trigger.map((t) => t.rule_id).join(', ')}</span>
        </span>
      </td>
      <td>
        <span className="stack">
          <time className="num-cell" dateTime={i.started_at}>{clock(i.started_at)}</time>
          <span className="sub">{relative(i.started_at, now)}</span>
        </span>
      </td>
      <td className="r num-cell" data-testid="ttr">
        {latest?.status === 'running' ? <span className="tone-live">running {elapsed(now - Date.parse(latest.started_at))}</span>
          : ttr !== null && row ? duration(ttr) : <span className="quiet">—</span>}
      </td>
      <td className="inc-hyp">
        {top ? <><span className="hyp-name">{CATEGORY[top.category] ?? top.category}</span><Confidence value={top.confidence} /></>
          : <span className="quiet">{!latest ? 'Not investigated' : latest.status === 'running' ? 'Investigating…' : latest.status === 'failed' ? 'Investigation failed' : row ? 'No hypothesis' : 'No report'}</span>}
      </td>
      <td>{latest?.status === 'running' ? <span className="quiet">—</span> : <Proof row={row} compact />}</td>
    </tr>
  );
}
