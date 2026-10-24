// L1: schema (§6.3). SCHEMA_INVALID is a failed Zod safeParse with each issue's path as a JSON Pointer (§19.11);
// DURATION_GRAIN and LOCKED_PATH run on the parsed document.
import type { z } from 'zod';
import { canonicalJson } from '../canonical';
import { ConfigDocumentSchema, durationMinutes, type ConfigDocument } from '../schema';
import { Issues, pointer, type ValidationIssue } from '../report';

type ZodIssue = z.core.$ZodIssue;

/** Flattens Zod issues. For a union, only the branch with the fewest issues is reported, which is the closest match. */
function flatten(issues: readonly ZodIssue[], prefix: readonly PropertyKey[], out: ValidationIssue[]): void {
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      const best = issue.errors.reduce((a, b) => (b.length < a.length ? b : a));
      flatten(best, path, out);
      continue;
    }
    out.push({ layer: 'L1', code: 'SCHEMA_INVALID', severity: 'E', path: pointer(path), message: issue.message });
  }
}

export function parseSchema(input: unknown): { ok: true; doc: ConfigDocument } | { ok: false; issues: ValidationIssue[] } {
  const r = ConfigDocumentSchema.safeParse(input);
  if (r.success) return { ok: true, doc: r.data };
  const issues: ValidationIssue[] = [];
  flatten(r.error.issues, [], issues);
  return { ok: false, issues };
}

const timeMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** §4.2: session durations, buffers and series start times (and rostered shift starts) are multiples of 5m. */
export function checkDurationGrain(doc: ConfigDocument, out: Issues): void {
  const grain = (minutes: number, path: PropertyKey[], what: string): void => {
    if (minutes % 5 !== 0) out.error('DURATION_GRAIN', path, `${what} is not a multiple of 5 minutes`);
  };
  doc.templates.forEach((t, i) => {
    grain(durationMinutes(t.duration), ['templates', i, 'duration'], `duration ${t.duration}`);
    t.requirements.forEach((q, j) => {
      for (const side of ['before', 'after'] as const) {
        const b = q.buffers?.[side];
        if (b !== undefined) grain(durationMinutes(b), ['templates', i, 'requirements', j, 'buffers', side], `buffer ${b}`);
      }
    });
    if (t.scheduling.mode === 'rostered') {
      t.scheduling.starts.forEach((s, j) =>
        grain(timeMinutes(s.at), ['templates', i, 'scheduling', 'starts', j, 'at'], `shift start ${s.at}`));
    }
  });
  doc.timetable.forEach((s, i) => grain(timeMinutes(s.start_local), ['timetable', i, 'start_local'], `start ${s.start_local}`));
}

/**
 * §4.1.1: compared with `base` (the published document), the draft may not change a locked path, nor set or change a
 * penalty fee above `tenant.fee_ceiling`. Only an owner may, so callers skip this check for an owner's draft.
 */
export function checkLockedPaths(doc: ConfigDocument, base: ConfigDocument, out: Issues): void {
  const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);
  const locked: [PropertyKey[], unknown, unknown][] = [
    [['access'], doc.access, base.access],
    [['tenant', 'environment_guards'], doc.tenant.environment_guards, base.tenant.environment_guards],
    [['tenant', 'fee_ceiling'], doc.tenant.fee_ceiling, base.tenant.fee_ceiling],
    [['tenant', 'payroll_export'], doc.tenant.payroll_export, base.tenant.payroll_export],
  ];
  for (const [path, a, b] of locked) if (!same(a, b)) out.error('LOCKED_PATH', path, `${pointer(path)} is locked`);
  const ceiling = base.tenant.fee_ceiling.minor;
  const basePolicies = new Map(base.policies.map((p) => [p.key, p]));
  doc.policies.forEach((p, i) => {
    for (const which of ['late', 'no_show'] as const) {
      const fee = p.cancellation[which].fee;
      if (fee === undefined || fee.minor <= ceiling) continue;
      if (same(fee, basePolicies.get(p.key)?.cancellation[which].fee)) continue;
      out.error('LOCKED_PATH', ['policies', i, 'cancellation', which, 'fee'], `a fee above tenant.fee_ceiling is locked`);
    }
  });
}
