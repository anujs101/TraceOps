/**
 * The UI over the REAL recorded live run docs/runs/s1-20261119T104115Z
 * (validated report, 16 evidence rows incl. 4 budget_exhausted). No hand-written data.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { join } from 'node:path';
import { ReportApi } from '@traceops/contracts';
import { MemoryStore } from '../../traceops/src/api/memory-store.ts';
import { App } from '../src/App.tsx';
import { loadRun, RUNS_DIR } from '../scripts/load-run.ts';
import { apiOver, expectEveryNumberClickable, expectNoInlineIds } from './helpers.ts';

const store = new MemoryStore();
const api = apiOver(store);
let invId = '';

beforeAll(() => { invId = loadRun(store, join(RUNS_DIR, 's1-20261119T104115Z')).investigationId; });
afterEach(() => { cleanup(); window.location.hash = ''; });
const go = (hash: string) => { window.location.hash = hash; return render(<App api={api} />); };

describe('recorded S1 live run', () => {
  it('incident list row: status, severity, service, time to report, top hypothesis, proof', async () => {
    go('#/');
    const link = await screen.findByRole('link', { name: 'demo-service' });
    const row = link.closest('tr')!;
    expect(row.textContent).toMatch(/open/);
    expect(row.textContent).toMatch(/critical/);
    expect(row.textContent).toMatch(/10:44:15/);
    expect(within(row).getByTestId('ttr').textContent).toBe('37.8 s');
    expect(row.textContent).toMatch(/Connection pool exhaustion/);
    expect(row.textContent).toMatch(/high confidence/);
    expect(row.textContent).toMatch(/✓ Validated/);
    expect(row.querySelectorAll('button[data-testid^="num-"]')).toHaveLength(0); // no unclickable numbers posing as evidence
  });

  it('verdict: validated, top hypothesis, detection→report time, key numbers in display units', async () => {
    go(`#/investigations/${invId}`);
    const seal = await screen.findByTestId('validation');
    expect(seal.textContent).toMatch(/Validated/);
    expect(seal.textContent).toMatch(/after one repair round/);
    expect(seal.textContent).toMatch(/3 warnings/);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Connection pool exhaustion/);
    expect(screen.getByTestId('ttr').textContent).toBe('37.8 s');
    const keys = screen.getByRole('heading', { level: 1 }).closest('section')!.querySelector('.keys')!;
    // the top hypothesis's placeholders, in order: pool_max_min, pending_max, p1_count, err_max
    expect([...keys.querySelectorAll('[data-testid^="num-"]')].map((b) => b.getAttribute('data-testid'))).toEqual(['num-pool_max_min', 'num-pending_max', 'num-p1_count', 'num-err_max']);
    expect(within(keys as HTMLElement).getByTestId('num-err_max').textContent).toBe('59.8%');
  });

  it('Signals: one chart panel per cited metric row, with formatted axes; each opens its evidence', async () => {
    go(`#/investigations/${invId}`);
    const sig = (await screen.findByRole('heading', { name: /^Signals/ })).closest('section')!;
    const panels = sig.querySelectorAll('[data-testid^="signal-"]');
    expect(panels.length).toBe(6); // capped; the report cites 10 metric rows with series
    const first = panels[0] as HTMLElement;
    const id = first.dataset.testid!.slice('signal-'.length);
    // axis labels: formatted values over the stored series' domain, plus window start/end times
    const labels = [...first.querySelectorAll('text.axis')].map((t) => t.textContent!);
    expect(labels).toContain('0'); // pool_used starts at 0, domain anchored at 0
    expect(labels).toContain('10:42:15');
    expect(labels.at(-1)).toBe('10:44:30');
    expect(labels.every((l) => !/e[+-]\d/.test(l) && l.length <= 10)).toBe(true);
    for (const p of panels) {
      const pid = (p as HTMLElement).dataset.testid!.slice('signal-'.length);
      fireEvent.click(within(p as HTMLElement).getByRole('button', { name: /chart$/ }));
      expect(within(screen.getByTestId('evidence-panel')).getByText(pid)).toBeTruthy();
    }
    expect(id).toBe('ev_9'); // obs_1 cites ev_9 (pool_used) first
  });

  it('prose units are display-formatted: "{el_max} s" reads 19.4 ms, the stored value is untouched', async () => {
    go(`#/investigations/${invId}`);
    const hyp2 = await screen.findByTestId('hyp-hyp_2');
    const el = within(hyp2).getAllByTestId('num-el_max')[0]!;
    expect(el.textContent).toBe('19.4ms');
    expect(el.getAttribute('aria-label')).toMatch(/^19\.4 ms: eventloop_delay_p99 max, exact 0\.019382271/);
    expect(el.getAttribute('data-tip')).toContain('exact 0.019382271');
    expect(hyp2.textContent).not.toMatch(/ms s\b/);
  });

  it('every number is clickable; no inline ids; all 16 evidence rows with 4 budget_exhausted', async () => {
    const { container } = go(`#/investigations/${invId}`);
    expect(await screen.findByRole('heading', { name: /^Evidence 16/ })).toBeTruthy();
    const main = container.querySelector('main')!;
    expectNoInlineIds(main);
    const ledger = screen.getByRole('heading', { name: /^Evidence 16/ }).closest('section')!;
    expect(within(ledger).getAllByText('budget exhausted')).toHaveLength(4);
    expectEveryNumberClickable(main, ReportApi.parse((await store.getReport(invId))!.report));
  });
});
