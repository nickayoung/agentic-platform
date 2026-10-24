// Static checking against a slot's declared variables (§5.3): unknown variables and fields, type
// mismatches, functions outside §5.4, enum literals, closed history keys, nullable selection
// (EXPR_NULLABLE warning), macro ranges, and the static cost estimate (§5.5).

import type { Node } from './ast';
import type { CompileError, CompileErrorCode, CompileRule, CompileWarning } from './errors';
import { positionAt } from './errors';
import { LIMITS, listCharge, regexCharge, stringCharge } from './limits';
import { compileRegex, RegexError } from './regex';
import type { SlotDef } from './slots';
import { isValidZone } from './time';
import { assignable, equatable, isNullable, isNumeric, join, orderable, strip, T, type Type, typeToString } from './types';
import { Duration, Timestamp } from './values';

export interface CheckResult {
  type: Type;
  errors: CompileError[];
  warnings: CompileWarning[];
}

type Facts = Set<string>;

const ts = typeToString;

export function check(root: Node, src: string, slot: SlotDef): CheckResult {
  const c = new Checker(src, slot);
  const type = c.node(root, new Set());
  return { type, errors: c.errors, warnings: c.warnings };
}

/** The source path of a selection chain (`booking.entitlement`), or null. Used for null guards. */
function pathOf(n: Node): string | null {
  switch (n.k) {
    case 'ident':
      return n.name;
    case 'select': {
      if (n.test) return null;
      const p = pathOf(n.operand);
      return p === null ? null : `${p}.${n.field}`;
    }
    case 'index': {
      const p = pathOf(n.operand);
      if (p === null || n.index.k !== 'lit') return null;
      return `${p}[${JSON.stringify(String(n.index.v))}]`;
    }
    default:
      return null;
  }
}

/** Paths known to be non-null when `n` evaluates to `when`. */
function facts(n: Node, when: boolean): Facts {
  const out: Facts = new Set();
  const add = (s: Facts) => s.forEach((p) => out.add(p));
  switch (n.k) {
    case 'binary': {
      if (n.op !== '==' && n.op !== '!=') break;
      const isNull = (x: Node) => x.k === 'lit' && x.v === null;
      const isNonNullLit = (x: Node) => x.k === 'lit' && x.v !== null;
      const [l, r] = [n.left, n.right];
      const p = pathOf(isNull(l) || isNonNullLit(l) ? r : l);
      const other = isNull(l) || isNonNullLit(l) ? l : r;
      if (p === null) break;
      // x != null is true, x == null is false, or x == <non-null literal> is true.
      if (isNull(other) && ((n.op === '!=' && when) || (n.op === '==' && !when))) out.add(p);
      if (isNonNullLit(other) && n.op === '==' && when) out.add(p);
      break;
    }
    case 'logic':
      if ((n.op === '&&' && when) || (n.op === '||' && !when)) for (const a of n.args) add(facts(a, when));
      break;
    case 'unary':
      if (n.op === '!') add(facts(n.operand, !when));
      break;
    case 'select':
      if (n.test && when) {
        const p = pathOf({ ...n, test: false });
        if (p) out.add(p);
      }
      break;
  }
  return out;
}

/** Is the range of a macro rooted in the activation (a variable, possibly selected or indexed)? */
function rootedInActivation(n: Node): boolean {
  switch (n.k) {
    case 'ident':
      return true;
    case 'select':
      return !n.test && rootedInActivation(n.operand);
    case 'index':
      return rootedInActivation(n.operand);
    default:
      return false;
  }
}

const union = (a: Facts, b: Facts): Facts => (b.size === 0 ? a : new Set([...a, ...b]));

class Checker {
  errors: CompileError[] = [];
  warnings: CompileWarning[] = [];
  private scopes: Map<string, Type>[] = [];

  constructor(
    private src: string,
    private slot: SlotDef,
  ) {}

  private error(code: CompileErrorCode, rule: CompileRule, message: string, pos: number): Type {
    this.errors.push({ code, rule, message, position: positionAt(this.src, pos) });
    return T.dyn;
  }
  private typeError(rule: CompileRule, message: string, pos: number): Type {
    return this.error('EXPR_TYPE', rule, message, pos);
  }

