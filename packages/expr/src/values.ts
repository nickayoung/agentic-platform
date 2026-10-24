// Runtime values. int = bigint (64-bit checked), double = number, timestamp/duration = exact nanoseconds.
// Lists are arrays; maps are JS Maps (from literals) or plain objects (from the activation).
// Host values are normalised lazily, on read, using the node's static type.

import { EvalFail, type RuntimeRule } from './errors';
import { DUR_MAX_NS, formatDuration, formatTimestamp, NS_PER_MS, parseDuration, parseTimestamp, TS_MAX_NS, TS_MIN_NS } from './time';
import type { Type } from './types';

export class Timestamp {
  constructor(readonly ns: bigint) {}
  static fromDate(d: Date): Timestamp {
    return new Timestamp(BigInt(d.getTime()) * NS_PER_MS);
  }
  static parse(s: string): Timestamp | null {
    const ns = parseTimestamp(s);
    return ns === null ? null : new Timestamp(ns);
  }
  toString(): string {
    return formatTimestamp(this.ns);
  }
  toDate(): Date {
    return new Date(Number(this.ns / NS_PER_MS));
  }
}

export class Duration {
  constructor(readonly ns: bigint) {}
  static parse(s: string): Duration | null {
    const ns = parseDuration(s);
    return ns === null ? null : new Duration(ns);
  }
  toString(): string {
    return formatDuration(this.ns);
  }
}

export type Kind = 'null' | 'bool' | 'int' | 'double' | 'string' | 'timestamp' | 'duration' | 'list' | 'map';

export const INT_MAX = 2n ** 63n - 1n;
export const INT_MIN = -(2n ** 63n);

export const fail = (rule: RuntimeRule, msg: string, pos = -1): EvalFail => new EvalFail(rule, msg, pos);

export function kindOf(v: unknown): Kind {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return 'bool';
    case 'bigint':
      return 'int';
    case 'number':
      return 'double';
    case 'string':
      return 'string';
    case 'object':
      if (v instanceof Timestamp) return 'timestamp';
      if (v instanceof Duration) return 'duration';
      if (Array.isArray(v)) return 'list';
      return 'map';
    default:
      throw fail('invalid_argument', `unsupported host value of type ${typeof v}`);
  }
}

export function checkInt(v: bigint): bigint {
  if (v > INT_MAX || v < INT_MIN) throw fail('int_overflow', 'integer overflow');
  return v;
}
export function checkTs(ns: bigint): Timestamp {
  if (ns < TS_MIN_NS || ns > TS_MAX_NS) throw fail('timestamp_range', 'timestamp out of range');
  return new Timestamp(ns);
}
export function checkDur(ns: bigint): Duration {
  if (ns > DUR_MAX_NS || ns < -DUR_MAX_NS) throw fail('duration_range', 'duration out of range');
  return new Duration(ns);
}

/** Converts a host value read from the activation to a CEL value, guided by its static type. */
export function norm(raw: unknown, t: Type | undefined): unknown {
  if (raw === undefined) throw fail('unbound_variable', 'value is missing from the activation');
  if (raw === null) return null;
  const k = t ? (t.k === 'nullable' ? t.inner.k : t.k) : 'dyn';
  switch (typeof raw) {
    case 'number':
      if (k === 'double') return raw;
      if (k === 'int' || (k === 'dyn' && Number.isInteger(raw))) {
        if (!Number.isInteger(raw)) throw fail('invalid_argument', `expected an int, got ${raw}`);
        return checkInt(BigInt(raw));
      }
      return raw;
    case 'bigint':
      if (k === 'double') return Number(raw);
      return checkInt(raw);
    case 'string':
      if (k === 'timestamp') {
        const ts = Timestamp.parse(raw);
        if (!ts) throw fail('invalid_argument', `not an RFC 3339 timestamp: ${raw}`);
        return ts;
      }
      if (k === 'duration') {
        const d = Duration.parse(raw);
        if (!d) throw fail('invalid_argument', `not a duration: ${raw}`);
        return d;
      }
      return raw;
    case 'object':
      if (raw instanceof Date) return checkTs(BigInt(raw.getTime()) * NS_PER_MS);
      return raw;
    default:
      return raw;
  }
}

export const isMapLike = (v: unknown): v is Map<unknown, unknown> | Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) && !(v instanceof Duration);

/** Map key lookup. int and integral double keys are interchangeable (heterogeneous equality). */
export function mapLookup(m: Map<unknown, unknown> | Record<string, unknown>, key: unknown): { found: boolean; value?: unknown } {
  const kk = kindOf(key);
  if (kk !== 'string' && kk !== 'int' && kk !== 'bool' && kk !== 'double')
    throw fail('no_matching_overload', `unsupported map key type ${kk}`);
  if (m instanceof Map) {
    if (m.has(key)) return { found: true, value: m.get(key) };
    if (typeof key === 'number' && Number.isInteger(key) && m.has(BigInt(key))) return { found: true, value: m.get(BigInt(key)) };
    return { found: false };
  }
  if (typeof key !== 'string') return { found: false };
  return Object.hasOwn(m, key) ? { found: true, value: m[key] } : { found: false };
}

