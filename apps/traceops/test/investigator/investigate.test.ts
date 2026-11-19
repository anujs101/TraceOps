import { describe, expect, it } from 'vitest';
import { LlmError, MemoryRecorder, RecordingProvider, toLlmCallRow } from '../../src/llm/index.ts';
import { INVESTIGATOR_RETRY, makeInvestigate } from '../../src/investigator/investigate.ts';
import { INVESTIGATION_BUDGET } from '../../src/investigator/prompt.ts';
import type { InvestigateInput } from '../../src/seams.ts';
import { logPatternsOutput, queryMetricOutput } from '../../scripts/lib/fixture-evidence.ts';
import { fixtureCreateTools, INV_ID, INVESTIGATION_START, memorySinks, S1_INCIDENT, ScriptedProvider, type ChatStep, type Step } from './fakes.ts';

const noSleep = async () => {};
const investigate = makeInvestigate({ sleep: noSleep });

const usedMax = queryMetricOutput('pool_used').stats!.max;
const p1Count = logPatternsOutput().patterns[0]!.count;

/** Valid against the fixture evidence produced by: ev_1 query_metric pool_used, ev_2 search_logs, ev_3 log_patterns. */
const VALID_REPORT = {
  status: 'probable_cause',
  summary: 'Database connection pool exhaustion caused the latency and error alert.',
  observations: [
    { id: 'obs_1', statement: 'Connections in use reached {used_max}.', evidence_ids: ['ev_1'], values: [{ key: 'used_max', evidence_id: 'ev_1', field: 'max', value: usedMax }] },
    { id: 'obs_2', statement: 'The top log pattern is a connection timeout, seen {p1_count} times.', evidence_ids: ['ev_3'], values: [{ key: 'p1_count', evidence_id: 'ev_3', field: 'p1.count', value: p1Count }] },
  ],
  hypotheses: [{ id: 'hyp_1', category: 'db_pool_exhaustion', statement: 'Connections leak until the pool is exhausted.', confidence: 'high', supporting_observation_ids: ['obs_1', 'obs_2'], contradicting_observation_ids: [] }],
  timeline: [],
  recommendations: [{ action: 'Release connections on every code path.', rationale: 'Stops the leak.', hypothesis_id: 'hyp_1', risk: 'low' }],
  gaps: [],
};
/** V3 violation: a bare number in an observation. */
const INVALID_REPORT = { ...VALID_REPORT, observations: [{ ...VALID_REPORT.observations[0]!, statement: 'Connections in use reached 10 ({used_max}).' }, VALID_REPORT.observations[1]!] };

const THREE_TOOL_TURNS: Step[] = [
  { kind: 'chat', toolCalls: [{ name: 'query_metric', args: { metric: 'pool_used', window: 'incident' } }] },
  { kind: 'chat', toolCalls: [
    { name: 'search_logs', args: { window: 'incident', severity: 'error', match: { field: 'exception_message', contains: 'timeout' }, limit: 5 } },
    { name: 'log_patterns', args: { window: 'incident', severity: null } },
  ] },
  { kind: 'chat', content: 'Pool exhausted; timeouts in logs.' },
];

function setup(steps: Step[], opts: { loopChat?: ChatStep; isCancelled?: () => Promise<boolean> } = {}) {
  const scripted = new ScriptedProvider(steps, { loopChat: opts.loopChat });
  const recorder = new MemoryRecorder();
  const tools = fixtureCreateTools();
  const sinks = memorySinks();
  const input: InvestigateInput = {
    investigationId: INV_ID, incident: S1_INCIDENT, investigationStart: INVESTIGATION_START,
    provider: new RecordingProvider(scripted, recorder), createTools: tools.create,
    evidence: sinks.evidenceSink, reports: sinks.reportSink,
    isCancelled: opts.isCancelled ?? (async () => false),
    prometheusUrl: 'http://prometheus.invalid', lokiUrl: 'http://loki.invalid',
  };
  return { scripted, recorder, tools, sinks, input };
}

const turnsOf = (r: MemoryRecorder) => r.records.map((x) => x.turn);