  node(n: Node, g: Facts): Type {
    const t = this.infer(n, g);
    n.type = t;
    return t;
  }

  private infer(n: Node, g: Facts): Type {
    switch (n.k) {
      case 'lit':
        if (n.v === null) return T.null;
        if (typeof n.v === 'bigint') return T.int;
        if (typeof n.v === 'number') return T.double;
        if (typeof n.v === 'string') return T.string;
        return T.bool;
      case 'ident': {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
          const t = this.scopes[i]!.get(n.name);
          if (t) return t;
        }
        const t = this.slot.variables[n.name];
        if (t) return t;
        return this.error(
          'EXPR_UNKNOWN_VAR',
          'unknown_variable',
          `unknown variable '${n.name}' in slot '${this.slot.name}' (declared: ${Object.keys(this.slot.variables).join(', ')})`,
          n.pos,
        );
      }
      case 'select':
        return this.select(n, g);
      case 'index':
        return this.index(n, g);
      case 'list': {
        let t: Type | null = null;
        for (const e of n.elems) {
          const et = this.node(e, g);
          if (t === null) t = et;
          else {
            const j = join(t, et);
            if (!j) {
              this.typeError('type_mismatch', `list elements must have one type: ${ts(t)} and ${ts(et)}`, e.pos);
              t = T.dyn;
            } else t = j;
          }
        }
        return T.list(t ?? T.dyn);
      }
      case 'map': {
        let kt: Type | null = null;
        let vt: Type | null = null;
        const seen = new Set<string>();
        for (const { key, value } of n.entries) {
          const k = this.node(key, g);
          const v = this.node(value, g);
          if (!['string', 'int', 'bool', 'dyn'].includes(strip(k).k))
            this.typeError('type_mismatch', `map keys must be string, int or bool, not ${ts(k)}`, key.pos);
          if (key.k === 'lit') {
            const sig = `${typeof key.v}:${String(key.v)}`;
            if (seen.has(sig)) this.typeError('type_mismatch', `duplicate map key ${String(key.v)}`, key.pos);
            seen.add(sig);
          }
          kt = kt === null ? k : (join(kt, k) ?? this.typeError('type_mismatch', `map keys must have one type`, key.pos));
          vt = vt === null ? v : (join(vt, v) ?? this.typeError('type_mismatch', `map values must have one type`, value.pos));
        }
        return T.map(kt ?? T.dyn, vt ?? T.dyn);
      }
      case 'unary': {
        const t = strip(this.node(n.operand, g));
        if (n.op === '!') {
          if (t.k !== 'bool' && t.k !== 'dyn') return this.typeError('no_overload', `'!' needs a bool, not ${ts(t)}`, n.pos);
          return T.bool;
        }
        if (t.k === 'int' || t.k === 'double' || t.k === 'duration' || t.k === 'dyn') return t;
        return this.typeError('no_overload', `unary '-' is not defined for ${ts(t)}`, n.pos);
      }
      case 'binary':
        return this.binary(n, g);
      case 'logic': {
        let acc = g;
        for (const a of n.args) {
          const t = strip(this.node(a, acc));
          if (t.k !== 'bool' && t.k !== 'dyn') this.typeError('no_overload', `'${n.op}' needs bool operands, not ${ts(t)}`, a.pos);
          acc = union(acc, facts(a, n.op === '&&'));
        }
        return T.bool;
      }
      case 'cond': {
        const tt = strip(this.node(n.test, g));
        if (tt.k !== 'bool' && tt.k !== 'dyn') this.typeError('no_overload', `the ?: condition must be bool, not ${ts(tt)}`, n.test.pos);
        const a = this.node(n.then, union(g, facts(n.test, true)));
        const b = this.node(n.else, union(g, facts(n.test, false)));
        return join(a, b) ?? this.typeError('type_mismatch', `?: branches have different types: ${ts(a)} and ${ts(b)}`, n.pos);
      }
      case 'call':
        return this.call(n, g);
      case 'comp':
        return this.comp(n, g);
    }
  }

  private nullableUse(operand: Node, t: Type, g: Facts, what: string, pos: number) {
    if (!isNullable(t)) return;
    const p = pathOf(operand);
    if (p !== null && g.has(p)) return;
    this.warnings.push({
      code: 'EXPR_NULLABLE',
      rule: 'nullable_select',
      message: `${p ?? 'the operand'} can be null; ${what} without a guard such as '${p ?? 'x'} != null && ...' is an error when it is null`,
      position: positionAt(this.src, pos),
    });
  }

  private select(n: Extract<Node, { k: 'select' }>, g: Facts): Type {
    const ot = this.node(n.operand, g);
    this.nullableUse(n.operand, ot, g, `selecting '${n.field}'`, n.pos);
    const t = strip(ot);
    let ft: Type;
    switch (t.k) {
      case 'object': {
        const f = t.fields[n.field];
        if (!f)
          return this.typeError(
            'unknown_field',
            `${t.name} has no field '${n.field}' (fields: ${Object.keys(t.fields).join(', ')})`,
            n.pos,
          );
        ft = f;
        n.hasKey = false;
        break;
      }
      case 'map':
        if (!['string', 'dyn'].includes(strip(t.key).k)) return this.typeError('no_overload', `cannot select a field of ${ts(t)}`, n.pos);
        if (t.closedKeys && !t.closedKeys.includes(n.field))
          this.error('UNKNOWN_HISTORY_KEY', 'history_key', `'${n.field}' is not a key of the compiled config`, n.pos);
        ft = t.value;
        n.hasKey = true;
        break;
      case 'dyn':
        ft = T.dyn;
        n.hasKey = true;
        break;
      default:
        return this.typeError('no_overload', `cannot select field '${n.field}' of ${ts(t)}`, n.pos);
    }
    return n.test ? T.bool : ft;
  }

  private index(n: Extract<Node, { k: 'index' }>, g: Facts): Type {
    const ot = this.node(n.operand, g);
    const it = this.node(n.index, g);
    this.nullableUse(n.operand, ot, g, 'indexing', n.pos);
    const t = strip(ot);
    switch (t.k) {
      case 'list':
        if (!['int', 'dyn'].includes(strip(it).k)) return this.typeError('no_overload', `list index must be int, not ${ts(it)}`, n.index.pos);
        return t.elem;
      case 'map':
        if (!assignable(it, t.key)) return this.typeError('no_overload', `map key must be ${ts(t.key)}, not ${ts(it)}`, n.index.pos);
        if (t.closedKeys && n.index.k === 'lit' && typeof n.index.v === 'string' && !t.closedKeys.includes(n.index.v))
          this.error('UNKNOWN_HISTORY_KEY', 'history_key', `'${n.index.v}' is not a tag or template key of the compiled config`, n.index.pos);
        return t.value;
      case 'dyn':
        return T.dyn;
      default:
        return this.typeError('no_overload', `cannot index ${ts(t)}`, n.pos);
    }
  }

  private enumCheck(a: Node, at: Type, b: Node, pos: number) {
    const s = strip(at);
    if (s.k === 'string' && s.enum && b.k === 'lit' && typeof b.v === 'string' && !s.enum.includes(b.v))
      this.typeError('enum_value', `'${b.v}' is not one of ${s.enum.map((v) => `'${v}'`).join(', ')}`, b.pos ?? pos);
    void a;
  }

  private binary(n: Extract<Node, { k: 'binary' }>, g: Facts): Type {
    const a = this.node(n.left, g);
    const b = this.node(n.right, g);
    const sa = strip(a);
    const sb = strip(b);
    const bad = () => this.typeError('no_overload', `'${n.op}' is not defined for ${ts(a)} and ${ts(b)}`, n.pos);
    switch (n.op) {
      case '==':
      case '!=':
        if (!equatable(a, b)) return bad();
        this.enumCheck(n.left, a, n.right, n.pos);
        this.enumCheck(n.right, b, n.left, n.pos);
        return T.bool;
      case '<':
      case '<=':
      case '>':
      case '>=':
        return orderable(a, b) ? T.bool : bad();
      case 'in':
        if (sb.k === 'list') {
          if (!equatable(a, sb.elem)) return bad();
          if (n.left.k === 'lit') this.enumCheck(n.right, sb.elem, n.left, n.pos);
          else if (n.right.k === 'list') for (const e of n.right.elems) this.enumCheck(n.left, a, e, n.pos);
          return T.bool;
        }
        if (sb.k === 'map') return equatable(a, sb.key) ? T.bool : bad();
        if (sb.k === 'dyn') return T.bool;
        return bad();
    }
    // Arithmetic overloads.
    const sigs: [string, string, Type][] = [];
    const num = (k: 'int' | 'double') => sigs.push([k, k, k === 'int' ? T.int : T.double]);
    switch (n.op) {
      case '+':
        num('int');
        num('double');
        sigs.push(['string', 'string', T.string], ['timestamp', 'duration', T.timestamp], ['duration', 'timestamp', T.timestamp], ['duration', 'duration', T.duration]);
        if (sa.k === 'list' || sb.k === 'list' || sa.k === 'dyn' || sb.k === 'dyn') {
          const ea = sa.k === 'list' ? sa.elem : T.dyn;
          const eb = sb.k === 'list' ? sb.elem : T.dyn;
          sigs.push(['list', 'list', T.list(join(ea, eb) ?? T.dyn)]);
          if (sa.k === 'list' && sb.k === 'list' && !join(ea, eb)) return bad();
        }
        break;
      case '-':
        num('int');
        num('double');
        sigs.push(['timestamp', 'timestamp', T.duration], ['timestamp', 'duration', T.timestamp], ['duration', 'duration', T.duration]);
        break;
      case '*':
      case '/':
        num('int');
        num('double');
        break;
      case '%':
        num('int');
        break;
    }
    const m = sigs.filter(([x, y]) => (sa.k === 'dyn' || sa.k === x) && (sb.k === 'dyn' || sb.k === y));
    if (m.length === 0) return bad();
    const r0 = m[0]![2];
    return m.every((s) => ts(s[2]) === ts(r0)) ? r0 : T.dyn;
  }

  private want(arg: Node, t: Type, param: Type, fn: string): boolean {
    if (assignable(t, param)) return true;
    this.typeError('no_overload', `${fn}() expects ${ts(param)}, not ${ts(t)}`, arg.pos);
    return false;
  }

  private call(n: Extract<Node, { k: 'call' }>, g: Facts): Type {
    const target = n.target ? this.node(n.target, g) : null;
    const args = n.args.map((a) => this.node(a, g));
    const fn = n.fn;
    const arity = (k: number, receiver: boolean | 'either') => {
      const okRecv = receiver === 'either' ? true : receiver === (n.target !== null);
      const total = args.length + (n.target ? 1 : 0);
      if (!okRecv || total !== k) {
        const form = receiver === true ? `x.${fn}(${k - 1} args)` : receiver === 'either' ? `${fn}(x) or x.${fn}()` : `${fn}(${k} args)`;
        this.typeError('no_overload', `${fn} has no such overload; use ${form}`, n.pos);
        return false;
      }
      return true;
    };
    // Receiver and arguments as one list.
    const all = n.target ? [target!, ...args] : args;
    const nodes = n.target ? [n.target, ...n.args] : n.args;

    switch (fn) {
      case 'size': {
        if (!arity(1, 'either')) return T.int;
        const t = strip(all[0]!);
        if (!['string', 'list', 'map', 'dyn'].includes(t.k)) this.typeError('no_overload', `size() is not defined for ${ts(t)}`, n.pos);
        return T.int;
      }
      case 'contains':
      case 'startsWith':
      case 'endsWith':
        if (arity(2, true)) {
          this.want(nodes[0]!, all[0]!, T.string, fn);
          this.want(nodes[1]!, all[1]!, T.string, fn);
        }
        return T.bool;
      case 'matches': {
        if (!arity(2, 'either')) return T.bool;
        this.want(nodes[0]!, all[0]!, T.string, fn);
        const p = nodes[1]!;
        if (p.k !== 'lit' || typeof p.v !== 'string') {
          this.error('EXPR_SYNTAX', 'regex', 'matches() takes a literal pattern only', p.pos);
          return T.bool;
        }
        if ([...p.v].length > LIMITS.regexPatternLength) {
          this.error('EXPR_SYNTAX', 'regex', `matches() pattern is longer than ${LIMITS.regexPatternLength} characters`, p.pos);
          return T.bool;
        }
        try {
          n.regex = compileRegex(p.v);
        } catch (e) {
          if (!(e instanceof RegexError)) throw e;
          this.error('EXPR_SYNTAX', 'regex', `invalid RE2 pattern: ${e.message}`, p.pos);
        }
        return T.bool;
      }
      case 'localDate':
      case 'localTime':
      case 'weekday':
        if (arity(2, false)) {
          this.want(nodes[0]!, all[0]!, T.timestamp, fn);
          this.zoneArg(nodes[1]!, all[1]!, fn);
        }
        return T.string;
      case 'today':
        if (arity(1, false)) this.zoneArg(nodes[0]!, all[0]!, fn);
        return T.string;
      case 'hoursUntil':
        if (arity(1, false)) this.want(nodes[0]!, all[0]!, T.timestamp, fn);
        return T.double;
      case 'minutesBetween':
        if (arity(2, false)) {
          this.want(nodes[0]!, all[0]!, T.timestamp, fn);
          this.want(nodes[1]!, all[1]!, T.timestamp, fn);
        }
        return T.int;
      case 'duration':
      case 'timestamp': {
        const rt = fn === 'duration' ? T.duration : T.timestamp;
        if (!arity(1, false)) return rt;
        const a = nodes[0]!;
        if (strip(all[0]!).k === rt.k) return rt; // identity overload
        if (!this.want(a, all[0]!, T.string, fn)) return rt;
        if (a.k === 'lit' && typeof a.v === 'string') {
          const v = fn === 'duration' ? Duration.parse(a.v) : Timestamp.parse(a.v);
          if (!v) this.typeError('invalid_literal', `invalid ${fn} literal '${a.v}'`, a.pos);
          else n.konst = v;
        }
        return rt;
      }
      case 'hasTag':
      case 'hasSkill': {
        if (!arity(2, false)) return T.bool;
        const x = strip(all[0]!);
        const field = fn === 'hasTag' ? 'tags' : 'skills';
        this.nullableUse(nodes[0]!, all[0]!, g, `${fn}()`, nodes[0]!.pos);
        const ok =
          x.k === 'dyn' ||
          (x.k === 'object' &&
            (x.fields[field]?.k === 'list' ||
              (fn === 'hasSkill' && strip(x.fields.resource ?? T.null).k === 'object' && 'skills' in (strip(x.fields.resource!) as { fields: object }).fields)));
        if (!ok) this.typeError('no_overload', `${fn}() needs a value with '${field}', not ${ts(all[0]!)}`, nodes[0]!.pos);
        this.want(nodes[1]!, all[1]!, T.string, fn);
        return T.bool;
      }
      case 'min':
      case 'max': {
        if (n.target || args.length < 2) {
          this.typeError('no_overload', `${fn}() takes two or more numbers`, n.pos);
          return T.dyn;
        }
        const ks = new Set(args.map((t) => strip(t).k).filter((k) => k !== 'dyn'));
        if ([...ks].some((k) => k !== 'int' && k !== 'double') || ks.size > 1) {
          this.typeError('no_overload', `${fn}() arguments must all be int or all be double: ${args.map(ts).join(', ')}`, n.pos);
          return T.dyn;
        }
        return ks.size === 1 ? (ks.has('int') ? T.int : T.double) : T.dyn;
      }
      case 'round':
      case 'floor':
      case 'ceil': {
        if (!arity(1, false)) return T.dyn;
        const t = strip(all[0]!);
        if (isNumeric(t) || t.k === 'dyn') return t;
        this.typeError('no_overload', `${fn}() needs a number, not ${ts(t)}`, n.pos);
        return T.dyn;
      }
      default:
        return this.typeError('unknown_function', `'${fn}' is not a function of the profile (§5.4)`, n.pos);
    }
  }

  private zoneArg(a: Node, t: Type, fn: string) {
    if (!this.want(a, t, T.string, fn)) return;
    if (a.k === 'lit' && typeof a.v === 'string' && !isValidZone(a.v)) this.typeError('invalid_literal', `unknown time zone '${a.v}'`, a.pos);
  }

  private comp(n: Extract<Node, { k: 'comp' }>, g: Facts): Type {
    const rt = this.node(n.range, g);
    if (!rootedInActivation(n.range))
      this.typeError('macro_range', `${n.macro}() ranges over lists from the activation only, not over a literal or computed list`, n.range.pos);
    this.nullableUse(n.range, rt, g, `${n.macro}()`, n.pos);
    const r = strip(rt);
    let elem: Type = T.dyn;
    if (r.k === 'list') elem = r.elem;
    else if (r.k !== 'dyn') this.typeError('macro_range', `${n.macro}() needs a list, not ${ts(rt)}`, n.range.pos);
    this.scopes.push(new Map([[n.v, elem]]));
    try {
      let inner = g;
      if (n.pred) {
        const pt = strip(this.node(n.pred, g));
        if (pt.k !== 'bool' && pt.k !== 'dyn') this.typeError('no_overload', `the ${n.macro}() predicate must be bool, not ${ts(pt)}`, n.pred.pos);
        inner = union(g, facts(n.pred, true));
      }
      const xt = n.xform ? this.node(n.xform, inner) : null;
      switch (n.macro) {
        case 'filter':
          return T.list(elem);
        case 'map':
          return T.list(xt ?? T.dyn);
        default:
          return T.bool;
      }
    } finally {
      this.scopes.pop();
    }
  }
}

