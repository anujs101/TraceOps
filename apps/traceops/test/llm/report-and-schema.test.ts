import { describe, expect, it } from 'vitest';
import { ReportApi, TOOL_INPUTS, toApiJsonSchema } from '@traceops/contracts';
import { GroqProvider } from '../../src/llm/groq/adapter.ts';
import { groqStrictProblems } from '../../src/llm/groq/schema.ts';
import { generateReport, reportProviderSchema } from '../../src/llm/report-stage.ts';
import { FakeGroqClient, textResponse } from './fakes.ts';

const cfg = { model: 'm', reasoningEffort: null };
const good = {
  status: 'probable_cause', summary: 'Pool exhausted.',
  observations: [{ id: 'obs_1', statement: 'used reached {used_max}', evidence_ids: ['ev_1'], values: [{ key: 'used_max', evidence_id: 'ev_1', field: 'max', value: 10 }] }],
  hypotheses: [{ id: 'hyp_1', category: 'db_pool_exhaustion', statement: 'leak', confidence: 'medium', supporting_observation_ids: ['obs_1'], contradicting_observation_ids: [] }],
  timeline: [{ at: '2026-11-16T18:25:39.000Z', event: 'deploy', evidence_ids: ['ev_1'] }],
  recommendations: [], gaps: [],
};
const gen = (content: string) => generateReport(new GroqProvider(new FakeGroqClient([textResponse(content)]), cfg), [{ role: 'user', content: 'x' }], { maxOutputTokens: 100 });

describe('report stage', () => {
  it('accepts a contract-valid report', async () => {
    const r = await gen(JSON.stringify(good));
    expect(r.report.observations[0]!.id).toBe('obs_1');
  });

  it('provider-valid but contract-invalid output is a schema_violation (server validation not weakened)', async () => {
    // Every case below satisfies the provider-facing ReportApi schema...
    const cases = [
      { ...good, observations: [{ ...good.observations[0]!, evidence_ids: [] }] },          // no citation
      { ...good, timeline: [{ ...good.timeline[0]!, at: '2026-11-16T18:25:39Z' }] },      // not IsoUtcMs
      { ...good, observations: [{ ...good.observations[0]!, id: 'observation-1' }] },      // id format
      { ...good, summary: 'x'.repeat(601) },                                              // length
    ];
    for (const c of cases) {
      expect(ReportApi.safeParse(c).success).toBe(true);
      await expect(gen(JSON.stringify(c))).rejects.toMatchObject({ kind: 'schema_violation' });
    }
  });

  it('wrong shape (would only happen in non-strict mode) is a schema_violation', async () => {
    await expect(gen(JSON.stringify({ status: 'done' }))).rejects.toMatchObject({ kind: 'schema_violation' });
  });

  it('violation details list paths, not model output', async () => {
    const err = await gen(JSON.stringify({ ...good, observations: [{ ...good.observations[0]!, evidence_ids: [] }] })).catch((e) => e);
    expect(err.details.issues).toEqual([{ path: 'observations.0.evidence_ids', message: 'must cite >= 1 evidence' }]);
    expect(err.details.raw.value.observations[0].evidence_ids).toEqual([]);
    expect(JSON.stringify(err.toJSON())).not.toContain('Pool exhausted'); // model output not in the loggable form
  });

  it('sends exactly the contracts ReportApi schema to the provider', async () => {
    const client = new FakeGroqClient([textResponse(JSON.stringify(good))]);
    await generateReport(new GroqProvider(client, cfg), [], { maxOutputTokens: 10 });
    expect((client.bodies[0]!.response_format as any).json_schema.schema).toEqual(toApiJsonSchema(ReportApi));
  });
});

describe('Groq strict-mode compatibility of contract schemas', () => {
  it('report schema has no Groq-incompatible features', () => {
    expect(groqStrictProblems(reportProviderSchema())).toEqual([]);
  });
  it.each(Object.entries(TOOL_INPUTS))('tool input %s has no Groq-incompatible features', (_n, s) => {
    expect(groqStrictProblems(toApiJsonSchema(s))).toEqual([]);
  });
  it('flags what Groq strict mode does not document', () => {
    const p = groqStrictProblems({ type: 'object', properties: { a: { type: 'string', format: 'date-time' }, b: { const: 1 } }, required: ['a'] });
    expect(p.join('\n')).toMatch(/additionalProperties/);
    expect(p.join('\n')).toMatch(/optional properties/);
    expect(p.join('\n')).toMatch(/"format"/);
    expect(p.join('\n')).toMatch(/"const"/);
  });
});
