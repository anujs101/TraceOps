/**
 * UI tests over REAL data: the dev store is seeded by running investigate() on
 * the S1 fixtures (apps/traceops/src/api/dev/seed-s1.ts). No hand-written reports.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryStore } from '../../traceops/src/api/memory-store.ts';
import { INV_FAILED, INV_RUNNING, INV_UNVALIDATED, INV_VALIDATED, seedS1 } from '../../traceops/src/api/dev/seed-s1.ts';
import { S1_INCIDENT } from '../../traceops/src/investigator/dev/fixture-tools.ts';
import type { Api } from '../src/api.ts';
import { App } from '../src/App.tsx';

const store = new MemoryStore();
const api: Api = {
  listIncidents: () => store.listIncidents(),
  getIncident: (id) => store.getIncident(id),
  listInvestigations: (id) => store.listInvestigations(id),
  getInvestigation: (id) => store.getInvestigation(id),
  listEvidence: (id) => store.listEvidence(id),
  getReport: (id) => store.getReport(id),
  listLlmCalls: (id) => store.listLlmCalls(id),
  rerun: async (id) => ({ job_id: await store.enqueueManual(id) }),
  cancel: (id) => store.requestCancel(id),
};

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
  it('shows validation status, hypotheses with supporting and contradicting observations, timeline and gaps', async () => {
    go(`#/investigations/${INV_VALIDATED}`);
    const band = await screen.findByTestId('validation');
    expect(band.textContent).toMatch(/^Validated/);
    expect(band.textContent).toMatch(/No warnings/);
    const hyp1 = screen.getByTestId('hyp-hyp_1');
    expect(hyp1.textContent).toMatch(/Connection pool exhaustion/);
    expect(hyp1.textContent).toMatch(/Supported by/);
    const hyp2 = screen.getByTestId('hyp-hyp_2');
    expect(within(hyp2).getByText('Contradicted by')).toBeTruthy();
    expect(screen.getByTestId('gaps').textContent).toMatch(/Traces were not available/);
    expect(screen.getByRole('heading', { name: 'Timeline' })).toBeTruthy();
  });

  it('renders bound values instead of {key} placeholders', async () => {
    go(`#/investigations/${INV_VALIDATED}`);
    const obs2 = await screen.findByTestId('obs-obs_2');
    expect(obs2.textContent).not.toMatch(/\{used_max\}/);
    const report = (await store.getReport(INV_VALIDATED))!.report as any;
    const usedMax = report.observations[1].values.find((v: any) => v.key === 'used_max').value;
    expect(within(obs2).getByTestId('num-used_max').textContent).toBe(`${usedMax}ev_2`);
  });

  it('clicking a number opens its evidence: query, window, status, result and the cited field', async () => {
    go(`#/investigations/${INV_VALIDATED}`);
    const obs2 = await screen.findByTestId('obs-obs_2');
    fireEvent.click(within(obs2).getByTestId('num-used_max'));
    const panel = screen.getByTestId('evidence-panel');
    const ev = (await store.listEvidence(INV_VALIDATED)).find((e) => e.id === 'ev_2')!;
    expect(within(panel).getByRole('heading').textContent).toBe('ev_2 · pool_used');
    expect(within(panel).getByTestId('ev-query').textContent).toBe(ev.rendered_query);
    expect(within(panel).getByTestId('ev-query').textContent).toContain('db_client_connection_count');
    expect(within(panel).getByTestId('ev-status').textContent).toBe('ok');
    expect(within(panel).getByTestId('ev-window').textContent).toMatch(/2026-11-16 18:23:38 UTC to 18:30:39/);
    expect(JSON.parse(within(panel).getByTestId('ev-result').textContent!)).toEqual(ev.result);
    expect(within(panel).getByTestId('claim').textContent).toMatch(/Matches the evidence/);
  });

  it('an evidence chip opens that row; Escape closes the panel', async () => {
    go(`#/investigations/${INV_VALIDATED}`);
    const obs4 = await screen.findByTestId('obs-obs_4');
    fireEvent.click(within(obs4).getByTestId('chip-ev_6'));
    const panel = screen.getByTestId('evidence-panel');
    expect(within(panel).getByRole('heading').textContent).toBe('ev_6 · Log search');
    expect(within(panel).queryByTestId('claim')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('evidence-panel')).toBeNull();
  });

  it('lists every evidence row and the model calls with tokens', async () => {
    go(`#/investigations/${INV_VALIDATED}`);
    expect(await screen.findByRole('heading', { name: 'All evidence (8)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Model calls (6)' })).toBeTruthy();
  });
});

describe('other investigation states', () => {
  it('an unvalidated report is labelled and lists its violations', async () => {
    go(`#/investigations/${INV_UNVALIDATED}`);
    const band = await screen.findByTestId('validation');
    expect(band.textContent).toMatch(/^Unvalidated/);
    expect(band.textContent).toMatch(/after one repair round/);
    expect(within(band).getByRole('list', { name: 'Violations' }).textContent).toMatch(/V3/);
    expect(within(band).getByRole('list', { name: 'Violations' }).textContent).toMatch(/V5/);
  });

  it('the evidence panel handles the short error shape {evidence_id, status, error}', async () => {
    go(`#/investigations/${INV_UNVALIDATED}`);
    expect(await screen.findByRole('heading', { name: 'All evidence (9)' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('chip-ev_9'));
    const panel = screen.getByTestId('evidence-panel');
    const ev = (await store.listEvidence(INV_UNVALIDATED)).find((e) => e.id === 'ev_9')!;
    expect(Object.keys(ev.result as object).sort()).toEqual(['error', 'evidence_id', 'status']);
    expect(within(panel).getByTestId('ev-status').textContent).toMatch(/^error invalid_input: limit/);
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
  });

  it('a running investigation can be cancelled', async () => {
    go(`#/investigations/${INV_RUNNING}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel investigation' }));
    expect(await screen.findByRole('button', { name: 'Cancelling…' })).toBeTruthy();
    expect((await store.getInvestigation(INV_RUNNING))!.cancel_requested).toBe(true);
  });
});
