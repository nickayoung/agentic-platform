// Tree-walking interpreter over the checked AST. No code generation (§19.12). Every evaluated node
// costs one step; O(n) operations cost extra (limits.ts). Steps and produced sizes are enforced here.

import type { Node } from './ast';
import { EvalFail } from './errors';
import { LIMITS, listCharge, regexCharge, stringCharge } from './limits';
import { runRegex } from './regex';
import { wallClock } from './time';
import { strip, T, type Type } from './types';
import {
  celCompare,
  celEquals,
  checkDur,
  checkInt,
  checkTs,
  codePointLength,
  Duration,
  fail,
  INT_MIN,
  isMapLike,
  kindOf,
  mapLookup,
  mapSize,
  norm,
  Timestamp,
  utf8Length,
} from './values';

export type Activation = Readonly<Record<string, unknown>>;

interface Frame {
  name: string;
  value: unknown;
  parent: Frame | null;
}

const NS_PER_MIN = 60_000_000_000n;
const NS_PER_HOUR = 3_600_000_000_000;

export class Interpreter {
  steps = 0;

  constructor(
    private act: Activation,
    private budget: number,
  ) {}

  private charge(n: number) {
    this.steps += n;
    if (this.steps > this.budget) throw new EvalFail('steps', `runtime step budget of ${this.budget} exceeded`, -1, true);
  }

  run(n: Node): unknown {
    return this.ev(n, null);
  }

  private ev(n: Node, f: Frame | null): unknown {
    this.charge(1);
    try {
      return this.step(n, f);
    } catch (e) {
      if (e instanceof EvalFail && e.offset < 0) e.offset = n.pos;
      throw e;
    }
  }

  private now(): Timestamp {
    const v = norm(this.act.now, T.timestamp);
    if (!(v instanceof Timestamp)) throw fail('invalid_argument', "'now' is not a timestamp");
    return v;
  }

  private step(n: Node, f: Frame | null): unknown {
    switch (n.k) {
      case 'lit':
        return n.v;
      case 'ident': {
        for (let fr = f; fr; fr = fr.parent) if (fr.name === n.name) return fr.value;
        const raw = this.act[n.name];
        if (raw === undefined) throw fail('unbound_variable', `variable '${n.name}' is not bound in the activation`);
        return norm(raw, n.type);
      }
      case 'select': {
        const o = this.ev(n.operand, f);
        if (o === null) throw fail('null_select', `cannot select '${n.field}' of null`);
        if (!isMapLike(o)) throw fail('no_such_field', `cannot select '${n.field}' of a ${kindOf(o)}`);
        const r = mapLookup(o, n.field);
        if (n.test) return n.hasKey ? r.found : r.found && r.value !== null && r.value !== undefined;
        if (!r.found || r.value === undefined) throw fail(n.hasKey ? 'no_such_key' : 'no_such_field', `no such ${n.hasKey ? 'key' : 'field'}: '${n.field}'`);
        return norm(r.value, n.type);
      }
      case 'index': {
        const o = this.ev(n.operand, f);
        const i = this.ev(n.index, f);
        if (o === null) throw fail('null_select', 'cannot index null');
        if (Array.isArray(o)) {
          let idx: bigint;
          if (typeof i === 'bigint') idx = i;
          else if (typeof i === 'number' && Number.isInteger(i)) idx = BigInt(i);
          else throw fail('no_matching_overload', `list index must be int, not ${kindOf(i)}`);
          if (idx < 0n || idx >= BigInt(o.length)) throw fail('index_out_of_range', `index ${idx} out of range [0, ${o.length})`);
          return norm(o[Number(idx)], n.type);
        }
        if (isMapLike(o)) {
          const r = mapLookup(o, i);
          if (!r.found || r.value === undefined) throw fail('no_such_key', `no such key: ${typeof i === 'string' ? `'${i}'` : String(i)}`);
          return norm(r.value, n.type);
        }
        throw fail('no_matching_overload', `cannot index a ${kindOf(o)}`);
      }
      case 'list': {
        const out = n.elems.map((e) => this.ev(e, f));
        this.listSize(out.length);
        return out;
      }
      case 'map': {
        const m = new Map<unknown, unknown>();
        for (const { key, value } of n.entries) {
          const k = this.ev(key, f);
          const kk = kindOf(k);
          if (kk !== 'string' && kk !== 'int' && kk !== 'bool') throw fail('no_matching_overload', `map keys must be string, int or bool, not ${kk}`);
          if (m.has(k)) throw fail('duplicate_key', `duplicate map key ${String(k)}`);
          m.set(k, this.ev(value, f));
        }
        return m;
      }
      case 'unary': {
        const v = this.ev(n.operand, f);
        if (n.op === '!') {
          if (typeof v !== 'boolean') throw fail('no_matching_overload', `'!' needs a bool, not ${kindOf(v)}`);
          return !v;
        }
        if (typeof v === 'bigint') {
          if (v === INT_MIN) throw fail('int_overflow', 'integer overflow');
          return -v;
        }
        if (typeof v === 'number') return -v;
        if (v instanceof Duration) return checkDur(-v.ns);
        throw fail('no_matching_overload', `unary '-' is not defined for ${kindOf(v)}`);
      }
      case 'binary':
        return this.binary(n, f);
      case 'logic':
        return this.logic(n, f);
      case 'cond': {
        const c = this.ev(n.test, f);
        if (typeof c !== 'boolean') throw fail('no_matching_overload', `?: condition must be bool, not ${kindOf(c)}`);
        return this.ev(c ? n.then : n.else, f);
      }
      case 'call':
        return this.call(n, f);
      case 'comp':
        return this.comp(n, f);
    }
  }

