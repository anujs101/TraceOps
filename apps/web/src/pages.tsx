import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Api, Evidence, Incident, InvestigationRow, LlmCall, ReportRow } from './api.ts';
import { dateTime, evidenceTitle, windowText } from './format.ts';
import { EvidencePanel } from './report/EvidencePanel.tsx';
import { ReportView } from './report/ReportView.tsx';
import { EvidenceChip, EvidenceContext, type Selection } from './report/Statement.tsx';

type Load<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

function useLoad<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: (d: T | null) => number | null): Load<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  useEffect(() => {
    let live = true;
    run().then((data) => live && setState({ data, error: null, loading: false }), (e: unknown) => live && setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false })));
    return () => { live = false; };
  }, [run, tick]);
  const every = pollMs?.(state.data) ?? null;
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => setTick((n) => n + 1), every);
    return () => clearInterval(t);
  }, [every]);
  return { ...state, reload: () => setTick((n) => n + 1) };
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{value}</span>;
}

function Problem({ text }: { text: string }) {
  return <p className="problem" role="alert">Could not load from the TraceOps API ({text}). Check that it is running on port 4000.</p>;
}

// ── incident list ──────────────────────────────────────────────────────────

export function IncidentList({ api }: { api: Api }) {
  const { data, error, loading } = useLoad(() => api.listIncidents(), [api]);
  return (
    <main className="page">
      <h1>Incidents</h1>
      {error && <Problem text={error} />}
      {loading && !data && <p className="muted">Loading incidents…</p>}
      {data && data.length === 0 && <p className="muted">No incidents yet. The detector opens one when a symptom rule fires.</p>}
      {data && data.length > 0 && (
        <ul className="list">
          {data.map((i) => (
            <li key={i.id}>
              <a href={`#/incidents/${i.id}`} className="row-link">
                <span className={`sev sev-${i.severity}`}>{i.severity}</span>
                <span className="row-main"><strong>{i.service}</strong> {i.trigger.map((t) => t.rule_id).join(', ')}</span>
                <span className="muted">started {dateTime(i.started_at)}</span>
                <Status value={i.status} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

// ── incident ───────────────────────────────────────────────────────────────

export function IncidentPage({ api, id }: { api: Api; id: string }) {
  const incident = useLoad(() => api.getIncident(id), [api, id]);
  const invs = useLoad(() => api.listInvestigations(id), [api, id], (d) => (d?.some((r) => r.status === 'running') ? 2000 : null));
  const [queued, setQueued] = useState<string | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);

  if (incident.error) return <main className="page"><Problem text={incident.error} /></main>;
  if (!incident.data) return <main className="page"><p className="muted">{incident.loading ? 'Loading incident…' : 'No incident with this id.'}</p></main>;
  const i = incident.data;

  const rerun = async () => {
    setRerunError(null);
    try { setQueued((await api.rerun(id)).job_id); invs.reload(); } catch (e) { setRerunError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <main className="page">
      <p className="crumbs"><a href="#/">Incidents</a></p>
      <IncidentHead incident={i} />
      <div className="actions">
        <button type="button" className="btn" onClick={rerun}>Run a new investigation</button>
        {queued && <span className="muted" role="status">Investigation queued (job {queued.slice(0, 8)}).</span>}
        {rerunError && <span className="bad" role="alert">Could not queue it: {rerunError}</span>}
      </div>
      <h2>Investigations</h2>
      {invs.error && <Problem text={invs.error} />}
      {invs.data && invs.data.length === 0 && <p className="muted">No investigations yet.</p>}
      <ul className="list">
        {invs.data?.map((r) => (
          <li key={r.id}>
            <a href={`#/investigations/${r.id}`} className="row-link">
              <Status value={r.status} />
              <span className="row-main">{r.trigger === 'auto' ? 'Automatic' : 'Manual'} · {r.tool_calls} tool calls · {r.model}</span>
              <span className="muted">{dateTime(r.started_at)}</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

function IncidentHead({ incident: i }: { incident: Incident }) {
  return (
    <header className="inc-head">
      <h1><span className={`sev sev-${i.severity}`}>{i.severity}</span> {i.service}</h1>
      <p className="muted">Started {dateTime(i.started_at)}, detected {dateTime(i.detected_at)} · <Status value={i.status} /></p>
      <ul className="triggers">
        {i.trigger.map((t, n) => <li key={n}><code>{t.rule_id}</code> observed {t.observed} against a threshold of {t.threshold}</li>)}
      </ul>
    </header>
  );
}

// ── investigation ──────────────────────────────────────────────────────────

type InvestigationData = { inv: InvestigationRow; incident: Incident | null; evidence: Evidence[]; report: ReportRow | null; calls: LlmCall[] };

export function InvestigationPage({ api, id }: { api: Api; id: string }) {
  const load = useLoad<InvestigationData | null>(async () => {
    const inv = await api.getInvestigation(id);
    if (!inv) return null;
    const [incident, evidence, report, calls] = await Promise.all([api.getIncident(inv.incident_id), api.listEvidence(id), api.getReport(id), api.listLlmCalls(id)]);
    return { inv, incident, evidence, report, calls };
  }, [api, id], (d) => (d?.inv.status === 'running' ? 2000 : null));
  const [selected, setSelected] = useState<Selection | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const byId = useMemo(() => new Map((load.data?.evidence ?? []).map((e) => [e.id, e])), [load.data]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  if (load.error) return <main className="page"><Problem text={load.error} /></main>;
  if (!load.data) return <main className="page"><p className="muted">{load.loading ? 'Loading investigation…' : 'No investigation with this id.'}</p></main>;
  const { inv, incident, evidence, report, calls } = load.data;

  const cancel = async () => {
    setCancelError(null);
    try { await api.cancel(id); load.reload(); } catch (e) { setCancelError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <EvidenceContext.Provider value={{ byId, all: evidence, incidentStart: incident?.started_at ?? null, selected, open: setSelected }}>
      <div className={`inv-layout${selected ? ' has-panel' : ''}`}>
        <main className="page inv-main">
          <p className="crumbs"><a href="#/">Incidents</a>{incident && <> / <a href={`#/incidents/${incident.id}`}>{incident.service}</a></>}</p>
          {incident && <IncidentHead incident={incident} />}

          <section className="inv-meta" aria-label="Investigation">
            <Status value={inv.status} />
            <span>{inv.trigger === 'auto' ? 'Automatic' : 'Manual'} investigation with {inv.model}</span>
            <span className="muted">{dateTime(inv.started_at)}{inv.finished_at ? ` to ${dateTime(inv.finished_at)}` : ''}</span>
            <span className="muted">{inv.tool_calls} tool calls</span>
            {inv.status === 'running' && (
              <button type="button" className="btn btn-quiet" onClick={cancel} disabled={inv.cancel_requested}>
                {inv.cancel_requested ? 'Cancelling…' : 'Cancel investigation'}
              </button>
            )}
            {cancelError && <span className="bad" role="alert">Could not cancel: {cancelError}</span>}
          </section>
          {inv.error && <p className="problem" role="alert">The investigation failed: {inv.error}</p>}

          {report ? <ReportView row={report} /> : (
            <p className="muted empty-report">
              {inv.status === 'running' ? 'The investigation is running. The report appears here when it finishes.'
                : inv.status === 'cancelled' ? 'The investigation was cancelled before it wrote a report.'
                : 'No report was written.'}
            </p>
          )}

          <section className="sec" aria-labelledby="h-ev">
            <h2 id="h-ev">All evidence ({evidence.length})</h2>
            {evidence.length === 0 ? <p className="muted">No tool calls were made.</p> : (
              <ul className="ledger">
                {evidence.map((e) => (
                  <li key={e.id}>
                    <EvidenceChip id={e.id} />
                    <span>{evidenceTitle(e)}</span>
                    <span className={`status status-${e.status}`}>{e.status}</span>
                    <span className="muted">{windowText(e.window)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <LlmCalls calls={calls} />
        </main>
        {selected && <EvidencePanel selection={selected} evidence={byId.get(selected.evidenceId)} onClose={() => setSelected(null)} />}
      </div>
    </EvidenceContext.Provider>
  );
}

function LlmCalls({ calls }: { calls: LlmCall[] }) {
  const total = (k: 'input_tokens' | 'output_tokens') => calls.reduce((s, c) => s + (c[k] ?? 0), 0);
  return (
    <section className="sec" aria-labelledby="h-llm">
      <h2 id="h-llm">Model calls ({calls.length})</h2>
      {calls.length === 0 ? <p className="muted">No model calls were recorded.</p> : (
        <div className="table-wrap">
          <table className="calls">
            <thead><tr><th>Turn</th><th>Try</th><th>Stage</th><th>Result</th><th className="r">Input tokens</th><th className="r">Output tokens</th><th className="r">Latency</th></tr></thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td>{c.turn}</td><td>{c.attempt}</td><td>{c.stage}</td>
                  <td>{c.status === 'ok' ? (c.stop_reason ?? 'ok') : <span className="bad">{c.error_kind}{c.error_status ? ` (${c.error_status})` : ''}</span>}</td>
                  <td className="r">{c.input_tokens ?? '—'}</td><td className="r">{c.output_tokens ?? '—'}</td><td className="r">{c.latency_ms} ms</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={4}>Total</td><td className="r">{total('input_tokens')}</td><td className="r">{total('output_tokens')}</td><td /></tr></tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
