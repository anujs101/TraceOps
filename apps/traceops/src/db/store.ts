import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Evidence, Incident, LlmCall, toIsoUtcMs } from '@traceops/contracts';
import type { EvidenceSink, InvestigationRow, InvestigationStore } from '../seams.ts';
import type { ReportRow } from '../report/generate.ts';
import type { LlmCallRecord } from '../llm/recorder.ts';
import { toLlmCallRow } from '../llm/recorder.ts';

const iso = (d: Date): string => toIsoUtcMs(d);
const isoN = (d: Date | null): string | null => (d ? toIsoUtcMs(d) : null);
const json = (v: unknown): string => JSON.stringify(v);

export function mapIncident(r: any): Incident {
  return Incident.parse({
    id: r.id, fingerprint: r.fingerprint, service: r.service, group: r.group, status: r.status, severity: r.severity,
    started_at: iso(r.started_at), detected_at: iso(r.detected_at), resolved_at: isoN(r.resolved_at),
    reopen_count: r.reopen_count, trigger: r.trigger,
  });
}

function mapInvestigation(r: any): InvestigationRow {
  return {
    id: r.id, incident_id: r.incident_id, job_id: r.job_id, status: r.status, trigger: r.trigger, model: r.model,
    started_at: iso(r.started_at), finished_at: isoN(r.finished_at), tool_calls: r.tool_calls,
    cancel_requested: r.cancel_requested, error: r.error,
  };
}

function mapEvidence(r: any): Evidence {
  return Evidence.parse({
    id: r.id, investigation_id: r.investigation_id, tool: r.tool, source: r.source, args: r.args ?? null,
    rendered_query: r.rendered_query,
    window: r.window_start ? { start: iso(r.window_start), end: iso(r.window_end) } : null,
    status: r.status, error: r.error, result: r.result ?? null, stats: r.stats, duration_ms: r.duration_ms,
    created_at: iso(r.created_at),
  });
}

function mapLlmCall(r: any): LlmCall {
  return LlmCall.parse({
    id: r.id, investigation_id: r.investigation_id, turn: r.turn, attempt: r.attempt, provider: r.provider, model: r.model,
    stage: r.stage, kind: r.kind, status: r.status, request_id: r.request_id, input_tokens: r.input_tokens,
    output_tokens: r.output_tokens, cache_read_tokens: r.cache_read_tokens, latency_ms: r.latency_ms,
    stop_reason: r.stop_reason, tool_call_count: r.tool_call_count, error_kind: r.error_kind, error_status: r.error_status,
    error_message: r.error_message, retry_after_ms: r.retry_after_ms, provider_timings: r.provider_timings,
    created_at: iso(r.created_at),
  });
}

/** persistence.md §1 over Postgres. Reads return IsoUtcMs; evidence is append-only. */
export class PgInvestigationStore implements InvestigationStore {
  constructor(private readonly pool: pg.Pool) {}

  async listIncidents(): Promise<Incident[]> {
    const r = await this.pool.query('SELECT * FROM incidents ORDER BY detected_at DESC, id');
    return r.rows.map(mapIncident);
  }

  async getIncident(id: string): Promise<Incident | null> {
    const r = await this.pool.query('SELECT * FROM incidents WHERE id = $1', [id]);
    return r.rows[0] ? mapIncident(r.rows[0]) : null;
  }

  async listInvestigations(incidentId: string): Promise<InvestigationRow[]> {
    const r = await this.pool.query('SELECT * FROM investigations WHERE incident_id = $1 ORDER BY started_at, id', [incidentId]);
    return r.rows.map(mapInvestigation);
  }

  async getInvestigation(id: string): Promise<InvestigationRow | null> {
    const r = await this.pool.query('SELECT * FROM investigations WHERE id = $1', [id]);
    return r.rows[0] ? mapInvestigation(r.rows[0]) : null;
  }

  async listEvidence(investigationId: string): Promise<Evidence[]> {
    // ev_<n> ids order numerically, not lexically
    const r = await this.pool.query(
      `SELECT * FROM evidence WHERE investigation_id = $1 ORDER BY substring(id from 4)::int`, [investigationId]);
    return r.rows.map(mapEvidence);
  }

  async getReport(investigationId: string): Promise<ReportRow | null> {
    const r = await this.pool.query('SELECT * FROM reports WHERE investigation_id = $1', [investigationId]);
    const x = r.rows[0];
    if (!x) return null;
    return {
      investigation_id: x.investigation_id, report: x.report, validation: x.validation,
      violations: x.violations, warnings: x.warnings, repair_attempted: x.repair_attempted,
    };
  }

