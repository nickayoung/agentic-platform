// L1, YAML parsing, upgrade, defaults and canonical hashing.
import { describe, expect, it } from 'vitest';
import {
  canonicalJson, compile, ConfigDocumentSchema, contentHash, parseConfigYaml, upgrade, validate, withDefaults,
} from '../src/index';
import { codes, edit, loadFixture, minimalDoc } from './helpers';

describe('minimal document', () => {
  it('is clean', () => {
    expect(validate(minimalDoc()).issues).toEqual([]);
  });
});

describe('L1 SCHEMA_INVALID', () => {
  it('reports a wrong type with a JSON Pointer path', () => {
    const r = validate(edit(minimalDoc(), (d: any) => { d.policies[0].cancellation.customer_can_cancel = 'yes'; }));
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([expect.objectContaining({
      layer: 'L1', code: 'SCHEMA_INVALID', severity: 'E', path: '/policies/0/cancellation/customer_can_cancel',
    })]);
  });

  it('rejects unknown fields, bad keys and bad durations', () => {
    const r = validate(edit(minimalDoc(), (d: any) => {
      d.tenant.colour = 'blue';
      d.units[0].key = 'Class-Credit';
      d.templates[0].duration = '1 hour';
    }));
    expect(r.issues.map((i) => i.path).sort()).toEqual(['/templates/0/duration', '/tenant', '/units/0/key']);
  });

  it('escapes JSON Pointer segments', () => {
    const r = validate(edit(minimalDoc(), (d: any) => { d.timetable[0].fixed = { 'a/b~c': 'room_1' }; }));
    expect(r.issues.map((i) => i.path)).toContain('/timetable/0/fixed/a~1b~0c');
  });

  it('reports the closest union branch', () => {
    const r = validate(edit(minimalDoc(), (d: any) => { d.policies[0].booking_window.opens = { before_start: 'soon' }; }));
    expect(r.issues.map((i) => i.path)).toEqual(['/policies/0/booking_window/opens/before_start']);
  });

  it('requires a policy for customer templates and limits hold_ttl to 15m', () => {
    const r = validate(edit(minimalDoc(), (d: any) => { delete d.templates[0].policy; d.tenant.hold_ttl = '20m'; }));
    expect(r.issues.map((i) => i.path).sort()).toEqual(['/templates/0/policy', '/tenant/hold_ttl']);
  });

  it('rejects 2.1-only fields in a 2.0 document', () => {
    const r = validate(edit(minimalDoc(), (d: any) => { d.schema_version = '2.0'; }));
    expect(r.issues.map((i) => i.path)).toEqual(['/workflows/0/trigger/event']);
  });
});

describe('L1 DURATION_GRAIN and LOCKED_PATH', () => {
  it('DURATION_GRAIN: durations, buffers, series and shift starts on a 5-minute grain', () => {
    const r = validate(edit(minimalDoc(), (d: any) => {
      d.templates[0].duration = '62m';
      d.templates[0].requirements[0].buffers.after = '7m';
      d.timetable[0].start_local = '09:03';
      d.templates[1].scheduling.starts[0].at = '08:01';
    }));
    expect(r.issues.filter((i) => i.code === 'DURATION_GRAIN').map((i) => i.path).sort()).toEqual([
      '/templates/0/duration', '/templates/0/requirements/0/buffers/after', '/templates/1/scheduling/starts/0/at',
      '/timetable/0/start_local',
    ]);
  });

  it('LOCKED_PATH: locked paths and fees above the ceiling may not change against the base', () => {
    const base = minimalDoc();
    const draft = edit(base, (d: any) => {
      d.tenant.fee_ceiling.minor = 9000;
      d.access.default_member_role = 'member';
      d.access.role_mappings.push({ issuer: 'staff_auth', claim: 'g', equals: 'x', grant: 'owner' });
      d.policies[0].cancellation.late.fee = { minor: 6000, currency: 'USD' };
    });
    const locked = validate(draft, { base }).issues.filter((i) => i.code === 'LOCKED_PATH').map((i) => i.path).sort();
    expect(locked).toEqual(['/access', '/policies/0/cancellation/late/fee', '/tenant/fee_ceiling']);
    expect(codes(validate(draft))).not.toContain('LOCKED_PATH');   // an owner's draft: no base passed
  });
});

