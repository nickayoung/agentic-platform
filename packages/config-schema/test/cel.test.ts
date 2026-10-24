// L3 with the real CEL checker (§5, §6.3): every expression in both fixtures compiles in its slot.
import { describe, expect, it } from 'vitest';
import { celChecker, exprFields, validate } from '../src/index';
import { loadFixture } from './helpers';

describe('L3 with @kairos/expr', () => {
  for (const name of ['lotus_line.yaml', 'yoga_starter.yaml']) {
    it(`${name}: every CEL field compiles in its slot`, () => {
      const doc = loadFixture(name);
      const r = validate(doc, { expr: celChecker(doc) });
      expect(r.issues.filter((i) => i.layer === 'L3')).toEqual([]);
      expect(exprFields(doc).length).toBeGreaterThan(0);
    });
  }

  it('reports a type error with its JSON Pointer and position', () => {
    const doc = loadFixture('lotus_line.yaml');
    const field = exprFields(doc).find((f) => f.result === 'bool');
    expect(field).toBeDefined();
    // put an expression with a type error where the first CEL field is
    let node: Record<PropertyKey, unknown> = doc as never;
    for (const k of field!.path.slice(0, -1)) node = node[k] as Record<PropertyKey, unknown>;
    node[field!.path.at(-1)!] = "customer.tier + 1 == 'x'";
    const r = validate(doc, { expr: celChecker(doc) });
    const l3 = r.issues.filter((i) => i.layer === 'L3');
    expect(l3).toHaveLength(1);
    expect(l3[0]!.severity).toBe('E');
    expect(l3[0]!.message).toMatch(/line 1, col/);
  });
});