  private listSize(len: number) {
    if (len > LIMITS.producedListElements)
      throw new EvalFail('list_size', `produced list has ${len} elements; the limit is ${LIMITS.producedListElements}`, -1, true);
  }
  private stringSize(s: string) {
    const b = utf8Length(s);
    if (b > LIMITS.producedStringBytes)
      throw new EvalFail('string_size', `produced string is ${b} bytes; the limit is ${LIMITS.producedStringBytes}`, -1, true);
  }

  private logic(n: Extract<Node, { k: 'logic' }>, f: Frame | null): boolean {
    // CEL: the result is decided by any operand that decides it; errors elsewhere are absorbed.
    const decide = n.op === '&&' ? false : true;
    let err: EvalFail | null = null;
    for (const a of n.args) {
      let v: unknown;
      try {
        v = this.ev(a, f);
      } catch (e) {
        if (!(e instanceof EvalFail) || e.fatal) throw e;
        err ??= e;
        continue;
      }
      if (v === decide) return decide;
      if (typeof v !== 'boolean') err ??= fail('no_matching_overload', `'${n.op}' needs bool operands, not ${kindOf(v)}`, a.pos);
    }
    if (err) throw err;
    return !decide;
  }

  private binary(n: Extract<Node, { k: 'binary' }>, f: Frame | null): unknown {
    const a = this.ev(n.left, f);
    const b = this.ev(n.right, f);
    switch (n.op) {
      case '==':
      case '!=': {
        if (Array.isArray(a) || isMapLike(a)) this.charge(listCharge(Array.isArray(a) ? a.length : mapSize(a)));
        const eq = celEquals(a, b);
        return n.op === '==' ? eq : !eq;
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        // §5.3: comparing with null is false.
        if (a === null || b === null) return false;
        const c = celCompare(a, b);
        if (Number.isNaN(c)) return false;
        return n.op === '<' ? c < 0 : n.op === '<=' ? c <= 0 : n.op === '>' ? c > 0 : c >= 0;
      }
      case 'in': {
        if (Array.isArray(b)) {
          this.charge(listCharge(b.length));
          return b.some((e) => celEquals(a, e));
        }
        if (isMapLike(b)) return mapLookup(b, a).found;
        throw fail('no_matching_overload', `'in' needs a list or map, not ${kindOf(b)}`);
      }
    }
    return this.arith(n.op, a, b);
  }

  private arith(op: string, a: unknown, b: unknown): unknown {
    const bad = () => fail('no_matching_overload', `'${op}' is not defined for ${kindOf(a)} and ${kindOf(b)}`);
    if (typeof a === 'bigint' && typeof b === 'bigint') {
      switch (op) {
        case '+':
          return checkInt(a + b);
        case '-':
          return checkInt(a - b);
        case '*':
          return checkInt(a * b);
        case '/':
          if (b === 0n) throw fail('division_by_zero', 'division by zero');
          return checkInt(a / b);
        case '%':
          if (b === 0n) throw fail('modulus_by_zero', 'modulus by zero');
          if (a === INT_MIN && b === -1n) throw fail('int_overflow', 'integer overflow');
          return a % b;
      }
    }
    if (typeof a === 'number' && typeof b === 'number') {
      switch (op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
      }
      throw bad();
    }
    if (op === '+') {
      if (typeof a === 'string' && typeof b === 'string') {
        const s = a + b;
        this.charge(stringCharge(s.length));
        this.stringSize(s);
        return s;
      }
      if (Array.isArray(a) && Array.isArray(b)) {
        this.listSize(a.length + b.length);
        this.charge(listCharge(a.length + b.length));
        return [...a, ...b];
      }
      if (a instanceof Timestamp && b instanceof Duration) return checkTs(a.ns + b.ns);
      if (a instanceof Duration && b instanceof Timestamp) return checkTs(a.ns + b.ns);
      if (a instanceof Duration && b instanceof Duration) return checkDur(a.ns + b.ns);
    }
    if (op === '-') {
      if (a instanceof Timestamp && b instanceof Timestamp) return checkDur(a.ns - b.ns);
      if (a instanceof Timestamp && b instanceof Duration) return checkTs(a.ns - b.ns);
      if (a instanceof Duration && b instanceof Duration) return checkDur(a.ns - b.ns);
    }
    throw bad();
  }