describe('investigate: completed', () => {
  it('runs the tool loop, saves a passed report and returns it', async () => {
    const t = setup([...THREE_TOOL_TURNS, { kind: 'structured', value: VALID_REPORT }]);
    const out = await investigate(t.input);
    expect(out).toMatchObject({ status: 'completed', toolCalls: 3, error: null });
    expect(t.sinks.reports).toHaveLength(1);
    expect(out.report).toBe(t.sinks.reports[0]);
    expect(out.report!.validation).toBe('passed');
    expect(out.report!.repair_attempted).toBe(false);
    expect(t.sinks.evidence.map((e) => `${e.id}:${e.tool}:${e.status}`)).toEqual(['ev_1:query_metric:ok', 'ev_2:search_logs:ok', 'ev_3:log_patterns:ok']);
  });

  it('numbers turns contiguously from the tool loop into the report stage', async () => {
    const t = setup([...THREE_TOOL_TURNS, { kind: 'structured', value: VALID_REPORT }]);
    await investigate(t.input);
    expect(turnsOf(t.recorder)).toEqual([1, 2, 3, 4]);
    expect(t.recorder.records.map((r) => `${r.stage}/${r.kind}`)).toEqual(['investigate/chat', 'investigate/chat', 'investigate/chat', 'report/structured']);
    // every record maps onto a contract llm_calls row
    for (const r of t.recorder.records) expect(() => toLlmCallRow(r)).not.toThrow();
  });

  it('passes the contract budget and the incident to the tools', async () => {
    const t = setup([...THREE_TOOL_TURNS, { kind: 'structured', value: VALID_REPORT }]);
    const before = Date.now();
    await investigate(t.input);
    const ctx = t.tools.contexts[0]!;
    expect(ctx.budget.maxToolCalls).toBe(12);
    expect(ctx.budget.deadline).toBeGreaterThanOrEqual(before + INVESTIGATION_BUDGET.durationMs);
    expect(ctx.incident).toBe(S1_INCIDENT);
    expect(ctx.investigationStart).toBe(INVESTIGATION_START);
  });

  it('gives the report stage every evidence row with the contract wrapper and no tool definitions', async () => {
    const t = setup([...THREE_TOOL_TURNS, { kind: 'structured', value: VALID_REPORT }]);
    await investigate(t.input);
    const rep = t.scripted.requests.find((r) => r.kind === 'structured')!;
    const text = rep.req.messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    for (const id of ['ev_1', 'ev_2', 'ev_3']) expect(text).toContain(`<tool_data evidence_id="${id}"`);
    expect('tools' in rep.req).toBe(false);
  });
});

describe('investigate: invalid report', () => {
  it('repairs once, then stores validation "failed" and completes (persistence.md §2)', async () => {
    const t = setup([...THREE_TOOL_TURNS, { kind: 'structured', value: INVALID_REPORT }, { kind: 'structured', value: INVALID_REPORT }]);
    const out = await investigate(t.input);
    expect(out.status).toBe('completed');
    expect(t.sinks.reports).toHaveLength(1);
    const row = t.sinks.reports[0]!;
    expect(row).toMatchObject({ validation: 'failed', repair_attempted: true, investigation_id: INV_ID });
    expect(row.violations.some((v) => v.rule === 'V3')).toBe(true);
    expect(row.report).toEqual(INVALID_REPORT); // never edited by our code
    expect(out.report).toBe(row);
    expect(turnsOf(t.recorder)).toEqual([1, 2, 3, 4, 5]);
    expect(t.scripted.requests.filter((r) => r.kind === 'structured')).toHaveLength(2); // exactly one repair
  });

  it('a successful repair is stored as passed', async () => {
    const t = setup([...THREE_TOOL_TURNS, { kind: 'structured', value: INVALID_REPORT }, { kind: 'structured', value: VALID_REPORT }]);
    const out = await investigate(t.input);
    expect(out.report).toMatchObject({ validation: 'passed', repair_attempted: true });
  });
});

describe('investigate: budget', () => {
  it('stops at 12 executed tool calls, records budget_exhausted rows, then writes the report', async () => {
    // all evidence is query_metric here, so VALID_REPORT fails validation and is repaired once
    const t = setup([{ kind: 'structured', value: VALID_REPORT }, { kind: 'structured', value: VALID_REPORT }], {
      loopChat: { kind: 'chat', toolCalls: [{ name: 'query_metric', args: { metric: 'pool_used', window: 'incident' } }] },
    });
    const out = await investigate(t.input);
    expect(t.tools.executed()).toBe(INVESTIGATION_BUDGET.maxToolCalls);
    const statuses = t.sinks.evidence.map((e) => e.status);
    expect(statuses.slice(0, 12).every((s) => s === 'ok')).toBe(true);
    expect(statuses.slice(12).length).toBeGreaterThan(0);
    expect(statuses.slice(12).every((s) => s === 'budget_exhausted')).toBe(true);
    expect(t.sinks.evidence).toHaveLength(out.toolCalls); // one row per call
    expect(out.status).toBe('completed');
    expect(t.sinks.reports).toHaveLength(1);
    const turns = turnsOf(t.recorder);
    expect(turns).toEqual(turns.map((_, i) => i + 1));
    expect(t.recorder.records.at(-1)!.stage).toBe('report');
  });

  it('records invalid tool input as an evidence row (raw args, nothing rendered)', async () => {
    const bad = { window: 'incident', severity: null, match: null, limit: 500 };
    const t = setup([{ kind: 'chat', toolCalls: [{ name: 'search_logs', args: bad }] }, { kind: 'chat', content: 'done' }, { kind: 'structured', value: VALID_REPORT }]);
    await investigate(t.input);
    expect(t.sinks.evidence).toHaveLength(1);
    expect(t.sinks.evidence[0]).toMatchObject({ status: 'error', args: bad, rendered_query: null, window: null });
    expect(t.sinks.evidence[0]!.error).toMatch(/^invalid_input:/);
  });
});

