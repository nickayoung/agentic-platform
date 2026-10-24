// A linear-time matcher for the RE2 subset `matches` accepts (§5.2). JS RegExp backtracks, so a
// hostile pattern could burn CPU; this compiles to a Thompson NFA and simulates it in O(text × program).
// The program is plain data, so a compiled expression stays serialisable.
//
// Supported: literals, `.`, classes `[...]` / `[^...]` with ranges, `\d \D \w \W \s \S`, escaped
// punctuation, `\n \t \r \f \v \a \xHH \x{H..}`, `^ $ \A \z`, groups `(...)`, `(?:...)`, `(?P<n>...)`,
// alternation, `* + ? {n} {n,} {n,m}` (and their lazy forms), and a leading `(?i)`.
// Rejected (compile error): backreferences, lookaround, `\b \B`, Unicode classes `\p`, POSIX classes,
// other flags.

export type Inst =
  | { op: 'char'; ranges: number[]; neg: boolean; out: number }
  | { op: 'any'; out: number }
  | { op: 'split'; x: number; y: number }
  | { op: 'bol'; out: number }
  | { op: 'eol'; out: number }
  | { op: 'match' };

export interface RegexProgram {
  insts: Inst[];
  start: number;
  ci: boolean;
}

export class RegexError extends Error {
  override name = 'RegexError';
}

type RNode =
  | { t: 'cls'; ranges: number[]; neg: boolean }
  | { t: 'any' }
  | { t: 'bol' }
  | { t: 'eol' }
  | { t: 'cat'; items: RNode[] }
  | { t: 'alt'; items: RNode[] }
  | { t: 'rep'; sub: RNode; min: number; max: number }; // max -1 = unbounded

const MAX_REPEAT = 1000;
const MAX_INSTS = 4000;

const DIGIT = [0x30, 0x39];
const WORD = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];
const SPACE = [0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x20];

function negateRanges(r: number[]): number[] {
  const sorted: [number, number][] = [];
  for (let i = 0; i < r.length; i += 2) sorted.push([r[i]!, r[i + 1]!]);
  sorted.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  let next = 0;
  for (const [lo, hi] of sorted) {
    if (lo > next) out.push(next, lo - 1);
    next = Math.max(next, hi + 1);
  }
  if (next <= 0x10ffff) out.push(next, 0x10ffff);
  return out;
}

class RParser {
  private i = 0;
  private cps: number[];
  ci = false;
  constructor(src: string) {
    this.cps = Array.from(src, (c) => c.codePointAt(0)!);
    if (src.startsWith('(?i)')) {
      this.ci = true;
      this.i = 4;
    }
  }
  private peek(): number | undefined {
    return this.cps[this.i];
  }
  private ch(): string {
    const c = this.peek();
    return c === undefined ? '' : String.fromCodePoint(c);
  }

  parse(): RNode {
    const n = this.alt();
    if (this.i < this.cps.length) throw new RegexError(`unexpected '${this.ch()}' in pattern`);
    return n;
  }

  private alt(): RNode {
    const items = [this.cat()];
    while (this.ch() === '|') {
      this.i++;
      items.push(this.cat());
    }
    return items.length === 1 ? items[0]! : { t: 'alt', items };
  }

  private cat(): RNode {
    const items: RNode[] = [];
    while (this.i < this.cps.length && this.ch() !== '|' && this.ch() !== ')') items.push(this.repeat());
    return { t: 'cat', items };
  }

  private repeat(): RNode {
    const atom = this.atom();
    let n = atom;
    let quantified = false;
    for (;;) {
      const c = this.ch();
      let min: number;
      let max: number;
      if (c === '*') [min, max] = [0, -1];
      else if (c === '+') [min, max] = [1, -1];
      else if (c === '?') [min, max] = [0, 1];
      else if (c === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(String.fromCodePoint(...this.cps.slice(this.i, this.i + 16)));
        if (!m) return n; // RE2 treats an unparsable repetition as a literal '{'
        min = Number(m[1]);
        max = m[2] === undefined ? min : m[3] === '' ? -1 : Number(m[3]);
        if (min > MAX_REPEAT || max > MAX_REPEAT || (max !== -1 && max < min)) throw new RegexError('bad repetition count');
        this.i += m[0].length - 1;
      } else return n;
      if (quantified) throw new RegexError('bad repetition operator');
      if (atom.t === 'bol' || atom.t === 'eol') throw new RegexError('missing argument to repetition operator');
      this.i++;
      if (this.ch() === '?') this.i++; // lazy: same boolean result
      n = { t: 'rep', sub: n, min, max };
      quantified = true;
    }
  }

