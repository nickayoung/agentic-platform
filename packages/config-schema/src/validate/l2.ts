// L2: references (§6.3).
import { PLATFORM_ROLES, type ConfigDocument, type TemplateDef } from '../schema';
import { Issues } from '../report';
import { buildModel, candidateRooms, isStaffRef, matchingResources, selectorKind, STAFF_PREFIX, type Model } from './model';

/** A person from the staff directory. Only `key` is needed for STAFF_REF_MISSING; roles and skills feed L4. */
export interface StaffRecord { key: string; active?: boolean; roles?: string[]; skills?: string[] }

/** Built-in fields per custom-field entity: the §3 record fields and the §5.3 CEL fields (booking fields are spread). */
export const BUILTIN_FIELDS: Record<'customer' | 'booking' | 'session' | 'resource', readonly string[]> = {
  customer: ['id', 'member_subject', 'state', 'suspended_until', 'suspension_reason', 'merged_into', 'linked_resource_id',
    'display_name', 'email', 'phone', 'timezone', 'home_location_key', 'tier', 'tier_key', 'strikes', 'waiver_signed_at',
    'custom', 'history', 'source'],
  booking: ['id', 'session_id', 'place_id', 'customer_id', 'session_start', 'group_id', 'state', 'payment', 'terms',
    'intake', 'booked_via', 'config_version', 'decision_id', 'source', 'start', 'end', 'duration_minutes', 'template',
    'entitlement', 'place', 'place_refilled', 'intake_complete'],
  session: ['id', 'template_key', 'template', 'series_key', 'occurrence_key', 'location_key', 'start', 'end', 'zone',
    'local_date', 'local_start', 'weekday', 'status', 'cancel_reason', 'capacity_total', 'booked_count', 'waitlist_count',
    'over_capacity', 'exception', 'detached', 'config_version', 'source', 'tags', 'custom'],
  resource: ['id', 'key', 'kind', 'type', 'type_key', 'config_key', 'staff_key', 'name', 'parent_id', 'location_keys',
    'home_location_key', 'timezone', 'attributes', 'tags', 'skills', 'roles', 'concurrency', 'layout_key', 'state',
    'leaves_at', 'payroll_ref', 'payroll_type', 'calendar_sync', 'source', 'custom'],
};

export interface L2Options { staff?: readonly StaffRecord[] }

