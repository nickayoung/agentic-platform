// Recursive-descent parser for the profile's CEL grammar. Macros are expanded here; constructs outside
// the profile (message construction, leading-dot names, optional syntax, uint/bytes) are rejected.

import type { BinOp, MacroName, Node } from './ast';
import { CompileFail } from './errors';
import { lex, type Token } from './lexer';

const RESERVED = new Set([
  'as',
  'break',
  'const',
  'continue',
  'else',
  'for',
  'function',
  'if',
  'import',
  'let',
  'loop',
  'package',
  'namespace',
  'return',
  'var',
  'void',
  'while',
]);

const MACROS: Record<string, MacroName> = {
  all: 'all',
  exists: 'exists',
  exists_one: 'exists_one',
  filter: 'filter',
  map: 'map',
};

const INT_MAX = 2n ** 63n - 1n;
const INT_MIN = -(2n ** 63n);
/** Parser recursion guard; far above the AST depth limit, it only protects the stack. */
const MAX_RECURSION = 100;

export function parse(src: string): Node {
  return new Parser(src).parseAll();
}

class Parser {
  private toks: Token[];
  private i = 0;
  private depth = 0;

  constructor(src: string) {
    this.toks = lex(src);
  }

  parseAll(): Node {
    const e = this.expr();
    const t = this.peek();
    if (t.kind !== 'eof') throw this.err(`unexpected '${t.text || String(t.value)}'`, t.pos);
    return e;
  }

