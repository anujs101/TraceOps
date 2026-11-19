import { useEffect, useState } from 'react';
import type { Api } from './api.ts';
import { IncidentList, IncidentPage } from './pages.tsx';
import { InvestigationPage } from './pages/InvestigationPage.tsx';

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => { setHash(window.location.hash); document.documentElement.scrollTop = 0; };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

type Theme = 'dark' | 'light' | 'system';
const THEME_KEY = 'traceops.theme';

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { const t = localStorage.getItem(THEME_KEY); return t === 'dark' || t === 'light' ? t : 'system'; } catch { return 'system'; }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    try { if (theme === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, theme); } catch { /* storage blocked */ }
  }, [theme]);
  const next = () => setTheme((t) => (t === 'system' ? 'dark' : t === 'dark' ? 'light' : 'system'));
  return [theme, next];
}

export function App({ api }: { api: Api }) {
  const hash = useHash();
  const [theme, nextTheme] = useTheme();
  const inc = /^#\/incidents\/([^/]+)$/.exec(hash);
  const inv = /^#\/investigations\/([^/]+)$/.exec(hash);
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          <svg className="brand-mark" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 10 L4.5 6 L7.5 8.5 L13 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          TraceOps
        </a>
        <button type="button" className="theme-btn" onClick={nextTheme} aria-label={`Theme: ${theme}. Change theme`}>
          {theme === 'system' ? 'Theme: system' : theme === 'dark' ? 'Theme: dark' : 'Theme: light'}
        </button>
      </header>
      {inv ? <InvestigationPage key={inv[1]} api={api} id={decodeURIComponent(inv[1]!)} />
        : inc ? <IncidentPage key={inc[1]} api={api} id={decodeURIComponent(inc[1]!)} />
        : <IncidentList api={api} />}
    </>
  );
}
