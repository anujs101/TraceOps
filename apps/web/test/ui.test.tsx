/**
 * UI tests over REAL data: the dev store is seeded by running investigate() on
 * the S1 fixtures (apps/traceops/src/api/dev/seed-s1.ts). No hand-written reports.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryStore } from '../../traceops/src/api/memory-store.ts';
import { INV_FAILED, INV_RUNNING, INV_UNVALIDATED, INV_VALIDATED, seedS1 } from '../../traceops/src/api/dev/seed-s1.ts';
import { S1_INCIDENT } from '../../traceops/src/investigator/dev/fixture-tools.ts';
import { ReportApi } from '@traceops/contracts';
import { App } from '../src/App.tsx';
import { apiOver, expectEveryNumberClickable, expectNoInlineIds } from './helpers.ts';

const store = new MemoryStore();
const api = apiOver(store);
const reportOf = async (id: string) => ReportApi.parse((await store.getReport(id))!.report);

beforeAll(async () => { await seedS1(store); });
afterEach(() => { cleanup(); window.location.hash = ''; });

const go = (hash: string) => { window.location.hash = hash; return render(<App api={api} />); };

describe('incident list and incident page', () => {
  it('lists the incident and its investigations', async () => {
    go('#/');
    const link = await screen.findByRole('link', { name: /demo-service/ });
    expect(link.getAttribute('href')).toBe(`#/incidents/${S1_INCIDENT.id}`);
    cleanup();
    go(`#/incidents/${S1_INCIDENT.id}`);
    expect(await screen.findAllByRole('link', { name: /tool calls/ })).toHaveLength(4);
  });

  it('re-run queues a manual investigation', async () => {
    go(`#/incidents/${S1_INCIDENT.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Run a new investigation' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringMatching(/Investigation queued/));
    expect(store.jobs).toHaveLength(1);
  });
});

describe('validated S1 report', () => {
  it('shows the verdict, validation seal, hypotheses with supports and contradicts separated, timeline and gaps', async () => {
    go(`#/investigations/${INV_VALIDATED}`);
    const seal = await screen.findByTestId('validation');
    expect(seal.textContent).toMatch(/^✓ Validated/);
    expect(seal.textContent).toMatch(/No warnings/);
    expect(screen.queryByRole('region', { name: 'Validation' })).toBeNull(); // no unvalidated banner
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Connection pool exhaustion/);
    const hyp1 = screen.getByTestId('hyp-hyp_1');
    expect(hyp1.textContent).toMatch(/Connection pool exhaustion/);
    expect(within(hyp1).getByRole('heading', { name: /^Supports/ })).toBeTruthy();
    const hyp2 = screen.getByTestId('hyp-hyp_2');
    const against = within(hyp2).getByRole('heading', { name: /^Contradicts/ }).parentElement!;
    expect(against.className).toMatch(/side-against/);
    expect(within(against).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.getByTestId('gaps').textContent).toMatch(/Traces were not available/);
    expect(screen.getByRole('heading', { name: 'Timeline' })).toBeTruthy();
    expect(screen.getByTestId('ttr').textContent).toMatch(/s$/);
  });

  it('renders bound values formatted for display, never as {key} placeholders', async () => {
    go(`#/investigations/${INV_VALIDATED}`);
    const obs2 = await screen.findByTestId('obs-obs_2');
    expect(obs2.textContent).not.toMatch(/\{used_max\}/);
    const report = await reportOf(INV_VALIDATED);
    const usedMax = report.observations[1]!.values.find((v) => v.key === 'used_max')!.value;
    expect(within(obs2).getByTestId('num-used_max').textContent).toBe(String(usedMax));
  });

  it('every number is clickable to its evidence, and no ids appear inline', async () => {
    const { container } = go(`#/investigations/${INV_VALIDATED}`);
    await screen.findByTestId('validation');
    const main = container.querySelector('main')!;
    expectNoInlineIds(main);
    expectEveryNumberClickable(main, await reportOf(INV_VALIDATED));
  });

  it('clicking a number opens its evidence: query, window, status, result, the cited field and its exact value', async () => {
    go(`#/investigations/${INV_VALIDATED}`);
    const obs2 = await screen.findByTestId('obs-obs_2');
    fireEvent.click(within(obs2).getByTestId('num-used_max'));
    const panel = screen.getByTestId('evidence-panel');
    const ev = (await store.listEvidence(INV_VALIDATED)).find((e) => e.id === 'ev_2')!;
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe('pool_used');
    expect(within(panel).getByTestId('ev-query').textContent).toBe(ev.rendered_query);
    expect(within(panel).getByTestId('ev-query').textContent).toContain('db_client_connection_count');
    expect(within(panel).getByTestId('ev-status').textContent).toMatch(/ok/);
    expect(within(panel).getByTestId('ev-window').textContent).toBe('2026-11-16 18:23:38 → 18:30:39 UTC');
    expect(JSON.parse(within(panel).getByTestId('ev-result').textContent!)).toEqual(ev.result);
    expect(within(panel).getByTestId('claim').textContent).toMatch(/Matches the evidence/);
    expect(within(panel).getByText('ev_2')).toBeTruthy(); // the id lives in the drawer
    expect(within(panel).getByRole('img')).toBeTruthy(); // sparkline from the stored series
  });

  it('an evidence reference opens that row; Escape closes the drawer', async () => {
    go(`#/investigations/${INV_VALIDATED}`);
    const obs4 = await screen.findByTestId('obs-obs_4');
    fireEvent.click(within(obs4).getByTestId('ref-ev_6'));
    const panel = screen.getByTestId('evidence-panel');
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toMatch(/log/);
    expect(within(panel).queryByTestId('claim')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('evidence-panel')).toBeNull();
  });

  it('lists every evidence row and the model calls with tokens', async () => {
    go(`#/investigations/${INV_VALIDATED}`);
    expect(await screen.findByRole('heading', { name: /^Evidence 8/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Model calls 6/ })).toBeTruthy();
  });
});

describe('other investigation states', () => {
  it('an unvalidated report has a loud banner whose violations are always visible', async () => {
    const { container } = go(`#/investigations/${INV_UNVALIDATED}`);
    const band = await screen.findByTestId('validation');
    expect(band.textContent).toMatch(/^Unvalidated/);
    expect(band.textContent).toMatch(/after one repair round/);
    const violations = within(band).getByRole('list', { name: 'Violations' });
    expect(violations.textContent).toMatch(/V3/);
    expect(violations.textContent).toMatch(/V5/);
    expect(band.closest('details')).toBeNull(); // no disclosure can hide it
    for (const d of container.querySelectorAll('details')) d.open = false;
    expect(screen.getByTestId('validation')).toBe(band);
    expect(screen.getByTestId('seal').textContent).toMatch(/Unvalidated/);
  });

  it('the drawer handles the short error shape {evidence_id, status, error}', async () => {
    go(`#/investigations/${INV_UNVALIDATED}`);
    expect(await screen.findByRole('heading', { name: /^Evidence 9/ })).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('ledger-ev_9')).getByRole('button'));
    const panel = screen.getByTestId('evidence-panel');
    const ev = (await store.listEvidence(INV_UNVALIDATED)).find((e) => e.id === 'ev_9')!;
    expect(Object.keys(ev.result as object).sort()).toEqual(['error', 'evidence_id', 'status']);
    expect(within(panel).getByTestId('ev-status').textContent).toMatch(/error.*invalid_input: limit/);
    expect(within(panel).getByTestId('ev-window').textContent).toBe('none (nothing was queried)');
    expect(within(panel).queryByTestId('ev-query')).toBeNull();
    expect(within(panel).getByText('Nothing was sent to the backend.')).toBeTruthy();
    expect(JSON.parse(within(panel).getByTestId('ev-result').textContent!)).toEqual(ev.result);
    expect(within(panel).queryByRole('table')).toBeNull(); // no stats
    expect(within(panel).queryByRole('img')).toBeNull(); // no series
  });

  it('a failed investigation shows its error and no report', async () => {
    go(`#/investigations/${INV_FAILED}`);
    expect((await screen.findByRole('alert')).textContent).toMatch(/llm_auth/);
    expect(screen.queryByTestId('validation')).toBeNull();
    expect(screen.getByText('Investigation failed')).toBeTruthy();
  });

  it('a running investigation shows live progress and can be cancelled', async () => {
    go(`#/investigations/${INV_RUNNING}`);
    expect(await screen.findByText('Investigating')).toBeTruthy();
    expect(screen.getByTestId('elapsed').textContent).toMatch(/^\d+:\d\d$/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel investigation' }));
    expect(await screen.findByRole('button', { name: 'Cancelling…' })).toBeTruthy();
    expect((await store.getInvestigation(INV_RUNNING))!.cancel_requested).toBe(true);
  });
});