export function mapSize(m: Map<unknown, unknown> | Record<string, unknown>): number {
  return m instanceof Map ? m.size : Object.keys(m).length;
}

export function mapEntries(m: Map<unknown, unknown> | Record<string, unknown>): [unknown, unknown][] {
  return m instanceof Map ? [...m.entries()] : Object.entries(m);
}

/** Exact comparison of an int with a double. NaN for unordered (NaN). */
function cmpIntDouble(a: bigint, b: number): number {
  if (Number.isNaN(b)) return NaN;
  if (b === Infinity) return -1;
  if (b === -Infinity) return 1;
  const f = Math.floor(b);
  const bf = BigInt(f);
  if (a < bf) return -1;
  if (a > bf) return 1;
  return b > f ? -1 : 0;
}

/** CEL heterogeneous equality. Mismatched kinds are unequal; int and double compare numerically. */
export function celEquals(x: unknown, y: unknown): boolean {
  const a = norm(x, undefined);
  const b = norm(y, undefined);
  const ka = kindOf(a);
  const kb = kindOf(b);
  if ((ka === 'int' || ka === 'double') && (kb === 'int' || kb === 'double')) {
    if (ka === kb) return a === b;
    return ka === 'int' ? cmpIntDouble(a as bigint, b as number) === 0 : cmpIntDouble(b as bigint, a as number) === 0;
  }
  if (ka !== kb) return false;
  switch (ka) {
    case 'timestamp':
    case 'duration':
      return (a as Timestamp).ns === (b as Timestamp).ns;
    case 'list': {
      const la = a as unknown[];
      const lb = b as unknown[];
      return la.length === lb.length && la.every((v, i) => celEquals(v, lb[i]));
    }
    case 'map': {
      const ma = a as Map<unknown, unknown>;
      const mb = b as Map<unknown, unknown>;
      if (mapSize(ma) !== mapSize(mb)) return false;
      for (const [k, v] of mapEntries(ma)) {
        const o = mapLookup(mb, k);
        if (!o.found || !celEquals(v, o.value)) return false;
      }
      return true;
    }
    default:
      return a === b;
  }
}

/** Ordering: -1, 0, 1, or NaN when unordered. Throws for kinds without an ordering. */
export function celCompare(a: unknown, b: unknown): number {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if ((ka === 'int' || ka === 'double') && (kb === 'int' || kb === 'double')) {
    if (ka === 'int' && kb === 'int') return a === b ? 0 : (a as bigint) < (b as bigint) ? -1 : 1;
    if (ka === 'double' && kb === 'double') {
      const x = a as number;
      const y = b as number;
      return Number.isNaN(x) || Number.isNaN(y) ? NaN : x === y ? 0 : x < y ? -1 : 1;
    }
    return ka === 'int' ? cmpIntDouble(a as bigint, b as number) : -cmpIntDouble(b as bigint, a as number);
  }
  if (ka !== kb) throw fail('no_matching_overload', `no ordering between ${ka} and ${kb}`);
  switch (ka) {
    case 'string': {
      // Code-point order (UTF-16 comparison differs for astral characters).
      const x = a as string;
      const y = b as string;
      if (x === y) return 0;
      const ia = x[Symbol.iterator]();
      const ib = y[Symbol.iterator]();
      for (;;) {
        const ca = ia.next();
        const cb = ib.next();
        if (ca.done) return cb.done ? 0 : -1;
        if (cb.done) return 1;
        const d = ca.value.codePointAt(0)! - cb.value.codePointAt(0)!;
        if (d !== 0) return d < 0 ? -1 : 1;
      }
    }
    case 'bool':
      return a === b ? 0 : a === false ? -1 : 1;
    case 'timestamp':
    case 'duration': {
      const x = (a as Timestamp).ns;
      const y = (b as Timestamp).ns;
      return x === y ? 0 : x < y ? -1 : 1;
    }
    default:
      throw fail('no_matching_overload', `${ka} values are not ordered`);
  }
}

/** UTF-8 length of a JS string. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) i++;
    n++;
  }
  return n;
}

/** A JSON-friendly form of a CEL value (ints as numbers when safe, else strings; timestamps RFC 3339). */
export function toJson(v: unknown): unknown {
  switch (kindOf(v)) {
    case 'int': {
      const n = v as bigint;
      return n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : n.toString();
    }
    case 'timestamp':
    case 'duration':
      return String(v);
    case 'list':
      return (v as unknown[]).map((e) => toJson(norm(e, undefined)));
    case 'map': {
      const out: Record<string, unknown> = {};
      for (const [k, e] of mapEntries(v as Map<unknown, unknown>)) out[String(k)] = toJson(norm(e, undefined));
      return out;
    }
    default:
      return v;
  }
}
