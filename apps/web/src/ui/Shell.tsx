/**
 * App shell: sidebar (brand, nav, recent incidents, API status, theme) and a
 * main column. Pages render their own <TopBar> and content inside <main>.
 */
import type { ReactNode } from 'react';
import { clock, relative } from '../lib/format.ts';
import type { IncidentSummary } from '../lib/summaries.ts';
import type { Load } from '../lib/useLoad.ts';

export type Theme = 'dark' | 'light' | 'system';

export function Shell({ children, sums, activeIncident, theme, onTheme, route }: {
  children: ReactNode; sums: Load<IncidentSummary[]>; activeIncident: string | null; theme: Theme; onTheme: () => void; route: 'list' | 'incident' | 'investigation';
}) {
  const recent = (sums.data ?? []).slice(0, 8);
  const apiOk = !!sums.data && !sums.error;
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Navigation">
        <a href="#/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 16 16"><path d="M2 11.5 L6 7 L9 9.5 L14 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <span className="brand-name">TraceOps</span>
        </a>
        <nav className="side-nav">
          <a href="#/" className={`side-link${route === 'list' ? ' is-active' : ''}`}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <span>Incidents</span>
            {sums.data && <span className="side-count">{sums.data.length}</span>}
          </a>
        </nav>
        {recent.length > 0 && (
          <div className="side-section">
            <p className="side-label">Recent incidents</p>
            <ul className="side-recent" aria-label="Recent incidents">
              {recent.map((s) => {
                const proof = s.row ? (s.row.validation === 'passed' ? 'ok' : 'bad') : 'none';
                const running = s.latest?.status === 'running';
                return (
                  <li key={s.incident.id}>
                    <a href={`#/incidents/${s.incident.id}`} className={`side-inc${activeIncident === s.incident.id ? ' is-active' : ''}`}
                      title={`${s.incident.service}, started ${clock(s.incident.started_at)} UTC`}>
                      <span className={`dot sev-${s.incident.severity}`} aria-hidden="true" />
                      <span className="side-inc-main">
                        <span className="side-inc-svc">{s.incident.service}</span>
                        <span className="side-inc-sub">{clock(s.incident.started_at)} · {relative(s.incident.started_at)}</span>
                      </span>
                      <span className={`proof-dot proof-${running ? 'live' : proof}`} aria-label={running ? 'investigating' : proof === 'ok' ? 'validated' : proof === 'bad' ? 'unvalidated' : 'no report'} />
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="side-foot">
          <span className={`api-status ${apiOk ? 'is-ok' : sums.error ? 'is-bad' : ''}`} data-testid="api-status" title={sums.error ?? undefined}>
            <span className="dot" aria-hidden="true" />{apiOk ? 'API connected' : sums.error ? 'API unreachable' : 'Connecting…'}
          </span>
          <button type="button" className="theme-btn" onClick={onTheme} aria-label={`Theme: ${theme}. Change theme`} title={`Theme: ${theme}`}>
            {theme === 'light' ? <SunIcon /> : theme === 'dark' ? <MoonIcon /> : <AutoIcon />}
          </button>
        </div>
      </aside>
      <div className="main-col">{children}</div>
    </div>
  );
}

export function TopBar({ crumbs, children }: { crumbs: ReactNode; children?: ReactNode }) {
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">{crumbs}</nav>
      {children && <div className="topbar-actions">{children}</div>}
    </header>
  );
}

const SunIcon = () => <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
const MoonIcon = () => <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>;
const AutoIcon = () => <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" /></svg>;