  private str(v: unknown, fn: string): string {
    if (typeof v !== 'string') throw fail('no_matching_overload', `${fn}() expects a string, not ${kindOf(v)}`);
    return v;
  }
  private ts(v: unknown, fn: string): Timestamp {
    if (!(v instanceof Timestamp)) throw fail('no_matching_overload', `${fn}() expects a timestamp, not ${kindOf(v)}`);
    return v;
  }
  private wall(t: Timestamp, zone: string) {
    const w = wallClock(t.ns, zone);
    if (!w) throw fail('invalid_argument', `unknown time zone '${zone}'`);
    return w;
  }

  private call(n: Extract<Node, { k: 'call' }>, f: Frame | null): unknown {
    if (n.konst) return n.konst;
    const vals = (n.target ? [n.target, ...n.args] : n.args).map((a) => this.ev(a, f));
    const fn = n.fn;
    const [x, y] = vals;
    switch (fn) {
      case 'size': {
        if (typeof x === 'string') {
          this.charge(stringCharge(x.length));
          return BigInt(codePointLength(x));
        }
        if (Array.isArray(x)) return BigInt(x.length);
        if (isMapLike(x)) return BigInt(mapSize(x));
        throw fail('no_matching_overload', `size() is not defined for ${kindOf(x)}`);
      }
      case 'contains':
      case 'startsWith':
      case 'endsWith': {
        const s = this.str(x, fn);
        const t = this.str(y, fn);
        this.charge(stringCharge(s.length));
        return fn === 'contains' ? s.includes(t) : fn === 'startsWith' ? s.startsWith(t) : s.endsWith(t);
      }
      case 'matches': {
        const s = this.str(x, fn);
        const prog = n.regex!;
        this.charge(regexCharge(codePointLength(s), prog.insts.length));
        return runRegex(prog, s);
      }
      case 'localDate':
        return this.wall(this.ts(x, fn), this.str(y, fn)).date;
      case 'localTime':
        return this.wall(this.ts(x, fn), this.str(y, fn)).time;
      case 'weekday':
        return this.wall(this.ts(x, fn), this.str(y, fn)).weekday;
      case 'today':
        return this.wall(this.now(), this.str(x, fn)).date;
      case 'hoursUntil':
        return Number(this.ts(x, fn).ns - this.now().ns) / NS_PER_HOUR;
      case 'minutesBetween':
        // Elapsed whole minutes from the first to the second timestamp, truncated toward zero.
        return (this.ts(y, fn).ns - this.ts(x, fn).ns) / NS_PER_MIN;
      case 'duration': {
        if (x instanceof Duration) return x;
        const d = Duration.parse(this.str(x, fn));
        if (!d) throw fail('invalid_argument', `invalid duration '${String(x)}'`);
        return d;
      }
      case 'timestamp': {
        if (x instanceof Timestamp) return x;
        const t = Timestamp.parse(this.str(x, fn));
        if (!t) throw fail('invalid_argument', `invalid timestamp '${String(x)}'`);
        return t;
      }
      case 'hasTag':
        return this.listHas(x, 'tags', this.str(y, fn), fn);
      case 'hasSkill':
        return this.hasSkill(x, this.str(y, fn));
      case 'min':
      case 'max': {
        let best = vals[0];
        for (const v of vals.slice(1)) {
          const c = celCompare(v, best);
          if (Number.isNaN(c)) return NaN;
          if (fn === 'min' ? c < 0 : c > 0) best = v;
        }
        if (typeof best !== 'bigint' && typeof best !== 'number') throw fail('no_matching_overload', `${fn}() needs numbers`);
        return best;
      }
      case 'round':
      case 'floor':
      case 'ceil': {
        if (typeof x === 'bigint') return x;
        if (typeof x !== 'number') throw fail('no_matching_overload', `${fn}() needs a number, not ${kindOf(x)}`);
        if (fn === 'floor') return Math.floor(x);
        if (fn === 'ceil') return Math.ceil(x);
        return x < 0 ? -Math.round(-x) : Math.round(x); // half away from zero
      }
    }
    throw fail('no_matching_overload', `unknown function '${fn}'`);
  }

