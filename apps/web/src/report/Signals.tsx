/**
 * Signals: one chart panel per metric evidence row the report cites, in report
 * order (max 6). Each panel shows the stored series with axes and the value the
 * report cites from it; the panel opens the drawer on that evidence.
 */
import { useContext } from 'react';
import type { Report } from '@traceops/contracts';
import { baselineFor, evidenceLabel, markIndex, seriesOf, unitFor } from '../lib/evidence.ts';
import { Card, CardHeader } from '../ui/Card.tsx';
import { Chart } from '../ui/Chart.tsx';
import { EvidenceContext, Num, SourceIcon, type BoundValue } from './Statement.tsx';

const PREFERRED = ['max', 'last', 'min', 'first'];

export function Signals({ r }: { r: Report }) {
  const { byId, all, incidentStart, open, selected } = useContext(EvidenceContext);
  const seen = new Set<string>();
  const panels: { id: string; value: BoundValue | undefined }[] = [];
  for (const o of r.observations) {
    for (const id of o.evidence_ids) {
      if (seen.has(id)) continue;
      const e = byId.get(id);
      if (!e || e.status !== 'ok' || (seriesOf(e)?.length ?? 0) < 2) continue;
      seen.add(id);
      const vs = r.observations.flatMap((x) => x.values).filter((v) => v.evidence_id === id);
      const value = PREFERRED.map((f) => vs.find((v) => v.field === f)).find(Boolean) ?? vs[0];
      panels.push({ id, value });
    }
  }
  if (panels.length === 0) return null;
  const shown = panels.slice(0, 6);
  return (
    <Card aria-labelledby="h-sig" className="signals-card">
      <CardHeader id="h-sig" title="Signals" meta={panels.length > shown.length ? `${shown.length} of ${panels.length}` : shown.length}
        actions={<a href="#h-ev" className="link-quiet">All evidence</a>} />
      <div className="signals">
        {shown.map(({ id, value }) => {
          const e = byId.get(id)!;
          const pts = seriesOf(e)!;
          const active = selected?.evidenceId === id;
          return (
            <div key={id} className={`panel${active ? ' is-active' : ''}`} data-testid={`signal-${id}`}>
              <div className="panel-h">
                <button type="button" className="panel-title" onClick={() => open({ evidenceId: id })} aria-label={`Show evidence ${id}: ${evidenceLabel(e)}`}>
                  <SourceIcon source={e.source} /><span>{evidenceLabel(e)}</span>
                </button>
                {value && <span className="panel-v"><Num v={value} withCountUnit /><span className="panel-f">{value.field.startsWith('series@') ? 'at a point' : value.field}</span></span>}
              </div>
              <button type="button" className="panel-body" onClick={() => open(value ? { evidenceId: id, field: value.field, claimed: value.value, label: value.key } : { evidenceId: id })}
                aria-label={`Open the ${evidenceLabel(e)} chart`}>
                <Chart points={pts} unit={unitFor(e)} splitAt={incidentStart} baseline={baselineFor(e, all)?.avg} mark={markIndex(e, value?.field, pts)} size="panel" />
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
