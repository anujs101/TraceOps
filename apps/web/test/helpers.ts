/** Shared assertions for the report page. */
import { expect } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { Report } from '@traceops/contracts';
import type { Api } from '../src/api.ts';
import type { MemoryStore } from '../../traceops/src/api/memory-store.ts';

export function apiOver(store: MemoryStore): Api {
  return {
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
}

/**
 * Every number stays clickable to its evidence:
 * - no raw {key} placeholder is visible unless it is explicitly marked unbound;
 * - every bound value of the report is rendered as at least one number button;
 * - every number button opens the drawer on its evidence field, the claim
 *   matches, and the exact stored value is shown.
 */
export function expectEveryNumberClickable(main: HTMLElement, report: Report) {
  const unbound = new Set([...main.querySelectorAll('.unbound')].map((e) => e.textContent));
  const visible = [...main.textContent!.matchAll(/\{[a-z][a-z0-9_]*\}/g)].map((m) => m[0]);
  expect(visible.filter((p) => !unbound.has(p))).toEqual([]);

  const value = new Map(report.observations.flatMap((o) => o.values).map((v) => [v.key, v.value]));
  const buttons = [...main.querySelectorAll<HTMLButtonElement>('button[data-testid^="num-"]')];
  const keys = new Set(buttons.map((b) => b.dataset.testid!.slice(4)));
  for (const k of value.keys()) expect(keys, `bound value ${k} is not rendered as a number`).toContain(k);

  for (const b of buttons) {
    const k = b.dataset.testid!.slice(4);
    fireEvent.click(b);
    const panel = screen.getByTestId('evidence-panel');
    expect(within(panel).getByTestId('claim').textContent, `number ${k}`).toMatch(/Matches the evidence/);
    expect(within(panel).getByTestId('claim-exact').textContent).toBe(String(value.get(k)));
  }
}

/** No evidence/observation/hypothesis ids as text in the page body (tooltips and the drawer only). */
export function expectNoInlineIds(main: HTMLElement) {
  expect(main.textContent).not.toMatch(/\bev_\d+\b/);
  expect(main.textContent).not.toMatch(/\b(?:obs|hyp)_\d+\b/);
}