/** Upper bound on runtime steps (§5.5 "static cost estimate"); same units as the step budget. */
export function estimateCost(n: Node): number {
  const sum = (xs: (Node | null)[]) => xs.reduce((s, x) => s + (x ? estimateCost(x) : 0), 0);
  switch (n.k) {
    case 'lit':
    case 'ident':
      return 1;
    case 'select':
      return 1 + estimateCost(n.operand);
    case 'index':
      return 1 + sum([n.operand, n.index]);
    case 'list':
      return 1 + sum(n.elems);
    case 'map':
      return 1 + sum(n.entries.flatMap((e) => [e.key, e.value]));
    case 'unary':
      return 1 + estimateCost(n.operand);
    case 'binary': {
      let extra = 0;
      const l = n.left.type ? strip(n.left.type).k : 'dyn';
      const r = n.right.type ? strip(n.right.type).k : 'dyn';
      if (n.op === 'in') extra = listCharge(LIMITS.producedListElements);
      else if (['list', 'map', 'dyn'].includes(l) || ['list', 'map', 'dyn'].includes(r)) extra = listCharge(LIMITS.producedListElements);
      else if (l === 'string' || r === 'string') extra = stringCharge(LIMITS.producedStringBytes);
      return 1 + extra + sum([n.left, n.right]);
    }
    case 'logic':
      return 1 + sum(n.args);
    case 'cond':
      return 1 + estimateCost(n.test) + Math.max(estimateCost(n.then), estimateCost(n.else));
    case 'call': {
      let extra = 0;
      if (n.fn === 'matches' && n.regex) extra = regexCharge(LIMITS.producedStringBytes, n.regex.insts.length);
      else if (['contains', 'startsWith', 'endsWith', 'size'].includes(n.fn)) extra = stringCharge(LIMITS.producedStringBytes);
      else if (n.fn === 'hasTag' || n.fn === 'hasSkill') extra = listCharge(LIMITS.producedListElements);
      return 1 + extra + sum([n.target, ...n.args]);
    }
    case 'comp':
      return 1 + estimateCost(n.range) + LIMITS.comprehensionInput * (1 + sum([n.pred, n.xform]));
  }
}

export const isBoolish = (t: Type): boolean => {
  const s = strip(t);
  return s.k === 'bool' || s.k === 'dyn';
};