  private field(o: unknown, name: string): unknown {
    if (o === null) throw fail('null_select', `cannot select '${name}' of null`);
    if (!isMapLike(o)) throw fail('no_such_field', `cannot select '${name}' of a ${kindOf(o)}`);
    const r = mapLookup(o, name);
    if (!r.found || r.value === undefined) throw fail('no_such_field', `no such field: '${name}'`);
    return r.value;
  }

  private listHas(o: unknown, field: string, want: string, fn: string): boolean {
    const l = this.field(o, field);
    if (!Array.isArray(l)) throw fail('no_matching_overload', `${fn}() needs '${field}' to be a list`);
    this.charge(listCharge(l.length));
    return l.includes(want);
  }

  /**
   * True when the resource has the skill and it has not expired. `Resource.skills` is `list<string>`
   * (§5.3); expiry is read from an optional host field `skill_expires_at: { [skill]: timestamp }`.
   * A candidate is accepted and its `resource` used.
   */
  private hasSkill(o: unknown, skill: string): boolean {
    let r = o;
    if (isMapLike(r) && mapLookup(r, 'skills').found === false && mapLookup(r, 'resource').found) r = this.field(r, 'resource');
    if (!this.listHas(r, 'skills', skill, 'hasSkill')) return false;
    const exp = isMapLike(r) ? mapLookup(r, 'skill_expires_at') : { found: false };
    if (!exp.found || !isMapLike(exp.value)) return true;
    const at = mapLookup(exp.value, skill);
    if (!at.found || at.value === null || at.value === undefined) return true;
    const t = norm(at.value, T.timestamp);
    return t instanceof Timestamp && t.ns > this.now().ns;
  }

  private comp(n: Extract<Node, { k: 'comp' }>, f: Frame | null): unknown {
    const range = this.ev(n.range, f);
    if (!Array.isArray(range)) throw fail('no_matching_overload', `${n.macro}() needs a list, not ${kindOf(range)}`);
    if (range.length > LIMITS.comprehensionInput)
      throw new EvalFail(
        'comprehension_input',
        `${n.macro}() ranges over ${range.length} elements; the limit is ${LIMITS.comprehensionInput}`,
        n.pos,
        true,
      );
    const rt = n.range.type ? strip(n.range.type) : T.dyn;
    const elemType: Type = rt.k === 'list' ? rt.elem : T.dyn;
    const frame = (v: unknown): Frame => ({ name: n.v, value: norm(v, elemType), parent: f });
    const pred = (fr: Frame): unknown => this.ev(n.pred!, fr);
    switch (n.macro) {
      case 'all':
      case 'exists': {
        const decide = n.macro === 'exists';
        let err: EvalFail | null = null;
        for (const e of range) {
          this.charge(1);
          let v: unknown;
          try {
            v = pred(frame(e));
          } catch (x) {
            if (!(x instanceof EvalFail) || x.fatal) throw x;
            err ??= x;
            continue;
          }
          if (v === decide) return decide;
          if (typeof v !== 'boolean') err ??= fail('no_matching_overload', `${n.macro}() predicate must be bool`, n.pred!.pos);
        }
        if (err) throw err;
        return !decide;
      }
      case 'exists_one': {
        let count = 0;
        for (const e of range) {
          this.charge(1);
          const v = pred(frame(e));
          if (typeof v !== 'boolean') throw fail('no_matching_overload', 'exists_one() predicate must be bool', n.pred!.pos);
          if (v) count++;
        }
        return count === 1;
      }
      case 'filter':
      case 'map': {
        const out: unknown[] = [];
        for (const e of range) {
          this.charge(1);
          const fr = frame(e);
          if (n.pred) {
            const v = pred(fr);
            if (typeof v !== 'boolean') throw fail('no_matching_overload', `${n.macro}() predicate must be bool`, n.pred.pos);
            if (!v) continue;
          }
          out.push(n.macro === 'filter' ? fr.value : this.ev(n.xform!, fr));
        }
        this.listSize(out.length);
        return out;
      }
    }
  }
}

