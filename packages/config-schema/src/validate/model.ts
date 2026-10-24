// Shared lookups for L2 and L4: key indexes, selector matching, generated spots and offset arithmetic.
// Nothing here evaluates CEL. A selector with `where` is matched on its structural fields only, so the result is a
// superset of the real candidates; callers that need exact candidates say what they do in that case.
import { durationMinutes } from '../schema';
import type {
  ConfigDocument, LayoutDef, Offset, RequirementDef, ResourceDef, ResourceTypeDef, TemplateDef,
} from '../schema';

export interface Model {
  doc: ConfigDocument;
  types: Map<string, ResourceTypeDef>;
  resources: Map<string, ResourceDef>;
  layouts: Map<string, LayoutDef>;
  templates: Map<string, TemplateDef>;
}

export function buildModel(doc: ConfigDocument): Model {
  return {
    doc,
    types: new Map(doc.resource_types.map((t) => [t.key, t])),
    resources: new Map(doc.resources.map((r) => [r.key, r])),
    layouts: new Map(doc.layouts.map((l) => [l.key, l])),
    templates: new Map(doc.templates.map((t) => [t.key, t])),
  };
}

export const STAFF_PREFIX = '@staff:';
export const isStaffRef = (s: string): boolean => s.startsWith(STAFF_PREFIX);

/** 'person' when the selector picks staff, 'space' when it picks rooms or desks, null when it can't be told. */
export function selectorKind(m: Model, q: RequirementDef): 'person' | 'space' | 'spot' | null {
  const s = q.select;
  if (s.kind) return s.kind;
  if (s.type) return m.types.get(s.type)?.kind ?? null;
  if (s.role !== undefined || s.skills_all !== undefined) return 'person';
  const listed = (s.resources ?? []).map((k) => (isStaffRef(k) ? 'person' : m.types.get(m.resources.get(k)?.type ?? '')?.kind));
  if (listed.length > 0 && listed.every((k) => k === listed[0])) return listed[0] ?? null;
  return null;
}

/** Structural match of a config resource (room, desk) against a selector. Ignores `where`. */
export function matchesResource(m: Model, q: RequirementDef, r: ResourceDef): boolean {
  const s = q.select;
  const kind = m.types.get(r.type)?.kind;
  if (kind === 'person') return false;
  if (s.type !== undefined && r.type !== s.type) return false;
  if (s.kind !== undefined && kind !== s.kind) return false;
  if (s.role !== undefined || s.skills_all !== undefined) return false;
  if (s.resources !== undefined && !s.resources.includes(r.key)) return false;
  const tags = r.tags ?? [];
  if (s.tags_all !== undefined && !s.tags_all.every((t) => tags.includes(t))) return false;
  if (s.tags_any !== undefined && !s.tags_any.some((t) => tags.includes(t))) return false;
  return true;
}

export const matchingResources = (m: Model, q: RequirementDef, location?: string): ResourceDef[] =>
  m.doc.resources.filter((r) => matchesResource(m, q, r) && (location === undefined || r.location === location));

/**
 * Rooms a requirement can use. Without `where` these are exactly the structural matches. With `where` (CEL, not
 * evaluated here) they are the rooms the timetable fixes for this template, which are known to be candidates.
 */
export function candidateRooms(m: Model, t: TemplateDef, q: RequirementDef): ResourceDef[] {
  if (q.select.where === undefined) return matchingResources(m, q);
  const keys = new Set<string>();
  for (const s of m.doc.timetable) {
    if (s.template !== t.key) continue;
    for (const v of [s.fixed[q.key] ?? []].flat()) if (!isStaffRef(v)) keys.add(v);
  }
  return [...keys].flatMap((k) => m.resources.get(k) ?? []);
}

export const lanes = (m: Model, r: ResourceDef): number => r.concurrency ?? m.types.get(r.type)?.default_concurrency ?? 1;

// ── Spots (§4.5) ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface Spot { key: string; n: number; row: number; tags: string[]; disabled: boolean }

/** Spot n is in row ceil(n / per_row); its local key is `<prefix><n>` (the full key adds `<layout>.`). */
export function generateSpots(l: LayoutDef): Spot[] {
  const spots: Spot[] = [];
  for (let n = 1; n <= l.generate.count; n++) {
    const spot: Spot = { key: `${l.generate.prefix}${n}`, n, row: Math.ceil(n / l.generate.per_row), tags: [], disabled: false };
    for (const o of l.overrides ?? []) {
      const hit = (o.match.keys?.includes(spot.key) ?? false) || (o.match.rows?.includes(spot.row) ?? false);
      if (!hit) continue;
      for (const t of o.tags ?? []) if (!spot.tags.includes(t)) spot.tags.push(t);
      if (o.disabled !== undefined) spot.disabled = o.disabled;
    }
    spots.push(spot);
  }
  return spots;
}

export const activeSpots = (l: LayoutDef): Spot[] => generateSpots(l).filter((s) => !s.disabled);

/** Places a session in this room would have: room capacity for pooled_from_space, live mats for assigned. */
export function roomCapacity(m: Model, t: TemplateDef, room: ResourceDef | undefined): number | null {
  if (t.participants.who !== 'customers') return null;
  const c = t.participants.capacity;
  const mode = c.mode === 'mixed' ? c.base.mode : c.mode;
  if (c.mode === 'pooled') return c.places;
  if (c.mode === 'mixed' && c.base.mode === 'pooled') return c.base.places;
  if (room === undefined) return null;
  if (mode === 'pooled_from_space') {
    const v = room.attributes?.capacity ?? m.types.get(room.type)?.attributes.find((a) => a.key === 'capacity')?.default;
    return typeof v === 'number' ? v : null;
  }
  const layout = room.layout === undefined ? undefined : m.layouts.get(room.layout);
  return layout === undefined ? null : activeSpots(layout).length;
}

// ── Offsets (§4.2) ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An offset as minutes relative to the session start, as a [earliest, latest] range. `at_local` moves the instant to a
 * wall-clock time on that day, so it can land up to a day either side; the range covers that.
 */
export function offsetRange(o: Offset, sessionMinutes: number): [number, number] {
  if ('before_start' in o) {
    const x = -durationMinutes(o.before_start);
    return o.at_local === undefined ? [x, x] : [x - 1440, x + 1440];
  }
  if ('after_start' in o) { const x = durationMinutes(o.after_start); return [x, x]; }
  if ('before_end' in o) { const x = sessionMinutes - durationMinutes(o.before_end); return [x, x]; }
  const x = sessionMinutes + durationMinutes(o.after_end);
  return [x, x];
}

export const isStartRelative = (o: Offset): boolean => 'before_start' in o || 'after_start' in o;

/** Session lengths (minutes) of the templates that use a policy; [0] when only start-relative offsets matter. */
export function policyDurations(m: Model, policy: string): number[] {
  return m.doc.templates.filter((t) => t.policy === policy).map((t) => durationMinutes(t.duration));
}

export const templateTags = (m: Model): Set<string> => new Set(m.doc.templates.flatMap((t) => t.tags ?? []));
