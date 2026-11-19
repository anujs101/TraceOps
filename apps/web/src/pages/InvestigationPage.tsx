import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReportApi, type Report } from '@traceops/contracts';
import type { Api, Evidence, Incident, InvestigationRow, LlmCall, ReportRow } from '../api.ts';
import { clock, elapsed } from '../lib/format.ts';
import { useLoad, useNow } from '../lib/useLoad.ts';
import { EvidenceDrawer } from '../report/EvidenceDrawer.tsx';
import { EvidenceLedger, ModelCalls } from '../report/EvidenceLedger.tsx';
import { Facts, Timeline } from '../report/Rail.tsx';
import { Gaps, Hypotheses, Observations, Recommendations } from '../report/Sections.tsx';
import { Signals } from '../report/Signals.tsx';
import { EvidenceContext, type Selection } from '../report/Statement.tsx';
import { ValidationBanner } from '../report/Validation.tsx';
import { Verdict } from '../report/Verdict.tsx';
import { Severity, Status } from '../ui/Badge.tsx';
import { Card } from '../ui/Card.tsx';
import { TopBar } from '../ui/Shell.tsx';
import { ApiProblem, NotFound, Skeleton } from '../ui/States.tsx';
import { TimeRuler } from '../ui/TimeRuler.tsx';

type Data = { inv: InvestigationRow; incident: Incident | null; evidence: Evidence[]; report: ReportRow | null; calls: LlmCall[] };

export function InvestigationPage({ api, id, onIncident }: { api: Api; id: string; onIncident?: (id: string | null) => void }) {
  const load = useLoad<Data | null>(async () => {
    const inv = await api.getInvestigation(id);
    if (!inv) return null;
    const [incident, evidence, report, calls] = await Promise.all([api.getIncident(inv.incident_id), api.listEvidence(id), api.getReport(id), api.listLlmCalls(id)]);
    return { inv, incident, evidence, report, calls };
  }, [api, id], (d) => (d?.inv.status === 'running' ? 2000 : null));

  const [selected, setSelected] = useState<Selection | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback((s: Selection) => {
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('.drawer')) opener.current = document.activeElement;
    setSelected(s);
  }, []);
  const close = useCallback(() => { setSelected(null); opener.current?.focus(); }, []);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, close]);

  const incidentId = load.data?.inv.incident_id ?? null;
  useEffect(() => { onIncident?.(incidentId); }, [incidentId, onIncident]);

  const evidence = load.data?.evidence;
  const byId = useMemo(() => new Map((evidence ?? []).map((e) => [e.id, e])), [evidence]);
  const running = load.data?.inv.status === 'running';
  const now = useNow(running);

  const crumbsBase = <a href="#/">Incidents</a>;
  if (load.error && !load.data) return <><TopBar crumbs={crumbsBase} /><main className="content"><ApiProblem text={load.error} onRetry={load.reload} /></main></>;
  if (!load.data) return <><TopBar crumbs={crumbsBase} /><main className="content">{load.loading ? <Skeleton rows={6} label="Loading investigation" /> : <NotFound what="investigation" />}</main></>;
  const { inv, incident, report, calls } = load.data;
  const parsed = report ? ReportApi.safeParse(report.report) : null;
  const r: Report | null = parsed?.success ? parsed.data : null;

  return (
    <EvidenceContext.Provider value={{ byId, all: load.data.evidence, incidentStart: incident?.started_at ?? null, selected, open }}>
      <TopBar crumbs={<>
        {crumbsBase}
        {incident && <><span className="crumb-sep" aria-hidden="true">/</span><a href={`#/incidents/${incident.id}`}>{incident.service}</a></>}
        <span className="crumb-sep" aria-hidden="true">/</span><span className="crumb-here">Investigation {clock(inv.started_at)}</span>
      </>}>
        <InvestigationActions inv={inv} incident={incident} api={api} onChange={load.reload} />
      </TopBar>
      <main className={`content inv${selected ? ' has-drawer' : ''}`}>
        {report && <ValidationBanner row={report} />}
        {load.error && <p className="stale" role="status">Live updates paused: {load.error}. Showing the last data.</p>}
        <div className="layout-2">
          <div className="col-main">
            {report ? (r ? <Verdict r={r} row={report} incident={incident} inv={inv} /> : <RawReport row={report} />) : <NoReport inv={inv} incident={incident} now={now} />}
            {r && <Signals r={r} />}
            {r && <Hypotheses r={r} />}
            {r && <Observations r={r} />}
            {r && <Recommendations r={r} />}
            {r && <Gaps r={r} />}
            <EvidenceLedger evidence={load.data.evidence} live={running} />
            <ModelCalls calls={calls} />
          </div>
          <aside className="rail" aria-label="Investigation summary">
            <Facts inv={inv} incident={incident} row={report} evidence={load.data.evidence} calls={calls} />
            {r && <Timeline r={r} incident={incident} />}
          </aside>
        </div>
      </main>
      {selected && <EvidenceDrawer selection={selected} evidence={byId.get(selected.evidenceId)} onClose={close} />}
    </EvidenceContext.Provider>
  );
}

