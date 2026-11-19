/** Empty, loading, not-found and API-error states. */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryStore } from '../../traceops/src/api/memory-store.ts';
import { ApiError, type Api } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { apiOver } from './helpers.ts';

afterEach(() => { cleanup(); window.location.hash = ''; });
const go = (hash: string, api: Api) => { window.location.hash = hash; return render(<App api={api} />); };

describe('states', () => {
  it('empty incident list says what opens an incident', async () => {
    go('#/', apiOver(new MemoryStore()));
    expect(await screen.findByText('No incidents yet.')).toBeTruthy();
  });

  it('API down: names the problem and retries', async () => {
    let calls = 0;
    const api = { ...apiOver(new MemoryStore()), listIncidents: async () => { calls++; if (calls === 1) throw new ApiError(502, 'bad_gateway'); return []; } };
    go('#/', api);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Can't reach the TraceOps API/);
    expect(alert.textContent).toMatch(/502 bad_gateway/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No incidents yet.')).toBeTruthy();
    expect(calls).toBe(2);
  });

  it('unknown investigation and incident ids', async () => {
    go('#/investigations/nope', apiOver(new MemoryStore()));
    expect(await screen.findByText('No investigation with this id.')).toBeTruthy();
    cleanup();
    go('#/incidents/nope', apiOver(new MemoryStore()));
    expect(await screen.findByText('No incident with this id.')).toBeTruthy();
  });

  it('shows a loading skeleton before data arrives', () => {
    const api = { ...apiOver(new MemoryStore()), listIncidents: () => new Promise<never>(() => {}) };
    const { container } = go('#/', api);
    expect(container.querySelector('.skeleton[aria-busy="true"]')).toBeTruthy();
  });
});
