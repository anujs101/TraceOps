import type { MouseEvent } from 'react';
import { between, clock, duration, elapsed, relative } from '../lib/format.ts';
import type { IncidentSummary } from '../lib/summaries.ts';
import { useNow, type Load } from '../lib/useLoad.ts';
import { CATEGORY, Confidence, Proof, Severity, Status } from '../ui/Badge.tsx';
import { Card, CardHeader, Kpi } from '../ui/Card.tsx';
import { TopBar } from '../ui/Shell.tsx';
import { ApiProblem, Empty, Skeleton } from '../ui/States.tsx';

const ttrOf = (s: IncidentSummary) => (s.latest?.finished_at && s.row ? between(s.incident.detected_at, s.latest.finished_at) : null);

/** Display-only counts over the loaded incidents (not evidence; labelled as such). */
function kpis(list: IncidentSummary[]) {
  const open = list.filter((s) => s.incident.status === 'open').length;
  const reports = list.filter((s) => s.row);
  const validated = reports.filter((s) => s.row!.validation === 'passed').length;
  const ttrs = list.map(ttrOf).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const median = ttrs.length ? (ttrs.length % 2 ? ttrs[(ttrs.length - 1) / 2]! : (ttrs[ttrs.length / 2 - 1]! + ttrs[ttrs.length / 2]!) / 2) : null;
  const running = list.filter((s) => s.latest?.status === 'running').length;
  return { open, validated, reports: reports.length, median, running };
}

export function IncidentList({ sums: load }: { sums: Load<IncidentSummary[]> }) {
  const running = !!load.data?.some((s) => s.latest?.status === 'running');
  const now = useNow(running || !!load.data, running ? 1000 : 30_000);
  const k = load.data ? kpis(load.data) : null;

  return (
    <>
      <TopBar crumbs={<span className="crumb-here">Incidents</span>} />
      <main className="content">
        <div className="page-head">
          <h1 className="page-title">Incidents</h1>
          <p className="page-sub">Opened by the detector from Prometheus symptom rules, each investigated automatically.</p>
        </div>
        {load.error && !load.data && <ApiProblem text={load.error} onRetry={load.reload} />}
        {load.error && load.data && <p className="stale" role="status">Live updates paused: {load.error}. Showing the last data.</p>}
        {load.loading && !load.data && !load.error && <Skeleton rows={5} label="Loading incidents" />}
        {k && load.data!.length > 0 && (
          <div className="kpis" aria-label="Summary of loaded incidents">
            <Kpi label="Open incidents" value={k.open} sub={`of ${load.data!.length} loaded`} tone={k.open ? 'fault' : undefined} />
            <Kpi label="Reports validated" value={<>{k.validated}<span className="kpi-of"> / {k.reports}</span></>} sub="latest report per incident" tone={k.reports && k.validated === k.reports ? 'proven' : k.reports ? 'caution' : undefined} />
            <Kpi label="Median detection → report" value={k.median === null ? '—' : duration(k.median)} sub="latest investigation per incident" />
            <Kpi label="Investigating now" value={k.running} sub={k.running ? 'refreshing every 2 s' : 'none running'} tone={k.running ? 'accent' : undefined} />
          </div>
        )}
        {load.data && load.data.length === 0 && (
          <Empty title="No incidents yet.">The detector opens one when a symptom rule fires on Prometheus.</Empty>
        )}
        {load.data && load.data.length > 0 && (
          <Card aria-labelledby="h-inc">
            <CardHeader id="h-inc" title="All incidents" meta={load.data.length} />
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
          </Card>
        )}
      </main>
    </>
  );
}

function Row({ s, now }: { s: IncidentSummary; now: number }) {
  const { incident: i, latest, row, top } = s;
  const href = `#/incidents/${i.id}`;
  const ttr = ttrOf(s);
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
          : ttr !== null ? duration(ttr) : <span className="quiet">—</span>}
      </td>
      <td className="inc-hyp">
        {top ? <span className="hyp-inline"><span className="hyp-name">{CATEGORY[top.category] ?? top.category}</span><Confidence value={top.confidence} /></span>
          : <span className="quiet">{!latest ? 'Not investigated' : latest.status === 'running' ? 'Investigating…' : latest.status === 'failed' ? 'Investigation failed' : row ? 'No hypothesis' : 'No report'}</span>}
      </td>
      <td>{latest?.status === 'running' ? <span className="quiet">—</span> : <Proof row={row} compact />}</td>
    </tr>
  );
}