describe('YAML', () => {
  const yaml = (body: string): string => body.replace(/^ {4}/gm, '');

  it('parses the YAML 1.2 core schema: yes/no/on/off are not booleans and are rejected unquoted', () => {
    for (const word of ['yes', 'no', 'on', 'off', 'Yes', 'OFF']) {
      const r = parseConfigYaml(`schema_version: "2.1"\nflagged: ${word}\n`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues[0]).toMatchObject({ code: 'SCHEMA_INVALID', path: '/flagged', message: expect.stringContaining('YAML 1.1') });
    }
  });

  it('a quoted "yes" is a string: fine in a string field, SCHEMA_INVALID in a boolean field', async () => {
    const { stringify } = await import('yaml');
    const text = stringify(minimalDoc()).replace('name: Mini Yoga', 'name: "yes"');
    const ok = parseConfigYaml(text);
    expect(ok.ok && ok.document.tenant.name).toBe('yes');
    const bad = parseConfigYaml(text.replace('customer_can_cancel: true', 'customer_can_cancel: "yes"'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues).toEqual([expect.objectContaining({ path: '/policies/0/cancellation/customer_can_cancel' })]);
  });

  it('true/false are the only booleans', () => {
    const r = parseConfigYaml(yaml(`
    a: true
    `));
    expect(r.ok).toBe(false);   // not a config document, but parsed: the only issues are schema issues
    if (!r.ok) expect(r.issues.every((i) => !i.message.startsWith('YAML'))).toBe(true);
  });

  it('rejects syntax errors, duplicate keys and a %YAML 1.1 directive', () => {
    expect(parseConfigYaml('a: [1, 2\n').ok).toBe(false);
    expect(parseConfigYaml('a: 1\na: 2\n').ok).toBe(false);
    const r = parseConfigYaml('%YAML 1.1\n---\na: 1\n');
    expect(r.ok).toBe(false);
  });

  it('round-trips a document through YAML', async () => {
    const { stringify } = await import('yaml');
    const doc = minimalDoc();
    const r = parseConfigYaml(stringify(doc));
    expect(r.ok && contentHash(r.document)).toBe(contentHash(doc));
  });
});

describe('upgrade 2.0 → 2.1', () => {
  const v20 = (): any => edit(minimalDoc(), (d: any) => {
    d.schema_version = '2.0';
    d.workflows[0].trigger.event = 'tenant.closing';
  });

  it('accepts a 2.0 document and rewrites only schema_version', () => {
    const doc = ConfigDocumentSchema.parse(v20());
    const up = upgrade(doc);
    expect(up.schema_version).toBe('2.1');
    expect({ ...up, schema_version: '2.0' }).toEqual(doc);
    expect(doc.schema_version).toBe('2.0');   // input not mutated
    expect(ConfigDocumentSchema.safeParse(up).success).toBe(true);
  });

  it('applies the 2.1 defaults when compiling', () => {
    const c = compile(v20());
    expect(c.schema_version).toBe('2.1');
    expect(c.document.tenant.member_messaging).toBe('record_holder');
    expect(c.document.policies[0]!.refund.late).toBe('none');
    expect(c.document.policies[0]!.strike_window).toBe('90d');
    expect(c.document.workflows[0]!.scope).toBe('owned');
    expect(c.document.templates[0]!.requirements[0]).toMatchObject({ count: 1, occupancy: 'exclusive' });
    expect(c.document.resources.find((r) => r.key === 'desk_1')!.concurrency).toBe(2);
    expect(c.content_hash).toBe(contentHash(c.document));
  });

  it('defaults workflow scope to all for member_messaging: kairos (§9.3)', () => {
    const d = withDefaults(ConfigDocumentSchema.parse(loadFixture('lotus_line.yaml')));
    expect(d.workflows.every((w) => w.scope === 'all')).toBe(true);
  });

  it('a 2.0 document validates like its upgrade', () => {
    const doc = v20();
    expect(validate(doc).issues.map((i) => i.code)).toEqual(validate(upgrade(doc)).issues.map((i) => i.code));
  });
});

describe('canonical form and hash', () => {
  it('is independent of key order', () => {
    const doc = minimalDoc();
    const reverse = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reverse);
      if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)]));
      return v;
    };
    const reordered = reverse(doc);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(doc));
    expect(canonicalJson(reordered)).toBe(canonicalJson(doc));
    expect(contentHash(reordered)).toBe(contentHash(doc));
  });

  it('changes with any value and is SHA-256 hex', () => {
    const doc = minimalDoc();
    expect(contentHash(doc)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(edit(doc, (d) => { d.tenant.name = 'Other'; }))).not.toBe(contentHash(doc));
  });

  it('compile is deterministic', () => {
    expect(canonicalJson(compile(minimalDoc()))).toBe(canonicalJson(compile(minimalDoc())));
  });
});