  private peek(o = 0): Token {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)]!;
  }
  private next(): Token {
    const t = this.peek();
    if (this.i < this.toks.length - 1) this.i++;
    return t;
  }
  private isOp(text: string, o = 0): boolean {
    const t = this.peek(o);
    return t.kind === 'op' && t.text === text;
  }
  private eat(text: string): Token {
    const t = this.peek();
    if (t.kind !== 'op' || t.text !== text) throw this.err(`expected '${text}'`, t.pos);
    return this.next();
  }
  private err(msg: string, pos: number, rule: 'syntax' | 'forbidden_construct' | 'reserved_word' = 'syntax') {
    return new CompileFail('EXPR_SYNTAX', rule, msg, pos);
  }

  private expr(): Node {
    if (++this.depth > MAX_RECURSION) throw new CompileFail('EXPR_COST', 'max_depth', 'expression is nested too deeply', this.peek().pos);
    try {
      const test = this.or();
      if (!this.isOp('?')) return test;
      const q = this.next();
      const then = this.or();
      this.eat(':');
      const els = this.expr();
      return { k: 'cond', pos: q.pos, test, then, else: els };
    } finally {
      this.depth--;
    }
  }

  private or(): Node {
    const first = this.and();
    if (!this.isOp('||')) return first;
    const pos = this.peek().pos;
    const args = [first];
    while (this.isOp('||')) {
      this.next();
      args.push(this.and());
    }
    return { k: 'logic', op: '||', pos, args };
  }

  private and(): Node {
    const first = this.relation();
    if (!this.isOp('&&')) return first;
    const pos = this.peek().pos;
    const args = [first];
    while (this.isOp('&&')) {
      this.next();
      args.push(this.relation());
    }
    return { k: 'logic', op: '&&', pos, args };
  }

  private relation(): Node {
    let left = this.addition();
    for (;;) {
      const t = this.peek();
      let op: BinOp | null = null;
      if (t.kind === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(t.text)) op = t.text as BinOp;
      else if (t.kind === 'ident' && t.text === 'in') op = 'in';
      if (!op) return left;
      this.next();
      const right = this.addition();
      left = { k: 'binary', op, pos: t.pos, left, right };
    }
  }

  private addition(): Node {
    let left = this.multiplication();
    while (this.isOp('+') || this.isOp('-')) {
      const t = this.next();
      left = { k: 'binary', op: t.text as BinOp, pos: t.pos, left, right: this.multiplication() };
    }
    return left;
  }

  private multiplication(): Node {
    let left = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const t = this.next();
      left = { k: 'binary', op: t.text as BinOp, pos: t.pos, left, right: this.unary() };
    }
    return left;
  }

  private unary(): Node {
    if (this.isOp('!') || this.isOp('-')) {
      const ops: Token[] = [];
      const op = this.peek().text;
      while (this.isOp(op)) ops.push(this.next());
      const numberNext = this.peek().kind === 'int' || this.peek().kind === 'double';
      let operand = this.member();
      let n = ops.length;
      // Fold one '-' into a directly following numeric literal, so -9223372036854775808 is a valid int.
      if (op === '-' && numberNext && operand.k === 'lit' && (typeof operand.v === 'bigint' || typeof operand.v === 'number')) {
        operand = { ...operand, pos: ops[n - 1]!.pos, v: -operand.v };
        n--;
      }
      checkIntLiteral(operand);
      for (let j = n - 1; j >= 0; j--) operand = { k: 'unary', op: op as '!' | '-', pos: ops[j]!.pos, operand };
      return operand;
    }
    const m = this.member();
    checkIntLiteral(m);
    return m;
  }

  private member(): Node {
    let n = this.primary();
    for (;;) {
      if (this.isOp('.')) {
        const dot = this.next();
        if (this.isOp('?')) throw this.err('optional field selection is not in the profile', dot.pos, 'forbidden_construct');
        const id = this.next();
        if (id.kind !== 'ident') throw this.err('expected a field name after "."', id.pos);
        if (this.isOp('(')) {
          this.next();
          const args = this.args(')');
          n = this.memberCall(n, id, args);
        } else n = { k: 'select', pos: dot.pos, operand: n, field: id.text, test: false };
      } else if (this.isOp('[')) {
        const b = this.next();
        if (this.isOp('?')) throw this.err('optional indexing is not in the profile', b.pos, 'forbidden_construct');
        const index = this.expr();
        this.eat(']');
        n = { k: 'index', pos: b.pos, operand: n, index };
      } else if (this.isOp('{') && (n.k === 'ident' || n.k === 'select')) {
        throw this.err('message construction (protobuf types) is not in the profile', this.peek().pos, 'forbidden_construct');
      } else return n;
    }
  }

  private memberCall(target: Node, id: Token, args: Node[]): Node {
    const macro = MACROS[id.text];
    if (!macro) return { k: 'call', pos: id.pos, fn: id.text, target, args };
    const arity = macro === 'map' ? [2, 3] : [2];
    if (!arity.includes(args.length)) throw this.err(`${id.text}() takes ${arity.join(' or ')} arguments`, id.pos);
    const v = args[0]!;
    if (v.k !== 'ident') throw this.err(`the first argument of ${id.text}() must be a variable name`, v.pos);
    if (macro === 'map') {
      const pred = args.length === 3 ? args[1]! : null;
      return { k: 'comp', pos: id.pos, macro, range: target, v: v.name, pred, xform: args[args.length - 1]! };
    }
    return { k: 'comp', pos: id.pos, macro, range: target, v: v.name, pred: args[1]!, xform: null };
  }

  private args(close: string): Node[] {
    const out: Node[] = [];
    if (this.isOp(close)) {
      this.next();
      return out;
    }
    for (;;) {
      out.push(this.expr());
      if (this.isOp(',')) {
        this.next();
        if (this.isOp(close) && close !== ')') break; // trailing comma in list literals
        continue;
      }
      break;
    }
    this.eat(close);
    return out;
  }

  private primary(): Node {
    const t = this.next();
    switch (t.kind) {
      case 'int':
        return { k: 'lit', pos: t.pos, v: t.value as bigint };
      case 'double':
        return { k: 'lit', pos: t.pos, v: t.value as number };
      case 'string':
        return { k: 'lit', pos: t.pos, v: t.value as string };
      case 'ident': {
        if (t.text === 'true' || t.text === 'false') return { k: 'lit', pos: t.pos, v: t.text === 'true' };
        if (t.text === 'null') return { k: 'lit', pos: t.pos, v: null };
        if (t.text === 'in') throw this.err("unexpected 'in'", t.pos);
        if (RESERVED.has(t.text)) throw this.err(`'${t.text}' is a reserved word`, t.pos, 'reserved_word');
        if (this.isOp('(')) {
          this.next();
          const args = this.args(')');
          if (t.text === 'has') {
            if (args.length !== 1) throw this.err('has() takes one argument', t.pos);
            const a = args[0]!;
            if (a.k !== 'select') throw this.err('has() needs a field selection, like has(a.b)', a.pos);
            return { ...a, pos: t.pos, test: true };
          }
          if (MACROS[t.text]) throw this.err(`${t.text}() is a macro; call it on a list, like list.${t.text}(x, ...)`, t.pos);
          return { k: 'call', pos: t.pos, fn: t.text, target: null, args };
        }
        return { k: 'ident', pos: t.pos, name: t.text };
      }
      case 'op':
        if (t.text === '(') {
          const e = this.expr();
          this.eat(')');
          return e;
        }
        if (t.text === '[') return { k: 'list', pos: t.pos, elems: this.args(']') };
        if (t.text === '{') return { k: 'map', pos: t.pos, entries: this.mapEntries() };
        if (t.text === '.') throw this.err('leading-dot (root namespace) names are not in the profile', t.pos, 'forbidden_construct');
        throw this.err(`unexpected '${t.text}'`, t.pos);
      case 'eof':
        throw this.err('unexpected end of expression', t.pos);
    }
  }

  private mapEntries(): { key: Node; value: Node }[] {
    const out: { key: Node; value: Node }[] = [];
    while (!this.isOp('}')) {
      if (this.isOp('?')) throw this.err('optional map entries are not in the profile', this.peek().pos, 'forbidden_construct');
      const key = this.expr();
      this.eat(':');
      const value = this.expr();
      out.push({ key, value });
      if (!this.isOp(',')) break;
      this.next();
    }
    this.eat('}');
    return out;
  }
}

function checkIntLiteral(n: Node): void {
  if (n.k === 'lit' && typeof n.v === 'bigint' && (n.v > INT_MAX || n.v < INT_MIN))
    throw new CompileFail('EXPR_SYNTAX', 'int_literal_range', 'int literal out of 64-bit range', n.pos);
}
