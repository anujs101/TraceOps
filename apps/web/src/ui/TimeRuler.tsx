/**
 * The incident's clock, from symptom start to report: where detection and the
 * investigation sit on it. Positions are proportional to real time.
 */
import { clock, offset } from '../lib/format.ts';

export type RulerMark = { at: string | null; label: string; tone?: 'fault' | 'signal' | 'proven' | 'quiet' };

export function TimeRuler({ marks, now }: { marks: RulerMark[]; now?: number }) {
  const known = marks.filter((m): m is RulerMark & { at: string } => !!m.at && !Number.isNaN(Date.parse(m.at)));
  if (known.length < 2 && now === undefined) return null;
  const t0 = Date.parse(known[0]!.at);
  const t1 = Math.max(now ?? 0, ...known.map((m) => Date.parse(m.at)));
  const span = t1 - t0 || 1;
  const pos = (t: number) => `${((t - t0) / span) * 100}%`;
  const open = now !== undefined; // still running: the right end is "now"
  return (
    <figure className={`ruler${open ? ' is-open' : ''}`} aria-label="Incident time ruler">
      <div className="ruler-track" aria-hidden="true">
        <div className="ruler-fill" style={{ width: pos(t1) }} />
        {known.map((m, i) => <span key={i} className={`ruler-tick tone-${m.tone ?? 'quiet'}`} style={{ left: pos(Date.parse(m.at)) }} />)}
      </div>
      <ol className="ruler-labels">
        {known.map((m, i) => (
          <li key={i} className={`tone-${m.tone ?? 'quiet'}`}>
            <span className="ruler-name">{m.label}</span>
            <time dateTime={m.at} className="ruler-time">{i === 0 ? clock(m.at) : offset(known[0]!.at, m.at)}</time>
          </li>
        ))}
        {open && <li className="tone-signal"><span className="ruler-name">now</span><span className="ruler-time">{offset(known[0]!.at, new Date(now!).toISOString())}</span></li>}
      </ol>
    </figure>
  );
}
