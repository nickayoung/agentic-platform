import { compile, evaluate, T, type Activation, type CompileContext, type EvaluateOptions, type SlotDef, type SlotName } from '../src/index';

/** A value-producing slot with one variable of each shape, for conformance cases. */
export const TEST_SLOT: SlotDef = {
  name: 'event_value',
  usedBy: [],
  result: T.dyn,
  variables: {
    now: T.timestamp,
    i: T.int,
    f: T.double,
    s: T.string,
    b: T.bool,
    x: T.dyn,
    n: T.nullable(T.int),
    t: T.timestamp,
    xs: T.list(T.int),
    ds: T.list(T.double),
    ss: T.list(T.string),
    m: T.map(T.string, T.int),
    d: T.map(T.string, T.dyn),
    obj: T.object('Obj', {
      a: T.int,
      s: T.nullable(T.string),
      inner: T.nullable(T.object('Inner', { b: T.int })),
      tags: T.list(T.string),
    }),
  },
};

export type Outcome =
  | { value: unknown }
  | { error: string; rule?: string }
  | { compile: string; rule?: string }
  | { warning: string };

/** Compiles and evaluates; returns a comparable outcome. */
export function run(
  src: string,
  act: Activation = {},
  slot: SlotName | SlotDef = TEST_SLOT,
  ctx?: CompileContext,
  opts?: EvaluateOptions,
): Outcome & { steps?: number; cost?: number } {
  const c = compile(src, slot, ctx);
  if (!c.ok) return { compile: c.errors[0]!.code, rule: c.errors[0]!.rule };
  const r = evaluate(c.expr, act, opts);
  if (!r.ok) return { error: r.error.code, rule: r.error.rule, steps: r.steps, cost: c.expr.cost };
  return { value: r.value, steps: r.steps, cost: c.expr.cost };
}