function InvestigationActions({ inv, incident, api, onChange }: { inv: InvestigationRow; incident: Incident | null; api: Api; onChange: () => void }) {
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancel = async () => {
    setCancelError(null);
    try { await api.cancel(inv.id); onChange(); } catch (e) { setCancelError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="meta" aria-label="Investigation">
      {incident && <Severity value={incident.severity} />}
      <Status value={inv.status} />
      <span className="meta-quiet">{inv.trigger === 'auto' ? 'Automatic' : 'Manual'}</span>
      {inv.status === 'running' && (
        <button type="button" className="btn btn-quiet" onClick={cancel} disabled={inv.cancel_requested}>
          {inv.cancel_requested ? 'Cancelling…' : 'Cancel investigation'}
        </button>
      )}
      {cancelError && <span className="fault-text" role="alert">Could not cancel: {cancelError}</span>}
    </div>
  );
}

function RawReport({ row }: { row: ReportRow }) {
  return (
    <Card className="card-pad">
      <h2 className="card-title">Raw report</h2>
      <p className="quiet">The model's output does not have the report structure, so it is shown exactly as returned.</p>
      <pre className="code small">{JSON.stringify(row.report, null, 2)}</pre>
    </Card>
  );
}

function NoReport({ inv, incident, now }: { inv: InvestigationRow; incident: Incident | null; now: number }) {
  const marks = [
    { at: incident?.started_at ?? null, label: 'Symptoms started', tone: 'fault' as const },
    { at: incident?.detected_at ?? null, label: 'Detected', tone: 'fault' as const },
    { at: inv.started_at, label: 'Investigation began', tone: 'signal' as const },
  ];
  if (inv.status === 'running') {
    return (
      <section className="card verdict verdict-running" aria-live="polite">
        <p className="verdict-line"><span className="pulse" aria-hidden="true" /> <span className="verdict-status">Investigating</span></p>
        <h1 className="verdict-title">Collecting evidence</h1>
        <p className="verdict-stmt">
          <span className="num-cell" data-testid="elapsed">{elapsed(now - Date.parse(inv.started_at))}</span> elapsed,{' '}
          <span className="num-cell">{inv.tool_calls}</span> tool calls so far. The report appears here when the investigation finishes; this page refreshes every 2 s.
        </p>
        <TimeRuler marks={marks} now={now} />
      </section>
    );
  }
  if (inv.status === 'failed') {
    return (
      <section className="card verdict verdict-failed">
        <p className="verdict-line"><span className="verdict-status fault-text">Investigation failed</span></p>
        <div className="problem" role="alert">
          <p>The investigation stopped with an error, and no report was written.</p>
          <pre className="code">{inv.error ?? 'unknown error'}</pre>
          <p>Fix the cause, then run a new investigation from {incident ? <a href={`#/incidents/${incident.id}`}>the incident page</a> : 'the incident page'}.</p>
        </div>
        <TimeRuler marks={[...marks, { at: inv.finished_at, label: 'Failed', tone: 'fault' }]} />
      </section>
    );
  }
  return (
    <section className="card verdict">
      <p className="verdict-line"><span className="verdict-status">{inv.status === 'cancelled' ? 'Cancelled' : 'No report'}</span></p>
      <p className="quiet">{inv.status === 'cancelled' ? 'The investigation was cancelled before it wrote a report.' : 'No report was written.'}{inv.error ? ` ${inv.error}` : ''}</p>
    </section>
  );
}
