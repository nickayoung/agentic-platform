// Static types of the profile. `nullable` models the spec's `T|null`; `object` is a declared record (§5.3).

export type Type =
  | { readonly k: 'int' }
  | { readonly k: 'double' }
  | { readonly k: 'bool' }
  | { readonly k: 'null' }
  | { readonly k: 'timestamp' }
  | { readonly k: 'duration' }
  | { readonly k: 'dyn' }
  | { readonly k: 'string'; readonly enum?: readonly string[] }
  | { readonly k: 'list'; readonly elem: Type }
  | {
      readonly k: 'map';
      readonly key: Type;
      readonly value: Type;
      /** A zero-filled map whose keys are fixed by the compiled config (§5.3 "Map completeness"). */
      readonly closedKeys?: readonly string[];
    }
  | { readonly k: 'object'; readonly name: string; readonly fields: Readonly<Record<string, Type>> }
  | { readonly k: 'nullable'; readonly inner: Type };

export type Kind = Type['k'];

export const T = {
  int: { k: 'int' } as Type,
  double: { k: 'double' } as Type,
  bool: { k: 'bool' } as Type,
  null: { k: 'null' } as Type,
  timestamp: { k: 'timestamp' } as Type,
  duration: { k: 'duration' } as Type,
  dyn: { k: 'dyn' } as Type,
  string: { k: 'string' } as Type,
  enum: (...values: string[]): Type => ({ k: 'string', enum: values }),
  list: (elem: Type): Type => ({ k: 'list', elem }),
  map: (key: Type, value: Type, closedKeys?: readonly string[]): Type =>
    closedKeys ? { k: 'map', key, value, closedKeys } : { k: 'map', key, value },
  object: (name: string, fields: Record<string, Type>): Type => ({ k: 'object', name, fields }),
  nullable: (inner: Type): Type => (inner.k === 'nullable' || inner.k === 'null' || inner.k === 'dyn' ? inner : { k: 'nullable', inner }),
};

/** The non-null part of a type. */
export const strip = (t: Type): Type => (t.k === 'nullable' ? t.inner : t);
export const isNullable = (t: Type): boolean => t.k === 'nullable';
export const isNumeric = (t: Type): boolean => t.k === 'int' || t.k === 'double';

export function typeToString(t: Type): string {
  switch (t.k) {
    case 'string':
      return t.enum ? t.enum.map((v) => `'${v}'`).join('|') : 'string';
    case 'list':
      return `list<${typeToString(t.elem)}>`;
    case 'map':
      return `map<${typeToString(t.key)}, ${typeToString(t.value)}>`;
    case 'object':
      return t.name;
    case 'nullable':
      return `${typeToString(t.inner)}|null`;
    default:
      return t.k;
  }
}

/** Structural equality, ignoring enum value sets and closed key sets. */
export function sameType(a: Type, b: Type): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'list':
      return sameType(a.elem, (b as typeof a).elem);
    case 'map':
      return sameType(a.key, (b as typeof a).key) && sameType(a.value, (b as typeof a).value);
    case 'object':
      return a.name === (b as typeof a).name;
    case 'nullable':
      return sameType(a.inner, (b as typeof a).inner);
    default:
      return true;
  }
}

/**
 * Can a value of static type `arg` be passed where `param` is expected? `dyn` matches anything in
 * either direction; a nullable argument is accepted (a null at runtime is an error).
 */
export function assignable(arg: Type, param: Type): boolean {
  if (arg.k === 'dyn' || param.k === 'dyn') return true;
  if (arg.k === 'nullable') return assignable(arg.inner, param);
  if (param.k === 'nullable') return arg.k === 'null' || assignable(arg, param.inner);
  if (arg.k !== param.k) return false;
  switch (arg.k) {
    case 'list':
      return assignable(arg.elem, (param as typeof arg).elem);
    case 'map':
      return assignable(arg.key, (param as typeof arg).key) && assignable(arg.value, (param as typeof arg).value);
    case 'object':
      return arg.name === (param as typeof arg).name;
    default:
      return true;
  }
}

/**
 * The common type of two branches (ternary, list and map literals). `null` joins to a nullable type.
 * Returns null when the types cannot be joined.
 */
export function join(a: Type, b: Type): Type | null {
  if (a.k === 'dyn' || b.k === 'dyn') return T.dyn;
  if (a.k === 'null') return T.nullable(b);
  if (b.k === 'null') return T.nullable(a);
  const na = isNullable(a) || isNullable(b);
  const sa = strip(a);
  const sb = strip(b);
  let j: Type | null = null;
  if (sa.k === 'string' && sb.k === 'string') j = T.string;
  else if (sa.k === 'list' && sb.k === 'list') {
    const e = join(sa.elem, sb.elem);
    j = e ? T.list(e) : null;
  } else if (sa.k === 'map' && sb.k === 'map') {
    const k = join(sa.key, sb.key);
    const v = join(sa.value, sb.value);
    j = k && v ? T.map(k, v) : null;
  } else if (sameType(sa, sb)) j = sa;
  if (!j) return null;
  return na ? T.nullable(j) : j;
}

/** Comparable with `==` / `!=` (§5.3: comparing with null is allowed and false). */
export function equatable(a: Type, b: Type): boolean {
  if (a.k === 'dyn' || b.k === 'dyn' || a.k === 'null' || b.k === 'null') return true;
  const sa = strip(a);
  const sb = strip(b);
  if (isNumeric(sa) && isNumeric(sb)) return true;
  if (sa.k !== sb.k) return false;
  if (sa.k === 'list') return equatable(sa.elem, (sb as typeof sa).elem);
  if (sa.k === 'map') return equatable(sa.key, (sb as typeof sa).key) && equatable(sa.value, (sb as typeof sa).value);
  if (sa.k === 'object') return sa.name === (sb as typeof sa).name;
  return true;
}

/** Ordered with `<`, `<=`, `>`, `>=`. */
export function orderable(a: Type, b: Type): boolean {
  const sa = strip(a);
  const sb = strip(b);
  const ok = (t: Type) => ['int', 'double', 'string', 'bool', 'timestamp', 'duration', 'dyn'].includes(t.k);
  if (!ok(sa) || !ok(sb)) return false;
  if (sa.k === 'dyn' || sb.k === 'dyn') return true;
  if (isNumeric(sa) && isNumeric(sb)) return true;
  return sa.k === sb.k;
}