export function checkReferences(doc: ConfigDocument, opts: L2Options, out: Issues, m: Model = buildModel(doc)): void {
  const keys = (xs: readonly { key: string }[]): Set<string> => new Set(xs.map((x) => x.key));
  const sets = {
    location: keys(doc.locations), unit: keys(doc.units), skill: keys(doc.skills), role: keys(doc.roles),
    tier: keys(doc.tiers), type: keys(doc.resource_types), resource: keys(doc.resources), layout: keys(doc.layouts),
    template: keys(doc.templates), policy: keys(doc.policies), product: keys(doc.entitlement_products),
    form: keys(doc.forms), field: keys(doc.custom_fields), issuer: keys(doc.access.issuers),
  };
  type Kind = keyof typeof sets;
  const ref = (kind: Kind, value: string | undefined, path: PropertyKey[]): void => {
    if (value !== undefined && !sets[kind].has(value)) out.error('UNKNOWN_REF', path, `unknown ${kind} "${value}"`);
  };
  const refs = (kind: Kind, values: readonly string[] | undefined, path: PropertyKey[]): void =>
    values?.forEach((v, i) => ref(kind, v, [...path, i]));
  const active = opts.staff === undefined ? undefined : new Set(opts.staff.filter((s) => s.active !== false).map((s) => s.key));
  const staffRef = (value: string, path: PropertyKey[]): void => {
    if (active !== undefined && !active.has(value.slice(STAFF_PREFIX.length))) {
      out.error('STAFF_REF_MISSING', path, `"${value}" does not match an active person`);
    }
  };
  const resourceRef = (value: string, path: PropertyKey[]): void =>
    (isStaffRef(value) ? staffRef(value, path) : ref('resource', value, path));

  // DUPLICATE_KEY: every keyed collection, top-level and nested.
  const unique = (xs: readonly { key: string }[], path: PropertyKey[]): void => {
    const seen = new Set<string>();
    xs.forEach((x, i) => {
      if (seen.has(x.key)) out.error('DUPLICATE_KEY', [...path, i, 'key'], `duplicate key "${x.key}"`);
      seen.add(x.key);
    });
  };
  for (const c of ['locations', 'units', 'skills', 'roles', 'tiers', 'resource_types', 'resources', 'layouts', 'templates',
    'timetable', 'policies', 'entitlement_products', 'availability', 'constraints', 'coverage', 'workflows',
    'custom_fields', 'forms', 'views', 'simulation'] as const) {
    unique(doc[c], [c]);
  }
  unique(doc.access.issuers, ['access', 'issuers']);
  doc.resource_types.forEach((t, i) => unique(t.attributes, ['resource_types', i, 'attributes']));
  doc.policies.forEach((p, i) => unique(p.limits, ['policies', i, 'limits']));
  doc.entitlement_products.forEach((e, i) => unique(e.caps ?? [], ['entitlement_products', i, 'caps']));

  // ROLE_NAME_CLASH (§4.4).
  doc.roles.forEach((r, i) => {
    if ((PLATFORM_ROLES as readonly string[]).includes(r.key)) {
      out.error('ROLE_NAME_CLASH', ['roles', i, 'key'], `config role "${r.key}" equals a platform role`);
    }
    refs('skill', r.implies_skills, ['roles', i, 'implies_skills']);
  });

  ref('product', doc.tenant.refund_credit_product, ['tenant', 'refund_credit_product']);
  doc.locations.forEach((l, i) => l.transfer_times?.forEach((x, j) => ref('location', x.to, ['locations', i, 'transfer_times', j, 'to'])));

  doc.resources.forEach((r, i) => {
    ref('type', r.type, ['resources', i, 'type']);
    ref('location', r.location, ['resources', i, 'location']);
    ref('layout', r.layout, ['resources', i, 'layout']);
  });
  doc.layouts.forEach((l, i) => ref('type', l.spot_type, ['layouts', i, 'spot_type']));

  doc.templates.forEach((t, i) => {
    const at = (...p: PropertyKey[]): PropertyKey[] => ['templates', i, ...p];
    unique(t.requirements, at('requirements'));
    ref('policy', t.policy, at('policy'));
    ref('form', t.intake?.form, at('intake', 'form'));
    t.cost?.units?.forEach((u, j) => ref('unit', u.unit, at('cost', 'units', j, 'unit')));
    if (t.scheduling.mode === 'rostered') {
      t.scheduling.starts.forEach((s, j) => refs('location', s.locations, at('scheduling', 'starts', j, 'locations')));
    }
    t.requirements.forEach((q, j) => {
      const sp = at('requirements', j, 'select');
      ref('type', q.select.type, [...sp, 'type']);
      ref('role', q.select.role, [...sp, 'role']);
      refs('skill', q.select.skills_all, [...sp, 'skills_all']);
      q.select.resources?.forEach((v, k) => resourceRef(v, [...sp, 'resources', k]));
    });
    checkCapacity(m, t, i, out);

    // FIXED_AMBIGUOUS (§4.6): a fixed requirement of a rostered template must match one resource per studio.
    if (t.scheduling.mode === 'rostered') {
      const studios = new Set(t.scheduling.starts.flatMap((s) => s.locations ?? doc.locations.map((l) => l.key)));
      t.requirements.forEach((q, j) => {
        if (q.assign !== 'fixed' || selectorKind(m, q) === 'person' || q.select.where !== undefined) return;
        for (const loc of studios) {
          const hits = matchingResources(m, q, loc);
          if (hits.length > 1) {
            out.error('FIXED_AMBIGUOUS', at('requirements', j), `"${q.key}" matches ${hits.length} resources at ${loc}: `
              + hits.map((r) => r.key).join(', '));
          }
        }
      });
    }
  });

  doc.timetable.forEach((s, i) => {
    const at = (...p: PropertyKey[]): PropertyKey[] => ['timetable', i, ...p];
    ref('template', s.template, at('template'));
    ref('location', s.location, at('location'));
    const t = m.templates.get(s.template);
    for (const [req, value] of Object.entries(s.fixed)) {
      if (t !== undefined && !t.requirements.some((q) => q.key === req)) {
        out.error('UNKNOWN_REF', at('fixed', req), `template "${s.template}" has no requirement "${req}"`);
      }
      if (Array.isArray(value)) value.forEach((v, k) => resourceRef(v, at('fixed', req, k)));
      else resourceRef(value, at('fixed', req));
    }
  });

  doc.entitlement_products.forEach((e, i) => {
    ref('tier', e.tier, ['entitlement_products', i, 'tier']);
    e.grants.forEach((g, j) => ref('unit', g.unit, ['entitlement_products', i, 'grants', j, 'unit']));
  });

  doc.availability.forEach((a, i) => {
    refs('location', a.applies_to.locations, ['availability', i, 'applies_to', 'locations']);
    refs('resource', a.applies_to.resources, ['availability', i, 'applies_to', 'resources']);
  });

  doc.constraints.forEach((c, i) => {
    refs('role', c.applies_to.roles, ['constraints', i, 'applies_to', 'roles']);
    refs('template', c.applies_to.templates, ['constraints', i, 'applies_to', 'templates']);
  });

  doc.coverage.forEach((c, i) => {
    ref('location', c.location, ['coverage', i, 'location']);
    ref('role', c.role, ['coverage', i, 'role']);
    refs('template', c.shift_templates, ['coverage', i, 'shift_templates']);
  });

  doc.workflows.forEach((w, i) => {
    const at = (...p: PropertyKey[]): PropertyKey[] => ['workflows', i, ...p];
    if ('at' in w.trigger) refs('template', w.trigger.at.templates, at('trigger', 'at', 'templates'));
    if ('every' in w.trigger) ref('location', w.trigger.every.location, at('trigger', 'every', 'location'));
    w.actions.forEach((a, j) => {
      if (a.type === 'create_task') ref('location', a.location, at('actions', j, 'location'));
      if (a.type === 'adjust_units') ref('unit', a.unit, at('actions', j, 'unit'));
      if (a.type === 'request_solve') refs('role', a.scope.roles, at('actions', j, 'scope', 'roles'));
      if (a.type === 'set_field' && !doc.custom_fields.some((f) => f.key === a.field && f.entity === a.entity)) {
        out.error('UNKNOWN_REF', at('actions', j, 'field'), `no ${a.entity} custom field "${a.field}"`);
      }
    });
  });

  // FIELD_SHADOWS_BUILTIN (§4.12).
  doc.custom_fields.forEach((f, i) => {
    if (BUILTIN_FIELDS[f.entity].includes(f.key)) {
      out.error('FIELD_SHADOWS_BUILTIN', ['custom_fields', i, 'key'], `"${f.key}" is a built-in ${f.entity} field`);
    }
  });
  doc.forms.forEach((f, i) => refs('field', f.fields, ['forms', i, 'fields']));

  doc.simulation.forEach((s, i) => s.demand.forEach((d, j) => {
    refs('template', d.templates, ['simulation', i, 'demand', j, 'templates']);
    for (const tier of Object.keys(d.tier_mix ?? {})) ref('tier', tier, ['simulation', i, 'demand', j, 'tier_mix', tier]);
  }));

  doc.access.role_mappings.forEach((r, i) => ref('issuer', r.issuer, ['access', 'role_mappings', i, 'issuer']));
  doc.access.staff_role_mappings.forEach((r, i) => {
    ref('issuer', r.issuer, ['access', 'staff_role_mappings', i, 'issuer']);
    ref('role', r.role, ['access', 'staff_role_mappings', i, 'role']);
  });
}

