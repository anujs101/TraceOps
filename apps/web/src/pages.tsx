import { useCallback, useEffect, useState } from 'react';
import type { Api, Incident } from './api.ts';
import { dateTime } from './format.ts';

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

