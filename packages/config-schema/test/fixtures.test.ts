// §15 Phase 0 acceptance 1: both §4b fixtures pass L1–L4, compile to their golden hashes, and match the spec text.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile, contentHash, validate } from '../src/index';
import { errors, fixturePath, loadFixture, specPath } from './helpers';

const FIXTURES = ['lotus_line.yaml', 'yoga_starter.yaml'] as const;
const goldenPath = fixturePath('golden-hashes.json');

describe('fixtures', () => {
  for (const name of FIXTURES) {
    it(`${name} parses and passes L1, L2 and L4 with no errors`, () => {
      const r = validate(loadFixture(name));
      expect(errors(r)).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }

  it('lotus_line.yaml reports no NOTICE_MISSING (and no warnings at all)', () => {
    const r = validate(loadFixture('lotus_line.yaml'));
    expect(r.issues.filter((i) => i.code === 'NOTICE_MISSING')).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('yoga_starter.yaml warns NOTICE_MISSING for the required notices it has no workflow for (§4b.2)', () => {
    const r = validate(loadFixture('yoga_starter.yaml'));
    expect(r.issues.every((i) => i.code === 'NOTICE_MISSING' && i.severity === 'W')).toBe(true);
    expect(r.issues.map((i) => i.message)).toEqual(expect.arrayContaining([expect.stringContaining('tenant.closing')]));
  });

  it('yoga_starter.yaml reports STAFF_REF_MISSING until the owner exists (§4b.2)', () => {
    const doc = loadFixture('yoga_starter.yaml');
    expect(validate(doc, { staff: [] }).issues.filter((i) => i.code === 'STAFF_REF_MISSING').map((i) => i.path))
      .toEqual(['/timetable/0/fixed/teacher']);
    expect(validate(doc, { staff: [{ key: 'owner', roles: ['teacher'] }] }).issues.filter((i) => i.severity === 'E')).toEqual([]);
  });

  it('match their golden hashes', () => {
    const actual = Object.fromEntries(FIXTURES.map((name) => {
      const doc = loadFixture(name);
      return [name, { content_hash: contentHash(doc), compiled_hash: compile(doc).content_hash }];
    }));
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(goldenPath, 'utf8')));
  });

  it('are identical to the YAML blocks in §4b (fixture header line aside)', () => {
    const spec = readFileSync(specPath, 'utf8');
    const block = (heading: string): string => {
      const at = spec.indexOf(`\n## ${heading}`);
      expect(at, heading).toBeGreaterThan(0);
      const m = /```yaml\n([\s\S]*?)```/.exec(spec.slice(at));
      if (!m) throw new Error(`no yaml block after ${heading}`);
      return m[1]!;
    };
    // Each fixture starts with one generated-from comment that the spec block does not have.
    const fixture = (name: string): string =>
      readFileSync(fixturePath(name), 'utf8').replace(/^# Generated from docs\/spec\/04b-example-configs\.md[^\n]*\n/, '');
    expect(fixture('lotus_line.yaml')).toBe(block('4b.1'));
    expect(fixture('yoga_starter.yaml')).toBe(block('4b.2'));
  });
});
