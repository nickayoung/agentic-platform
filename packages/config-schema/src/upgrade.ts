// Schema 2.0 → 2.1 (§4.1) and the documented defaults for optional fields.
import type { ConfigDocument } from './schema';

export type ConfigDocument21 = ConfigDocument & { schema_version: '2.1' };

/**
 * 2.1 adds only optional fields, so a 2.0 document is a valid 2.1 document with the defaults. Publishing rewrites
 * `schema_version` to 2.1 (§4.1); nothing else changes. The input is not mutated.
 */
export function upgrade(doc: ConfigDocument): ConfigDocument21 {
  return { ...structuredClone(doc), schema_version: '2.1' };
}

/**
 * Upgrades, then fills every optional field whose default §4, §3 or §9.3 states, so engines never re-derive a default.
 * The workflow `scope` default depends on `tenant.member_messaging` (§9.3). The input is not mutated.
 */
export function withDefaults(doc: ConfigDocument): ConfigDocument21 {
  const d = upgrade(doc);
  const messaging = (d.tenant.member_messaging ??= 'record_holder');
  const types = new Map(d.resource_types.map((t) => [t.key, t]));
  for (const r of d.resources) r.concurrency ??= types.get(r.type)?.default_concurrency ?? 1;   // I-08
  for (const t of d.templates) {
    for (const q of t.requirements) {
      q.count ??= 1;
      q.occupancy ??= 'exclusive';
    }
  }
  for (const p of d.policies) {
    p.refund.late ??= 'none';
    p.strike_window ??= '90d';
  }
  for (const e of d.entitlement_products) if (e.kind === 'membership') e.dunning_grace ??= '3d';
  for (const c of d.constraints) {
    const r = c.rule;
    if (r.type === 'max_hours' || r.type === 'max_consecutive_days' || r.type === 'max_assignments') r.counts ??= 'all_work';
  }
  for (const w of d.workflows) w.scope ??= messaging === 'kairos' ? 'all' : 'owned';
  return d;
}
