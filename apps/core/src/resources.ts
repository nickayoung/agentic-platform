// Resources: structural ones (rooms, front desks) come from the active config; people come from the staff directory
// (§3.4, §18.3). Mat spots are generated with places when classes are owned (Phase 3) and are not created here.
import type { Tx } from '@kairos/db';
import type { Doc } from './model';

const rid = () => `res_${crypto.randomUUID().replaceAll('-', '')}`;

/** Upserts one resource row per `resources[]` entry of the config (by config_key). Returns how many changed. */
export function materializeStructural(tx: Tx, doc: Doc, now: number): number {
  const types = new Map(doc.resource_types.map((t) => [t.key, t]));
  let n = 0;
  for (const r of doc.resources) {
    const type = types.get(r.type);
    if (!type || type.kind === 'person') continue;
    const concurrency = r.concurrency ?? type.default_concurrency ?? 1;
    const zone = doc.locations.find((l) => l.key === r.location)?.timezone ?? doc.tenant.default_timezone;
    n += tx.run(
      `INSERT INTO resource (id, kind, type_key, config_key, name, location_keys, home_location_key, timezone, attributes,
         tags, concurrency, layout_key, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'platform', ?, ?)
       ON CONFLICT (config_key) WHERE config_key IS NOT NULL DO UPDATE SET
         kind = excluded.kind, type_key = excluded.type_key, name = excluded.name, location_keys = excluded.location_keys,
         home_location_key = excluded.home_location_key, timezone = excluded.timezone, attributes = excluded.attributes,
         tags = excluded.tags, concurrency = excluded.concurrency, layout_key = excluded.layout_key,
         updated_at = excluded.updated_at, version = resource.version + 1
       WHERE resource.name IS NOT excluded.name OR resource.concurrency IS NOT excluded.concurrency
          OR resource.tags IS NOT excluded.tags OR resource.attributes IS NOT excluded.attributes
          OR resource.location_keys IS NOT excluded.location_keys OR resource.layout_key IS NOT excluded.layout_key`,
      rid(), type.kind, r.type, r.key, r.name, JSON.stringify([r.location]), r.location, zone,
      JSON.stringify(r.attributes ?? {}), JSON.stringify(r.tags ?? []), concurrency, r.layout ?? null, now, now,
    );
  }
  return n;
}

export interface DirectoryPerson {
  staff_key: string;
  name: string;
  email: string;
  groups: string[];
  studios?: string[];
  /** The identifier Gusto's CSV template matches on (§18.8, Q-14), and which template the person goes in. */
  payroll_ref?: string;
  payroll_type?: 'employee' | 'contractor';
}

/**
 * Applies directory people (§18.3): creates or updates person resources, sets config staff roles from
 * `access.staff_role_mappings` and their implied skills (§4.13). Manager overrides are a later phase.
 */
export function syncPeople(tx: Tx, doc: Doc, people: DirectoryPerson[], now: number): { created: number; updated: number } {
  const personType = doc.resource_types.find((t) => t.kind === 'person')?.key ?? 'staff';
  const roleDefs = new Map(doc.roles.map((r) => [r.key, r]));
  let created = 0;
  let updated = 0;
  for (const p of people) {
    const roles = [...new Set(doc.access.staff_role_mappings
      .filter((m) => m.claim === 'groups' && p.groups.includes(m.equals)).map((m) => m.role))].sort();
    const skills = [...new Set(roles.flatMap((r) => roleDefs.get(r)?.implies_skills ?? []))].sort().map((skill) => ({ skill }));
    const studios = (p.studios ?? []).filter((s) => doc.locations.some((l) => l.key === s));
    const locations = studios.length ? studios : doc.locations.map((l) => l.key);
    const existing = tx.maybe<{ id: string }>('SELECT id FROM resource WHERE staff_key = ?', p.staff_key);
    if (existing) {
      updated += tx.run(
        `UPDATE resource SET name = ?, email = ?, roles = ?, skills = ?, location_keys = ?, home_location_key = ?,
           payroll_ref = coalesce(?, payroll_ref), payroll_type = coalesce(?, payroll_type), updated_at = ?, version = version + 1
         WHERE id = ? AND (name IS NOT ? OR email IS NOT ? OR roles IS NOT ? OR location_keys IS NOT ?
           OR payroll_ref IS NOT coalesce(?, payroll_ref) OR payroll_type IS NOT coalesce(?, payroll_type))`,
        p.name, p.email.toLowerCase(), JSON.stringify(roles), JSON.stringify(skills), JSON.stringify(locations), locations[0] ?? null,
        p.payroll_ref ?? null, p.payroll_type ?? null, now,
        existing.id, p.name, p.email.toLowerCase(), JSON.stringify(roles), JSON.stringify(locations), p.payroll_ref ?? null, p.payroll_type ?? null,
      );
    } else {
      tx.run(
        `INSERT INTO resource (id, kind, type_key, staff_key, name, email, location_keys, home_location_key, timezone, roles,
           skills, concurrency, payroll_ref, payroll_type, source, created_at, updated_at)
         VALUES (?, 'person', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'platform', ?, ?)`,
        rid(), personType, p.staff_key, p.name, p.email.toLowerCase(), JSON.stringify(locations), locations[0] ?? null,
        doc.tenant.default_timezone, JSON.stringify(roles), JSON.stringify(skills), p.payroll_ref ?? null, p.payroll_type ?? null, now, now,
      );
      created++;
    }
  }
  return { created, updated };
}

export interface PersonRow {
  id: string;
  staff_key: string;
  name: string;
  email: string | null;
  roles: string[];
  location_keys: string[];
  state: string;
}

export function toPerson(r: Record<string, SqlStorageValue>): PersonRow {
  return {
    id: r.id as string, staff_key: r.staff_key as string, name: r.name as string, email: (r.email as string | null) ?? null,
    roles: JSON.parse(r.roles as string) as string[], location_keys: JSON.parse(r.location_keys as string) as string[],
    state: r.state as string,
  };
}