  private atom(): RNode {
    const c = this.ch();
    switch (c) {
      case '(': {
        this.i++;
        if (this.ch() === '?') {
          const rest = String.fromCodePoint(...this.cps.slice(this.i, this.i + 3));
          if (rest.startsWith('?:')) this.i += 2;
          else if (rest.startsWith('?P<')) {
            this.i += 3;
            while (this.i < this.cps.length && this.ch() !== '>') {
              if (!/[A-Za-z0-9_]/.test(this.ch())) throw new RegexError('invalid group name');
              this.i++;
            }
            if (this.ch() !== '>') throw new RegexError('invalid named group');
            this.i++;
          } else throw new RegexError('unsupported group syntax (lookaround and inline flags are not RE2)');
        }
        const n = this.alt();
        if (this.ch() !== ')') throw new RegexError('missing closing )');
        this.i++;
        return n;
      }
      case ')':
        throw new RegexError('unexpected )');
      case '[':
        return this.cls();
      case '.':
        this.i++;
        return { t: 'any' };
      case '^':
        this.i++;
        return { t: 'bol' };
      case '$':
        this.i++;
        return { t: 'eol' };
      case '*':
      case '+':
      case '?':
        throw new RegexError('missing argument to repetition operator');
      case '\\':
        return this.escape(false);
      default: {
        const cp = this.peek()!;
        this.i++;
        return { t: 'cls', ranges: [cp, cp], neg: false };
      }
    }
  }

  /** An escape at the cursor (on the backslash). In a class, anchors are not allowed. */
  private escape(inClass: boolean): RNode {
    this.i++;
    const c = this.ch();
    if (c === '') throw new RegexError('trailing backslash');
    this.i++;
    const lit = (cp: number): RNode => ({ t: 'cls', ranges: [cp, cp], neg: false });
    switch (c) {
      case 'd':
        return { t: 'cls', ranges: DIGIT, neg: false };
      case 'D':
        return { t: 'cls', ranges: DIGIT, neg: true };
      case 'w':
        return { t: 'cls', ranges: WORD, neg: false };
      case 'W':
        return { t: 'cls', ranges: WORD, neg: true };
      case 's':
        return { t: 'cls', ranges: SPACE, neg: false };
      case 'S':
        return { t: 'cls', ranges: SPACE, neg: true };
      case 'n':
        return lit(10);
      case 't':
        return lit(9);
      case 'r':
        return lit(13);
      case 'f':
        return lit(12);
      case 'v':
        return lit(11);
      case 'a':
        return lit(7);
      case 'A':
        if (inClass) break;
        return { t: 'bol' };
      case 'z':
        if (inClass) break;
        return { t: 'eol' };
      case 'x': {
        const rest = String.fromCodePoint(...this.cps.slice(this.i, this.i + 10));
        const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(rest) ?? /^([0-9a-fA-F]{2})/.exec(rest);
        if (!m) throw new RegexError('invalid \\x escape');
        this.i += m[0].length;
        const cp = parseInt(m[1]!, 16);
        if (cp > 0x10ffff) throw new RegexError('invalid \\x escape');
        return lit(cp);
      }
      default:
        if (/[^A-Za-z0-9]/.test(c)) return lit(c.codePointAt(0)!);
    }
    throw new RegexError(`unsupported escape \\${c}`);
  }

  private cls(): RNode {
    this.i++; // [
    let neg = false;
    if (this.ch() === '^') {
      neg = true;
      this.i++;
    }
    if (this.ch() === '[' && this.cps[this.i + 1] === 0x3a) throw new RegexError('POSIX classes are not supported');
    const ranges: number[] = [];
    let first = true;
    while (this.ch() !== ']' || first) {
      if (this.i >= this.cps.length) throw new RegexError('missing closing ]');
      first = false;
      let lo: number;
      if (this.ch() === '\\') {
        const e = this.escape(true);
        if (e.t !== 'cls') throw new RegexError('invalid escape in class');
        if (e.neg) {
          ranges.push(...negateRanges(e.ranges));
          continue;
        }
        if (e.ranges.length > 2) {
          ranges.push(...e.ranges);
          continue;
        }
        lo = e.ranges[0]!;
      } else {
        lo = this.peek()!;
        this.i++;
      }
      if (this.ch() === '-' && this.cps[this.i + 1] !== undefined && this.cps[this.i + 1] !== 0x5d) {
        this.i++;
        let hi: number;
        if (this.ch() === '\\') {
          const e = this.escape(true);
          if (e.t !== 'cls' || e.neg || e.ranges.length > 2) throw new RegexError('invalid class range');
          hi = e.ranges[0]!;
        } else {
          hi = this.peek()!;
          this.i++;
        }
        if (hi < lo) throw new RegexError('invalid class range');
        ranges.push(lo, hi);
      } else ranges.push(lo, lo);
    }
    this.i++; // ]
    return { t: 'cls', ranges, neg };
  }
}

