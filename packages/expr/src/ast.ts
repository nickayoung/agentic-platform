// The checked AST. The checker fills `type` (and a few annotations); the interpreter walks it.

import type { Type } from './types';
import type { RegexProgram } from './regex';
import type { Duration, Timestamp } from './values';

export type BinOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in';
export type MacroName = 'all' | 'exists' | 'exists_one' | 'filter' | 'map';

interface Base {
  /** Source offset of the node's leading token (the operator token for operators). */
  pos: number;
  /** Static type, set by the checker. */
  type?: Type;
}

export type Node =
  | (Base & { k: 'lit'; v: bigint | number | string | boolean | null })
  | (Base & { k: 'ident'; name: string })
  /** `test` is the has() macro. `hasKey`: has() tests map-key presence rather than a non-null field. */
  | (Base & { k: 'select'; operand: Node; field: string; test: boolean; hasKey?: boolean })
  | (Base & { k: 'index'; operand: Node; index: Node })
  /** `konst`: a call folded at compile time (duration/timestamp of a literal). `regex`: matches' program. */
  | (Base & { k: 'call'; fn: string; target: Node | null; args: Node[]; regex?: RegexProgram; konst?: Timestamp | Duration })
  | (Base & { k: 'list'; elems: Node[] })
  | (Base & { k: 'map'; entries: { key: Node; value: Node }[] })
  | (Base & { k: 'unary'; op: '!' | '-'; operand: Node })
  | (Base & { k: 'binary'; op: BinOp; left: Node; right: Node })
  | (Base & { k: 'logic'; op: '&&' | '||'; args: Node[] })
  | (Base & { k: 'cond'; test: Node; then: Node; else: Node })
  | (Base & { k: 'comp'; macro: MacroName; range: Node; v: string; pred: Node | null; xform: Node | null });

export function children(n: Node): Node[] {
  switch (n.k) {
    case 'lit':
    case 'ident':
      return [];
    case 'select':
      return [n.operand];
    case 'index':
      return [n.operand, n.index];
    case 'call':
      return n.target ? [n.target, ...n.args] : n.args;
    case 'list':
      return n.elems;
    case 'map':
      return n.entries.flatMap((e) => [e.key, e.value]);
    case 'unary':
      return [n.operand];
    case 'binary':
      return [n.left, n.right];
    case 'logic':
      return n.args;
    case 'cond':
      return [n.test, n.then, n.else];
    case 'comp':
      return [n.range, ...(n.pred ? [n.pred] : []), ...(n.xform ? [n.xform] : [])];
  }
}

/** Node count and nesting depth (a chain of `&&` or `||` is one n-ary node, as if balanced). */
export function shape(root: Node): { nodes: number; depth: number } {
  let nodes = 0;
  const walk = (n: Node): number => {
    nodes++;
    let d = 0;
    for (const c of children(n)) d = Math.max(d, walk(c));
    return d + 1;
  };
  const depth = walk(root);
  return { nodes, depth };
}