/** CAPACITY_REQUIREMENT_MISSING, LAYOUT_MISSING, and partition `to` references (§4.6). */
function checkCapacity(m: Model, t: TemplateDef, i: number, out: Issues): void {
  if (t.participants.who !== 'customers') return;
  const c = t.participants.capacity;
  const cp: PropertyKey[] = ['templates', i, 'participants', 'capacity'];
  if (c.mode === 'mixed') {
    const known = new Set(['general', ...c.partitions.map((p) => p.key)]);
    const seen = new Set<string>();
    c.partitions.forEach((p, j) => {
      if (seen.has(p.key) || p.key === 'general') out.error('DUPLICATE_KEY', [...cp, 'partitions', j, 'key'], `duplicate partition "${p.key}"`);
      seen.add(p.key);
      if (p.release !== undefined && (!known.has(p.release.to) || p.release.to === p.key)) {
        out.error('UNKNOWN_REF', [...cp, 'partitions', j, 'release', 'to'], `unknown partition "${p.release.to}"`);
      }
    });
  }
  const base = c.mode === 'mixed' ? c.base : c;
  if (base.mode === 'pooled') return;
  const rp = c.mode === 'mixed' ? [...cp, 'base', 'requirement'] : [...cp, 'requirement'];
  const q = t.requirements.find((r) => r.key === base.requirement);
  if (q === undefined) {
    out.error('CAPACITY_REQUIREMENT_MISSING', rp, `no requirement "${base.requirement}"`);
    return;
  }
  if (selectorKind(m, q) !== 'space') {
    out.error('CAPACITY_REQUIREMENT_MISSING', rp, `requirement "${q.key}" does not select a space`);
    return;
  }
  if (base.mode !== 'assigned') return;
  if (q.provides_layout !== true) {
    out.error('CAPACITY_REQUIREMENT_MISSING', rp, `assigned capacity needs "${q.key}" to set provides_layout`);
    return;
  }
  // LAYOUT_MISSING. With `where`, the candidates are the rooms the timetable fixes (see candidateRooms).
  const bare = candidateRooms(m, t, q).filter((r) => r.layout === undefined).map((r) => r.key);
  if (bare.length > 0) out.error('LAYOUT_MISSING', rp, `assigned capacity, but these candidate rooms have no layout: ${bare.join(', ')}`);
}
