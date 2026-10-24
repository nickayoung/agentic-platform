// RFC 6902 JSON Patch, for config drafts (§6.1: a draft is a base version plus JSON Patch operations).
// Pure and synchronous; returns a new document and never mutates its input.

export type JsonPatchOp =
  | { op: 'add' | 'replace' | 'test'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'move' | 'copy'; from: string; path: string };

export class PatchError extends Error {
  override name = 'PatchError';
  constructor(message: string, readonly index: number) {
    super(message);
  }
}

const unescape = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');

function tokens(pointer: string, i: number): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new PatchError(`invalid pointer ${pointer}`, i);
  return pointer.slice(1).split('/').map(unescape);
}

type Container = Record<string, unknown> | unknown[];

function parentOf(doc: unknown, toks: string[], i: number): { parent: Container; key: string } {
  let node = doc;
  for (const t of toks.slice(0, -1)) {
    if (Array.isArray(node)) node = node[index(node, t, i, false)];
    else if (node && typeof node === 'object' && Object.hasOwn(node, t)) node = (node as Record<string, unknown>)[t];
    else throw new PatchError(`path not found at ${t}`, i);
  }
  if (!node || typeof node !== 'object') throw new PatchError('parent is not a container', i);
  return { parent: node as Container, key: toks[toks.length - 1]! };
}

function index(arr: unknown[], t: string, i: number, allowEnd: boolean): number {
  if (allowEnd && t === '-') return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(t)) throw new PatchError(`bad array index ${t}`, i);
  const n = Number(t);
  if (n > arr.length || (!allowEnd && n === arr.length)) throw new PatchError(`array index ${t} out of range`, i);
  return n;
}

function get(doc: unknown, pointer: string, i: number): unknown {
  const toks = tokens(pointer, i);
  if (toks.length === 0) return doc;
  const { parent, key } = parentOf(doc, toks, i);
  if (Array.isArray(parent)) return parent[index(parent, key, i, false)];
  if (!Object.hasOwn(parent, key)) throw new PatchError(`path not found ${pointer}`, i);
  return parent[key];
}

function add(doc: unknown, pointer: string, value: unknown, i: number): unknown {
  const toks = tokens(pointer, i);
  if (toks.length === 0) return value;
  const { parent, key } = parentOf(doc, toks, i);
  if (Array.isArray(parent)) parent.splice(index(parent, key, i, true), 0, value);
  else parent[key] = value;
  return doc;
}

function remove(doc: unknown, pointer: string, i: number): unknown {
  const toks = tokens(pointer, i);
  if (toks.length === 0) throw new PatchError('cannot remove the root', i);
  const { parent, key } = parentOf(doc, toks, i);
  if (Array.isArray(parent)) parent.splice(index(parent, key, i, false), 1);
  else if (Object.hasOwn(parent, key)) delete parent[key];
  else throw new PatchError(`path not found ${pointer}`, i);
  return doc;
}

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

export function applyJsonPatch<T>(document: T, ops: readonly JsonPatchOp[]): T {
  let doc: unknown = structuredClone(document);
  ops.forEach((o, i) => {
    switch (o.op) {
      case 'add': doc = add(doc, o.path, structuredClone(o.value), i); break;
      case 'remove': doc = remove(doc, o.path, i); break;
      case 'replace': get(doc, o.path, i); doc = add(remove(doc, o.path, i), o.path, structuredClone(o.value), i); break;
      case 'move': {
        if (o.path.startsWith(`${o.from}/`)) throw new PatchError('cannot move a value into itself', i);
        const v = get(doc, o.from, i);
        doc = add(remove(doc, o.from, i), o.path, v, i);
        break;
      }
      case 'copy': doc = add(doc, o.path, structuredClone(get(doc, o.from, i)), i); break;
      case 'test': if (!equal(get(doc, o.path, i), o.value)) throw new PatchError(`test failed at ${o.path}`, i); break;
      default: throw new PatchError(`unknown op ${(o as { op: string }).op}`, i);
    }
  });
  return doc as T;
}
