/** Right rail: investigation facts and the compact timeline (sticky on laptops). */
import type { ReactNode } from 'react';
import type { Report } from '@traceops/contracts';
import type { Evidence, Incident, InvestigationRow, LlmCall, ReportRow } from '../api.ts';
import { between, clock, duration, offset } from '../lib/format.ts';
import { Card, CardHeader } from '../ui/Card.tsx';
import { EvidenceRef, Statement } from './Statement.tsx';
import { allValues, timeToReport } from './Verdict.tsx';

export function Facts({ inv, incident, row, evidence, calls }: { inv: InvestigationRow; incident: Incident | null; row: ReportRow | null; evidence: Evidence[]; calls: LlmCall[] }) {
  const ttr = timeToReport(incident, inv);
  const ran = inv.finished_at ? between(inv.started_at, inv.finished_at) : null;
  const tokIn = calls.reduce((s, c) => s + (c.input_tokens ?? 0), 0);
  const tokOut = calls.reduce((s, c) => s + (c.output_tokens ?? 0), 0);
  const ok = evidence.filter((e) => e.status === 'ok').length;
  return (
    <Card aria-labelledby="h-facts" className="facts-card">
      <CardHeader id="h-facts" title="Investigation" />
      <dl className="factlist">
        <div className="fact fact-hero"><dt>Detection to report</dt><dd data-testid="ttr">{ttr === null || !row ? '—' : duration(ttr)}</dd></div>
        <div className="fact"><dt>Symptoms started</dt><dd>{clock(incident?.started_at)}</dd></div>
        <div className="fact"><dt>Detected</dt><dd>{clock(incident?.detected_at)} <span className="sub">{offset(incident?.started_at, incident?.detected_at)}</span></dd></div>
        <div className="fact"><dt>Run time</dt><dd>{ran === null ? '—' : duration(ran)}</dd></div>
        <div className="fact"><dt>Tool calls</dt><dd>{inv.tool_calls} <span className="sub">{ok} ok of {evidence.length}</span></dd></div>
        <div className="fact"><dt>Model</dt><dd>{inv.model}</dd></div>
        <div className="fact"><dt>Tokens</dt><dd>{tokIn.toLocaleString('en-US')} <span className="sub">in</span> {tokOut.toLocaleString('en-US')} <span className="sub">out</span></dd></div>
      </dl>
    </Card>
  );
}

export function Timeline({ r, incident }: { r: Report; incident: Incident | null }) {
  const values = allValues(r);
  type Row = { at: string; node: ReactNode; refs: string[]; detector?: boolean };
  const rows: Row[] = r.timeline.map((t) => ({ at: t.at, node: <Statement text={t.event} values={values} />, refs: t.evidence_ids }));
  if (incident) {
    rows.push({ at: incident.started_at, node: 'Symptoms started (detector)', refs: [], detector: true });
    rows.push({ at: incident.detected_at, node: `Detected: ${incident.trigger.map((t) => t.rule_id).join(', ')} (detector)`, refs: [], detector: true });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const ref = incident?.started_at ?? rows[0]?.at;
  return (
    <Card aria-labelledby="h-tl" className="timeline-card">
      <CardHeader id="h-tl" title="Timeline" />
      {r.timeline.length === 0 ? <p className="card-empty">The report has no timeline events.</p> : (
        <ol className="timeline">
          {rows.map((t, i) => (
            <li key={i} className={t.detector ? 'is-detector' : undefined}>
              <div className="tl-time"><time dateTime={t.at}>{clock(t.at)}</time><span className="tl-off">{offset(ref, t.at)}</span></div>
              <div className="tl-event">{t.node}</div>
              {t.refs.length > 0 && <div className="refs">{t.refs.map((e) => <EvidenceRef key={e} id={e} />)}</div>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
