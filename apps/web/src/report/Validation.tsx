import type { ReportRow } from '../api.ts';
import { jumpTo } from '../lib/jump.ts';

/**
 * Unvalidated: a loud banner with every violation listed (no disclosure can
 * hide them), plus a slim strip pinned under the top bar so "unvalidated"
 * stays on screen while scrolling, however long the list is (S2 had 13).
 * Validated: a quiet seal; warnings behind a disclosure, count always visible.
 */
export function ValidationBanner({ row }: { row: ReportRow }) {
  if (row.validation === 'passed') return null;
  const n = row.violations.length;
  return (
    <>
    <a className="banner-strip" href="#validation" onClick={jumpTo('validation')} data-testid="validation-strip">
      <strong>Unvalidated</strong> <span>claims are unchecked: {n} {n === 1 ? 'violation' : 'violations'}</span>
    </a>
    <section className="banner-bad" id="validation" aria-label="Validation" data-testid="validation" role="region">
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
    </>
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