function emit(n: RNode, next: number, insts: Inst[]): number {
  if (insts.length > MAX_INSTS) throw new RegexError('pattern is too large');
  const push = (i: Inst) => insts.push(i) - 1;
  switch (n.t) {
    case 'cls':
      return push({ op: 'char', ranges: n.ranges, neg: n.neg, out: next });
    case 'any':
      return push({ op: 'any', out: next });
    case 'bol':
      return push({ op: 'bol', out: next });
    case 'eol':
      return push({ op: 'eol', out: next });
    case 'cat': {
      let s = next;
      for (let i = n.items.length - 1; i >= 0; i--) s = emit(n.items[i]!, s, insts);
      return s;
    }
    case 'alt': {
      // Right fold into binary splits.
      let s = emit(n.items[n.items.length - 1]!, next, insts);
      for (let i = n.items.length - 2; i >= 0; i--) {
        const a = emit(n.items[i]!, next, insts);
        s = push({ op: 'split', x: a, y: s });
      }
      return s;
    }
    case 'rep': {
      let s = next;
      if (n.max === -1) {
        const loop = push({ op: 'split', x: -1, y: next });
        const body = emit(n.sub, loop, insts);
        (insts[loop] as { x: number }).x = body;
        s = loop;
      } else {
        // Optional copies: each either takes the body (then the next copy) or skips to `next`.
        for (let i = 0; i < n.max - n.min; i++) {
          const body = emit(n.sub, s, insts);
          s = push({ op: 'split', x: body, y: next });
        }
      }
      for (let i = 0; i < n.min; i++) s = emit(n.sub, s, insts);
      return s;
    }
  }
}

export function compileRegex(pattern: string): RegexProgram {
  const p = new RParser(pattern);
  const ast = p.parse();
  const insts: Inst[] = [{ op: 'match' }];
  const start = emit(ast, 0, insts);
  if (insts.length > MAX_INSTS) throw new RegexError('pattern is too large');
  return { insts, start, ci: p.ci };
}

function inRanges(cp: number, r: number[]): boolean {
  for (let i = 0; i < r.length; i += 2) if (cp >= r[i]! && cp <= r[i + 1]!) return true;
  return false;
}

function fold(cp: number): number[] {
  const s = String.fromCodePoint(cp);
  const l = s.toLowerCase();
  const u = s.toUpperCase();
  const out = [cp];
  if (l.length === s.length) out.push(l.codePointAt(0)!);
  if (u.length === s.length) out.push(u.codePointAt(0)!);
  return out;
}

/** RE2 partial-match semantics: true when the pattern matches any substring of `text`. */
export function runRegex(prog: RegexProgram, text: string): boolean {
  const cps = Array.from(text, (c) => c.codePointAt(0)!);
  const n = prog.insts.length;
  let clist: number[] = [];
  let nlist: number[] = [];
  const mark = new Int32Array(n).fill(-1);
  let gen = 0;
  let matched = false;

  const add = (list: number[], pc: number, pos: number) => {
    // Iterative epsilon closure.
    const stack = [pc];
    while (stack.length) {
      const s = stack.pop()!;
      if (mark[s] === gen) continue;
      mark[s] = gen;
      const ins = prog.insts[s]!;
      switch (ins.op) {
        case 'split':
          stack.push(ins.y, ins.x);
          break;
        case 'bol':
          if (pos === 0) stack.push(ins.out);
          break;
        case 'eol':
          if (pos === cps.length) stack.push(ins.out);
          break;
        case 'match':
          matched = true;
          break;
        default:
          list.push(s);
      }
    }
  };

  gen++;
  add(clist, prog.start, 0);
  for (let pos = 0; pos < cps.length && !matched; pos++) {
    const cp = cps[pos]!;
    const cands = prog.ci ? fold(cp) : [cp];
    gen++;
    nlist = [];
    for (const s of clist) {
      const ins = prog.insts[s]!;
      let ok = false;
      if (ins.op === 'any') ok = cp !== 10;
      else if (ins.op === 'char') {
        const hit = cands.some((c) => inRanges(c, ins.ranges));
        ok = ins.neg ? !hit : hit;
      }
      if (ok) add(nlist, (ins as { out: number }).out, pos + 1);
    }
    add(nlist, prog.start, pos + 1); // unanchored search: a new thread at every position
    clist = nlist;
  }
  return matched;
}
