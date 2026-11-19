/** Loading, empty and error states: each says what happened and what to do. */
import type { ReactNode } from 'react';

export function Skeleton({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skel-row" />)}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="empty-body">{children}</p>}
    </div>
  );
}

export function ApiProblem({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="problem" role="alert">
      <p><strong>Can't reach the TraceOps API.</strong> The request failed with <code>{text}</code>.</p>
      <p>Check that the API is running (port 4000 by default; the Vite proxy reads <code>VITE_API_TARGET</code>).</p>
      {onRetry && <button type="button" className="btn" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function NotFound({ what }: { what: string }) {
  return <Empty title={`No ${what} with this id.`}><a href="#/">Back to incidents</a></Empty>;
}