describe('investigate: cancel', () => {
  it('cancel before the first turn: no model call, no tool call, no report', async () => {
    const t = setup(THREE_TOOL_TURNS, { isCancelled: async () => true });
    const out = await investigate(t.input);
    expect(out).toEqual({ status: 'cancelled', report: null, toolCalls: 0, error: null });
    expect(t.scripted.requests).toHaveLength(0);
    expect(t.sinks.evidence).toHaveLength(0);
    expect(t.sinks.reports).toHaveLength(0);
  });

  it('cancel before a tool call: the tool is not executed and no further turn is made', async () => {
    let checks = 0;
    const t = setup(THREE_TOOL_TURNS, { isCancelled: async () => ++checks > 1 }); // turn 1 passes; the first tool check sees cancel
    const out = await investigate(t.input);
    expect(out.status).toBe('cancelled');
    expect(out.toolCalls).toBe(0);
    expect(t.tools.executed()).toBe(0);
    expect(t.sinks.evidence).toHaveLength(0);
    expect(t.scripted.requests).toHaveLength(1);
    expect(t.sinks.reports).toHaveLength(0);
  });

  it('cancel between the tool loop and the report: no report request', async () => {
    let chats = 0;
    const t = setup([...THREE_TOOL_TURNS, { kind: 'structured', value: VALID_REPORT }], { isCancelled: async () => chats >= 3 });
    const orig = t.scripted.chat.bind(t.scripted);
    t.scripted.chat = async (req) => { const r = await orig(req); chats++; return r; };
    const out = await investigate(t.input);
    expect(out).toMatchObject({ status: 'cancelled', report: null, toolCalls: 3 });
    expect(t.scripted.requests.filter((r) => r.kind === 'structured')).toHaveLength(0);
  });

  it('cancel is checked before every turn and every tool call', async () => {
    let checks = 0;
    const t = setup([...THREE_TOOL_TURNS, { kind: 'structured', value: VALID_REPORT }], { isCancelled: async () => { checks++; return false; } });
    await investigate(t.input);
    expect(checks).toBe(3 /* chat turns */ + 3 /* tool calls */ + 1 /* report round */);
  });
});

describe('investigate: failures', () => {
  it('a non-retryable LLM error fails the investigation with a redacted message', async () => {
    const t = setup([{ kind: 'chat_error', error: new LlmError('auth', 'invalid key gsk_abcdefghijklmnop', { status: 401 }) }]);
    const out = await investigate(t.input);
    expect(out.status).toBe('failed');
    expect(out.report).toBeNull();
    expect(out.error).toMatch(/^llm_auth:/);
    expect(out.error).not.toContain('gsk_abcdefghijklmnop');
    expect(t.sinks.reports).toHaveLength(0);
  });

  it('waits out a 429 within the 60 s cap and records each attempt under the same turn', async () => {
    const waits: number[] = [];
    const inv = makeInvestigate({ sleep: async (ms) => { waits.push(ms); } });
    const t = setup([{ kind: 'chat_error', error: new LlmError('rate_limit', 'slow down', { status: 429, retryAfterMs: 45_000 }) }, ...THREE_TOOL_TURNS, { kind: 'structured', value: VALID_REPORT }]);
    const out = await inv(t.input);
    expect(out.status).toBe('completed');
    expect(waits).toEqual([45_000]);
    expect(t.recorder.records.slice(0, 2).map((r) => [r.turn, r.attempt, r.status])).toEqual([[1, 1, 'error'], [1, 2, 'ok']]);
    expect(INVESTIGATOR_RETRY.maxDelayMs).toBe(60_000);
  });

  it('a 429 asking for more than 60 s fails instead of waiting', async () => {
    const t = setup([{ kind: 'chat_error', error: new LlmError('rate_limit', 'slow down', { status: 429, retryAfterMs: 90_000 }) }]);
    const out = await investigate(t.input);
    expect(out).toMatchObject({ status: 'failed', report: null });
    expect(out.error).toMatch(/^llm_rate_limit:/);
  });
});
