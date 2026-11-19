import { useState } from 'react';
import { METRIC_TEMPLATES, ReportApi } from '@traceops/contracts';
import type { Api, Incident, InvestigationRow, ReportRow } from '../api.ts';
import { between, clock, dateTime, duration, elapsed, exact, formatWithUnit, offset } from '../lib/format.ts';
import { useLoad, useNow } from '../lib/useLoad.ts';
import { CATEGORY, Confidence, Proof, Severity, Status } from '../ui/Badge.tsx';
import { ApiProblem, Empty, NotFound, Skeleton } from '../ui/States.tsx';

type Row = { inv: InvestigationRow; report: ReportRow | null };

const unitOf = (query: string): string | null => (METRIC_TEMPLATES as Record<string, { unit: string }>)[query]?.unit ?? null;

export function IncidentPage({ api, id }: { api: Api; id: string }) {
  const incident = useLoad(() => api.getIncident(id), [api, id]);
  const rows = useLoad<Row[]>(async () => {
    const invs = await api.listInvestigations(id);
    return Promise.all(invs.map(async (inv) => ({ inv, report: inv.status === 'running' ? null : await api.getReport(inv.id) })));
  }, [api, id], (d) => (d?.some((r) => r.inv.status === 'running') ? 2000 : null));
  const running = !!rows.data?.some((r) => r.inv.status === 'running');
  const now = useNow(running);
  const [queued, setQueued] = useState<string | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);

  if (incident.error) return <main className="page"><ApiProblem text={incident.error} onRetry={incident.reload} /></main>;
  if (!incident.data) return <main className="page">{incident.loading ? <Skeleton rows={4} label="Loading incident" /> : <NotFound what="incident" />}</main>;
  const i = incident.data;

  const rerun = async () => {
    setRerunError(null);
    try { setQueued((await api.rerun(id)).job_id); rows.reload(); } catch (e) { setRerunError(e instanceof Error ? e.message : String(e)); }
  };
  const latest = rows.data?.[0];

  return (
    <main className="page">
      <nav className="crumbs" aria-label="Breadcrumb"><a href="#/">Incidents</a><span aria-hidden="true">/</span><span>{i.service}</span></nav>
      <IncidentHead incident={i} />

      {latest && <LatestVerdict row={latest} incident={i} now={now} />}

      <section className="sec" aria-labelledby="h-invs">
        <h2 id="h-invs">Investigations {rows.data && <span className="count">{rows.data.length}</span>}</h2>
        <div className="actions">
          <button type="button" className="btn" onClick={rerun}>Run a new investigation</button>
          {queued && <span className="quiet" role="status">Investigation queued (job {queued.slice(0, 8)}). It appears below when a worker picks it up.</span>}
          {rerunError && <span className="fault-text" role="alert">Could not queue it: {rerunError}</span>}
        </div>
        {rows.error && <ApiProblem text={rows.error} onRetry={rows.reload} />}
        {rows.loading && !rows.data && <Skeleton rows={3} label="Loading investigations" />}
        {rows.data && rows.data.length === 0 && <Empty title="No investigations yet.">The worker starts one automatically when the incident opens, or run one now.</Empty>}
        {rows.data && rows.data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Status</th><th scope="col">Started</th><th scope="col" className="hide-sm">Trigger</th><th scope="col" className="hide-sm">Model</th><th scope="col" className="r">Tool calls</th><th scope="col" className="r">Duration</th><th scope="col">Proof</th></tr></thead>
              <tbody>
                {rows.data.map(({ inv, report }) => {
                  const d = inv.finished_at ? between(inv.started_at, inv.finished_at) : null;
                  return (
                    <tr key={inv.id}>
                      <td><Status value={inv.status} /></td>
                      <td><a href={`#/investigations/${inv.id}`} className="num-cell" aria-label={`Investigation ${clock(inv.started_at)}: ${inv.status}, ${inv.tool_calls} tool calls`}>{clock(inv.started_at)}</a></td>
                      <td className="hide-sm">{inv.trigger === 'auto' ? 'automatic' : 'manual'}</td>
                      <td className="quiet hide-sm">{inv.model}</td>
                      <td className="r num-cell">{inv.tool_calls}</td>
                      <td className="r num-cell">{inv.status === 'running' ? <span className="tone-live">{elapsed(now - Date.parse(inv.started_at))}</span> : d !== null ? duration(d) : '—'}</td>
                      <td>{inv.status === 'running' ? <span className="quiet">—</span> : <Proof row={report} compact />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function IncidentHead({ incident: i }: { incident: Incident }) {
  return (
    <header className="inc-head">
      <h1 className="page-title"><Severity value={i.severity} /> {i.service} <Status value={i.status} /></h1>
      <dl className="inc-times">
        <div><dt>Symptoms started</dt><dd>{dateTime(i.started_at)}</dd></div>
        <div><dt>Detected</dt><dd>{clock(i.detected_at)} <span className="quiet">{offset(i.started_at, i.detected_at)}</span></dd></div>
        <div><dt>Resolved</dt><dd>{i.resolved_at ? <>{clock(i.resolved_at)} <span className="quiet">{offset(i.started_at, i.resolved_at)}</span></> : <span className="quiet">not yet</span>}</dd></div>
        {i.reopen_count > 0 && <div><dt>Reopened</dt><dd>{i.reopen_count}×</dd></div>}
      </dl>
      <ul className="triggers" aria-label="Detector rules that fired">
        {i.trigger.map((t, n) => {
          const unit = unitOf(t.query);
          const top = Math.max(t.observed, t.threshold) || 1;
          return (
            <li key={n} className="trigger">
              <div>
                <span className="trigger-rule">{t.rule_id}</span>
                <p className="trigger-vals">
                  {t.query} observed <b title={`exact ${exact(t.observed)}`}>{formatWithUnit(t.observed, unit, true)}</b> against a threshold of{' '}
                  <span className="num-cell" title={`exact ${exact(t.threshold)}`}>{formatWithUnit(t.threshold, unit, true)}</span>
                  <span className="sub"> at {clock(t.at)}, from the detector</span>
                </p>
              </div>
              <div className="over" role="img" aria-label={`observed is ${t.threshold ? sigRatio(t.observed / t.threshold) : '—'} times the threshold`}>
                <div className="over-fill" style={{ width: `${(t.observed / top) * 100}%` }} />
                <div className="over-th" style={{ left: `calc(${(t.threshold / top) * 100}% - 1px)` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </header>
  );
}

const sigRatio = (x: number) => (x >= 10 ? Math.round(x).toString() : x.toPrecision(2));

function LatestVerdict({ row, incident, now }: { row: Row; incident: Incident; now: number }) {
  const { inv, report } = row;
  const parsed = report ? ReportApi.safeParse(report.report) : null;
  const top = parsed?.success ? parsed.data.hypotheses[0] : undefined;
  const ttr = inv.finished_at ? between(incident.detected_at, inv.finished_at) : null;
  return (
    <section className="latest" aria-label="Latest investigation">
      {inv.status === 'running' ? (
        <><span className="pulse" aria-hidden="true" /><span className="hyp-name">Investigating</span><span className="num-cell quiet">{elapsed(now - Date.parse(inv.started_at))}</span></>
      ) : top ? (
        <><span className="hyp-name">{CATEGORY[top.category] ?? top.category}</span><Confidence value={top.confidence} /><Proof row={report} /></>
      ) : (
        <span className="hyp-name">{inv.status === 'failed' ? 'Latest investigation failed' : report ? 'Report has no hypothesis' : 'No report'}</span>
      )}
      {ttr !== null && report && <span className="quiet">report <span className="num-cell">{duration(ttr)}</span> after detection</span>}
      <a href={`#/investigations/${inv.id}`}>Open the latest investigation</a>
    </section>
  );
}
