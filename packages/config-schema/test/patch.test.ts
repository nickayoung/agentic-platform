import { describe, expect, it } from 'vitest';
import { applyJsonPatch, PatchError } from '../src/index';

describe('JSON Patch (RFC 6902)', () => {
  const doc = { a: 1, list: [1, 2, 3], o: { 'x/y': 1, 'm~n': 2 } };
  it('applies add, remove, replace, move, copy and test without mutating the input', () => {
    const out = applyJsonPatch(doc, [
      { op: 'add', path: '/list/-', value: 4 },
      { op: 'add', path: '/list/0', value: 0 },
      { op: 'remove', path: '/list/1' },
      { op: 'replace', path: '/a', value: 2 },
      { op: 'copy', from: '/a', path: '/b' },
      { op: 'move', from: '/o/x~1y', path: '/c' },
      { op: 'test', path: '/o/m~0n', value: 2 },
    ]);
    expect(out).toEqual({ a: 2, b: 2, c: 1, list: [0, 2, 3, 4], o: { 'm~n': 2 } });
    expect(doc).toEqual({ a: 1, list: [1, 2, 3], o: { 'x/y': 1, 'm~n': 2 } });
  });
  it('fails atomically with the failing op index', () => {
    try {
      applyJsonPatch(doc, [{ op: 'replace', path: '/a', value: 9 }, { op: 'test', path: '/a', value: 1 }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PatchError);
      expect((e as PatchError).index).toBe(1);
    }
    expect(() => applyJsonPatch(doc, [{ op: 'replace', path: '/missing', value: 1 }])).toThrow(PatchError);
    expect(() => applyJsonPatch(doc, [{ op: 'add', path: '/list/9', value: 1 }])).toThrow(PatchError);
    expect(() => applyJsonPatch(doc, [{ op: 'move', from: '/o', path: '/o/inner' }])).toThrow(PatchError);
  });
});
