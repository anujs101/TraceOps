import { describe, expect, it } from 'vitest';
import { METRIC_NAMES, METRIC_TEMPLATES, deriveWindows } from '@traceops/contracts';
import {
  escapeRegex, renderLogQuery, renderMetricQuery, renderVolumeQuery, resolveWindow, stepFor,
} from '../../src/tools/render.ts';

const windows = deriveWindows('2026-11-16T18:25:39.000Z', '2026-11-16T18:30:39.000Z');
// incident 18:23:39–18:30:39, baseline 18:08:39–18:23:39 (capped 15 min), allowed 17:25:39–18:30:39

describe('resolveWindow', () => {
  it('maps "incident" and "baseline" to deriveWindows', () => {
    expect(resolveWindow('incident', windows)).toEqual({ ok: true, window: windows.incident });
    expect(resolveWindow('baseline', windows)).toEqual({ ok: true, window: windows.baseline });
  });
  it('accepts an explicit window inside allowed', () => {
    const w = { start: '2026-11-16T18:00:00.000Z', end: '2026-11-16T18:10:00.000Z' };
    expect(resolveWindow(w, windows)).toEqual({ ok: true, window: w });
  });
  it('accepts the allowed bounds exactly', () => {
    expect(resolveWindow({ ...windows.allowed }, windows).ok).toBe(true);
  });
  it('rejects a window starting before allowed', () => {
    const r = resolveWindow({ start: '2026-11-16T17:25:38.999Z', end: '2026-11-16T18:00:00.000Z' }, windows);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(windows.allowed.start);
  });
  it('rejects a window ending after the investigation start', () => {
    expect(resolveWindow({ start: '2026-11-16T18:20:00.000Z', end: '2026-11-16T18:30:39.001Z' }, windows).ok).toBe(false);
  });
});

describe('stepFor keeps series at <= 60 points', () => {
  const span = (min: number) => ({ start: '2026-11-16T18:00:00.000Z', end: new Date(Date.parse('2026-11-16T18:00:00.000Z') + min * 60_000).toISOString() });
  it.each([[2, 15, 15], [14, 15, 15], [15, 15, 30], [60, 15, 75], [60, 60, 120], [30, 60, 60]])('%i min, base %is → %is', (min, base, step) => {
    expect(stepFor(span(min), base)).toBe(step);
    expect(Math.floor((min * 60) / stepFor(span(min), base)) + 1).toBeLessThanOrEqual(60);
  });
});

describe('PromQL', () => {
  it('renders every metric template with the service bound', () => {
    for (const m of METRIC_NAMES) {
      const q = renderMetricQuery(m, 'demo-service');
      expect(q).toBe(METRIC_TEMPLATES[m].promql.replaceAll('$svc', 'demo-service'));
      expect(q).not.toContain('$svc');
    }
  });
  it.each(['Demo', 'a b', 'x"y', 'a{b}', '', 'a;b', 'demo_service'])('rejects service name %j', (svc) => {
    expect(() => renderMetricQuery('latency_p95', svc)).toThrow('invalid service name');
    expect(() => renderLogQuery(svc)).toThrow('invalid service name');
    expect(() => renderVolumeQuery(svc)).toThrow('invalid service name');
  });
});

describe('LogQL', () => {
  const svc = 'demo-service';
  it('base selector only', () => expect(renderLogQuery(svc)).toBe('{service_name="demo-service"}'));
  it('severity filter', () => expect(renderLogQuery(svc, { severity: 'error', match: null })).toBe('{service_name="demo-service"} | severity_text="error"'));
  it('message uses a line filter', () => {
    expect(renderLogQuery(svc, { severity: 'warn', match: { field: 'message', contains: 'timeout' } })).toBe('{service_name="demo-service"} | severity_text="warn" |= "timeout"');
  });
  it('exception_message is a case-insensitive regex with the model text regex-escaped', () => {
    expect(renderLogQuery(svc, { severity: null, match: { field: 'exception_message', contains: 'timeout exceeded' } })).toBe(
      '{service_name="demo-service"} | exception_message=~"(?i).*timeout exceeded.*"',
    );
  });
  it('escapes quotes and backslashes so model text cannot break out of the literal', () => {
    const q = renderLogQuery(svc, { severity: null, match: { field: 'message', contains: 'a" } | json | x="\\' } });
    expect(q).toBe('{service_name="demo-service"} |= "a\\" } | json | x=\\"\\\\"');
    // after the selector, exactly one string literal remains and it is closed once
    expect(q.slice('{service_name="demo-service"} |= '.length)).toBe(JSON.stringify('a" } | json | x="\\'));
  });
  it('neutralises regex metacharacters in exception_message matches', () => {
    expect(escapeRegex('a.b*c(d)|e[f]')).toBe('a\\.b\\*c\\(d\\)\\|e\\[f\\]');
    const q = renderLogQuery(svc, { severity: null, match: { field: 'exception_message', contains: '.*' } });
    expect(q).toBe('{service_name="demo-service"} | exception_message=~"(?i).*\\\\.\\\\*.*"');
  });
  it('handles newlines', () => {
    expect(renderLogQuery(svc, { severity: null, match: { field: 'message', contains: 'a\nb' } })).toContain('"a\\nb"');
  });
  it('volume query', () => {
    expect(renderVolumeQuery(svc)).toBe('sum by (severity_text) (count_over_time({service_name="demo-service"}[1m]))');
  });
});