  async listLlmCalls(investigationId: string): Promise<LlmCall[]> {
    const r = await this.pool.query('SELECT * FROM llm_calls WHERE investigation_id = $1 ORDER BY turn, attempt', [investigationId]);
    return r.rows.map(mapLlmCall);
  }

  async enqueueManual(incidentId: string): Promise<string> {
    const id = randomUUID();
    const r = await this.pool.query(
      `INSERT INTO investigation_jobs (id, incident_id, idempotency_key, status)
       VALUES ($1, $2, $3, 'queued') ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [id, incidentId, `incident:${incidentId}:manual:${randomUUID()}`]);
    if (!r.rows[0]) throw new Error('manual enqueue conflicted on a fresh uuid key');
    return r.rows[0].id;
  }

  async requestCancel(investigationId: string): Promise<void> {
    await this.pool.query('UPDATE investigations SET cancel_requested = true WHERE id = $1', [investigationId]);
  }

  evidenceSink(investigationId: string): EvidenceSink {
    return {
      append: async (row: Evidence) => {
        const e = Evidence.parse(row);
        if (e.investigation_id !== investigationId) throw new Error('evidence row belongs to another investigation');
        await this.pool.query(
          `INSERT INTO evidence (id, investigation_id, tool, source, args, rendered_query, window_start, window_end,
                                 status, error, result, stats, duration_ms, created_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)`,
          [e.id, e.investigation_id, e.tool, e.source, json(e.args ?? null), e.rendered_query,
            e.window?.start ?? null, e.window?.end ?? null, e.status, e.error, json(e.result ?? null),
            json(e.stats), e.duration_ms, e.created_at]);
      },
    };
  }

  reportSink(investigationId: string): { save(row: ReportRow): Promise<void> } {
    return {
      save: async (row: ReportRow) => {
        if (row.investigation_id !== investigationId) throw new Error('report row belongs to another investigation');
        await this.pool.query(
          `INSERT INTO reports (investigation_id, report, validation, violations, warnings, repair_attempted)
           VALUES ($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6)
           ON CONFLICT (investigation_id) DO UPDATE SET report = EXCLUDED.report, validation = EXCLUDED.validation,
             violations = EXCLUDED.violations, warnings = EXCLUDED.warnings, repair_attempted = EXCLUDED.repair_attempted`,
          [row.investigation_id, json(row.report), row.validation, json(row.violations), json(row.warnings), row.repair_attempted]);
      },
    };
  }

  // ── beyond the seam: what the worker and the LLM recorder need ──────────────

  /** One investigations row per attempt or run (persistence.md §1). */
  async createInvestigation(i: { incidentId: string; jobId: string | null; trigger: 'auto' | 'manual'; model: string; startedAt?: string }): Promise<InvestigationRow> {
    const r = await this.pool.query(
      `INSERT INTO investigations (id, incident_id, job_id, status, "trigger", model, started_at)
       VALUES ($1,$2,$3,'running',$4,$5,$6) RETURNING *`,
      [randomUUID(), i.incidentId, i.jobId, i.trigger, i.model, i.startedAt ?? new Date().toISOString()]);
    return mapInvestigation(r.rows[0]);
  }

  async finishInvestigation(id: string, f: { status: 'completed' | 'failed' | 'cancelled'; toolCalls: number; error: string | null }): Promise<void> {
    if (f.status === 'completed') {
      const rep = await this.pool.query('SELECT 1 FROM reports WHERE investigation_id = $1', [id]);
      if (!rep.rowCount) throw new Error('completed investigation needs a reports row (persistence.md §3)');
    }
    await this.pool.query(
      'UPDATE investigations SET status = $2, finished_at = now(), tool_calls = $3, error = $4 WHERE id = $1',
      [id, f.status, f.toolCalls, f.error]);
  }

  /** One llm_calls row per provider attempt, via toLlmCallRow(). */
  async insertLlmCall(rec: LlmCallRecord): Promise<LlmCall> {
    const c = toLlmCallRow(rec);
    await this.insertLlmCallRow(c);
    return c;
  }

  async insertLlmCallRow(c: LlmCall): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_calls (id, investigation_id, turn, attempt, provider, model, stage, kind, status, request_id,
         input_tokens, output_tokens, cache_read_tokens, latency_ms, stop_reason, tool_call_count, error_kind,
         error_status, error_message, retry_after_ms, provider_timings, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22)`,
      [c.id, c.investigation_id, c.turn, c.attempt, c.provider, c.model, c.stage, c.kind, c.status, c.request_id,
        c.input_tokens, c.output_tokens, c.cache_read_tokens, c.latency_ms, c.stop_reason, c.tool_call_count,
        c.error_kind, c.error_status, c.error_message, c.retry_after_ms,
        c.provider_timings === null ? null : json(c.provider_timings), c.created_at]);
  }
}
