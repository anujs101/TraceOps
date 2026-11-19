import type { ReportRow } from '../api.ts';

/**
 * Unvalidated: a loud banner, sticky at the top, violations always listed
 * (no disclosure can hide them). Validated: a quiet seal; warnings behind a
 * disclosure, their count always visible.
 */
export function ValidationBanner({ row }: { row: ReportRow }) {
  if (row.validation === 'passed') return null;
  return (
    <section className="banner-bad" aria-label="Validation" data-testid="validation" role="region">
      <p className="banner-head">
        <strong>Unvalidated</strong>{' '}
        <span>
          The report failed validation{row.repair_attempted ? ' after one repair round' : ''}. Its claims are unchecked:
          {' '}{row.violations.length} {row.violations.length === 1 ? 'violation' : 'violations'}.
        </span>
      </p>
      {row.violations.length > 0 && (
        <ul className="violations" aria-label="Violations">
          {row.violations.map((v, i) => <li key={i}><b>{v.rule}</b> <code>{v.path}</code> <span>{v.message}</span></li>)}
        </ul>
      )}
      {row.warnings.length > 0 && <p className="banner-foot">{row.warnings.length} {row.warnings.length === 1 ? 'warning' : 'warnings'} as well.</p>}
    </section>
  );
}

export function ValidationSeal({ row }: { row: ReportRow }) {
  if (row.validation !== 'passed') {
    return <span className="seal seal-bad" data-testid="seal"><span aria-hidden="true">!</span> Unvalidated: claims unchecked</span>;
  }
  return (
    <div className="seal-wrap" data-testid="validation">
      <span className="seal seal-ok"><span aria-hidden="true">✓</span> Validated</span>
      <span className="seal-note">
        Every claim cites stored evidence and every number matches it (rules V0–V8){row.repair_attempted ? ', after one repair round' : ''}.
      </span>
      {row.warnings.length === 0 ? <span className="seal-note">No warnings.</span> : (
        <details className="warnings">
          <summary>{row.warnings.length} {row.warnings.length === 1 ? 'warning' : 'warnings'}</summary>
          <ul aria-label="Warnings">
            {row.warnings.map((w, i) => <li key={i}><b>{w.rule}</b> <code>{w.path}</code> <span>{w.message}</span></li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
