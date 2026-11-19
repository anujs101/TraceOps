/**
 * The first live S2 run (2026-11-19T11:15:34Z, deepseek-flash): the FINAL (post-repair) report and
 * all 15 evidence rows, copied verbatim from docs/runs/s2-20261119T111534Z/ (report.json → .report,
 * evidence.json). Real model output and real tool output; nothing hand-written.
 * It fails validation with 7×V1 (non-ok evidence cited) and 6×V3 (hypotheses invent keys).
 */
import { readFileSync } from 'node:fs';
import type { Evidence } from '@traceops/contracts';

const dir = new URL('./s2-live-run/', import.meta.url);
export const s2Report: unknown = JSON.parse(readFileSync(new URL('report.json', dir), 'utf8'));
export const s2Evidence: Evidence[] = JSON.parse(readFileSync(new URL('evidence.json', dir), 'utf8'));
