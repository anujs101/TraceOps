import { useEffect, useState } from 'react';
import type { Api } from './api.ts';
import { IncidentList, IncidentPage, InvestigationPage } from './pages.tsx';

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App({ api }: { api: Api }) {
  const hash = useHash();
  const inc = /^#\/incidents\/([^/]+)$/.exec(hash);
  const inv = /^#\/investigations\/([^/]+)$/.exec(hash);
  return (
    <>
      <header className="topbar"><a href="#/" className="brand">TraceOps</a></header>
      {inv ? <InvestigationPage key={inv[1]} api={api} id={decodeURIComponent(inv[1]!)} />
        : inc ? <IncidentPage key={inc[1]} api={api} id={decodeURIComponent(inc[1]!)} />
        : <IncidentList api={api} />}
    </>
  );
}
