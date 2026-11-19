import { useEffect, useState } from 'react';
import type { Api } from './api.ts';
import { summariseAll } from './lib/summaries.ts';
import { useLoad } from './lib/useLoad.ts';
import { IncidentList } from './pages/IncidentList.tsx';
import { IncidentPage } from './pages/IncidentPage.tsx';
import { InvestigationPage } from './pages/InvestigationPage.tsx';
import { Shell, type Theme } from './ui/Shell.tsx';

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => {
      // only route hashes (#/...) navigate; a plain in-page anchor (#validation) must not reset the page
      if (window.location.hash !== '' && !window.location.hash.startsWith('#/')) return;
      setHash(window.location.hash); document.documentElement.scrollTop = 0;
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

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
  return [theme, () => setTheme((t) => (t === 'system' ? 'dark' : t === 'dark' ? 'light' : 'system'))];
}

export function App({ api }: { api: Api }) {
  const hash = useHash();
  const [theme, nextTheme] = useTheme();
  const [invIncident, setInvIncident] = useState<string | null>(null);
  // one summary load feeds both the sidebar and the incident list
  const sums = useLoad(() => summariseAll(api), [api], (d) => (d?.some((s) => s.latest?.status === 'running') ? 2000 : 15_000));
  const inc = /^#\/incidents\/([^/]+)$/.exec(hash);
  const inv = /^#\/investigations\/([^/]+)$/.exec(hash);
  const route = inv ? 'investigation' : inc ? 'incident' : 'list';
  const active = inc ? decodeURIComponent(inc[1]!) : inv ? invIncident : null;
  return (
    <Shell sums={sums} activeIncident={active} theme={theme} onTheme={nextTheme} route={route}>
      {inv ? <InvestigationPage key={inv[1]} api={api} id={decodeURIComponent(inv[1]!)} onIncident={setInvIncident} />
        : inc ? <IncidentPage key={inc[1]} api={api} id={decodeURIComponent(inc[1]!)} />
        : <IncidentList sums={sums} />}
    </Shell>
  );
}
