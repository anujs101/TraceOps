/** Card surfaces: thin className wrappers, no component library. */
import type { HTMLAttributes, ReactNode } from 'react';

export function Card({ children, className = '', ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLElement>) {
  return <section className={`card ${className}`} {...rest}>{children}</section>;
}

export function CardHeader({ title, id, meta, actions }: { title: ReactNode; id?: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card-h">
      <h2 id={id} className="card-title">{title}{meta !== undefined && <>{' '}<span className="count">{meta}</span></>}</h2>
      {actions && <div className="card-actions">{actions}</div>}
    </div>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'proven' | 'caution' | 'fault' | 'accent' }) {
  return (
    <div className={`kpi card${tone ? ` kpi-${tone}` : ''}`}>
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      {sub && <p className="kpi-sub">{sub}</p>}
    </div>
  );
}
