// @kairos/expr: the restricted CEL profile (§5). compile() parses and checks against a slot;
// evaluate() interprets the checked AST with the §5.5 limits. Nothing here generates code (§19.12).

import { shape, type Node } from './ast';
import { check, estimateCost, isBoolish } from './checker';
import {
  CompileFail,
  EvalFail,
  positionAt,
  type CompileError,
  type CompileWarning,
  type RuntimeError,
} from './errors';
import { Interpreter, type Activation } from './interpreter';
import { LIMITS } from './limits';
import { parse } from './parser';
import { slotDef, type CompileContext, type SlotDef, type SlotName } from './slots';
import { strip, typeToString, type Type } from './types';
import { kindOf } from './values';

export interface CompiledExpr {
  readonly source: string;
  readonly slot: SlotName;
  /** The checked AST; every node carries its static type. Treat as immutable. */
  readonly ast: Node;
  readonly type: Type;
  /** Static cost estimate, in runtime steps (an upper bound for inputs within the §5.5 sizes). */
  readonly cost: number;
  readonly nodes: number;
  readonly depth: number;
  readonly warnings: readonly CompileWarning[];
}

export type CompileResult =
  | { ok: true; expr: CompiledExpr; warnings: readonly CompileWarning[] }
  | { ok: false; errors: readonly CompileError[]; warnings: readonly CompileWarning[] };

export type EvalResult =
  | { ok: true; value: unknown; steps: number }
  | { ok: false; error: RuntimeError; steps: number };

export interface EvaluateOptions {
  /** Step budget; defaults to §5.5's 10,000. */
  budget?: number;
  /** Monotonic clock in ms for the wall-clock guard (metrics only; decisions never depend on it). */
  clock?: () => number;
  /** Called when an evaluation took longer than §5.5's 2 ms guard. */
  onSlow?: (ms: number, expr: CompiledExpr) => void;
}

const compiledBrand = new WeakSet<object>();

/** Parses and checks `source` for `slot`. Errors carry a code (§6.3 L3), a rule and a position. */
export function compile(source: string, slot: SlotName | SlotDef, ctx: CompileContext = {}): CompileResult {
  const def = typeof slot === 'string' ? slotDef(slot, ctx) : slot;
  const err = (e: Omit<CompileError, 'position'>, offset: number): CompileResult => ({
    ok: false,
    errors: [{ ...e, position: positionAt(source, offset) }],
    warnings: [],
  });
  if (source.length > LIMITS.sourceLength)
    return err(
      { code: 'EXPR_COST', rule: 'source_length', message: `expression is ${source.length} characters; the limit is ${LIMITS.sourceLength}` },
      LIMITS.sourceLength,
    );
  let ast: Node;
  try {
    ast = parse(source);
  } catch (e) {
    if (e instanceof CompileFail) return err({ code: e.code, rule: e.rule, message: e.message }, e.offset);
    throw e;
  }
  const { nodes, depth } = shape(ast);
  if (nodes > LIMITS.astNodes)
    return err({ code: 'EXPR_COST', rule: 'max_nodes', message: `expression has ${nodes} AST nodes; the limit is ${LIMITS.astNodes}` }, ast.pos);
  if (depth > LIMITS.astDepth)
    return err({ code: 'EXPR_COST', rule: 'max_depth', message: `expression nests ${depth} deep; the limit is ${LIMITS.astDepth}` }, ast.pos);

  const checked = check(ast, source, def);
  const errors = [...checked.errors];
  if (errors.length === 0 && def.result.k === 'bool' && !isBoolish(checked.type))
    errors.push({
      code: 'EXPR_TYPE',
      rule: 'result_type',
      message: `slot '${def.name}' needs a bool, but the expression is ${typeToString(checked.type)}`,
      position: positionAt(source, ast.pos),
    });
  const cost = estimateCost(ast);
  if (errors.length === 0 && cost > LIMITS.staticCost)
    errors.push({
      code: 'EXPR_COST',
      rule: 'static_cost',
      message: `estimated cost ${cost} exceeds ${LIMITS.staticCost}`,
      position: positionAt(source, ast.pos),
    });
  if (errors.length) return { ok: false, errors, warnings: checked.warnings };
  const expr: CompiledExpr = Object.freeze({
    source,
    slot: def.name,
    ast,
    type: checked.type,
    cost,
    nodes,
    depth,
    warnings: Object.freeze(checked.warnings),
  });
  compiledBrand.add(expr);
  return { ok: true, expr, warnings: checked.warnings };
}

/** Evaluates a compiled expression. Never throws for expression errors: it returns EXPR_ERROR / EXPR_BUDGET. */
export function evaluate(expr: CompiledExpr, activation: Activation, opts: EvaluateOptions = {}): EvalResult {
  if (!compiledBrand.has(expr)) throw new TypeError('evaluate() needs an expression returned by compile()');
  const it = new Interpreter(activation, opts.budget ?? LIMITS.runtimeSteps);
  const t0 = opts.clock?.();
  const done = (r: EvalResult): EvalResult => {
    if (t0 !== undefined && opts.clock) {
      const ms = opts.clock() - t0;
      if (ms > LIMITS.wallClockMs) opts.onSlow?.(ms, expr);
    }
    return r;
  };
  try {
    const value = it.run(expr.ast);
    if (expr.slot !== 'event_value' && typeof value !== 'boolean')
      return done({
        ok: false,
        error: {
          code: 'EXPR_ERROR',
          rule: 'result_type',
          message: `slot '${expr.slot}' needs a bool, got ${value === null ? 'null' : kindOf(value)}`,
          position: positionAt(expr.source, expr.ast.pos),
        },
        steps: it.steps,
      });
    return done({ ok: true, value, steps: it.steps });
  } catch (e) {
    if (!(e instanceof EvalFail)) throw e;
    return done({
      ok: false,
      error: { code: e.code, rule: e.rule, message: e.message, position: positionAt(expr.source, Math.max(0, e.offset)) },
      steps: it.steps,
    });
  }
}

/** The static result type a compiled expression produces, e.g. "bool". */
export const resultType = (expr: CompiledExpr): string => typeToString(strip(expr.type));

export type { Activation } from './interpreter';
export type { Node, BinOp, MacroName } from './ast';
export type {
  CompileError,
  CompileErrorCode,
  CompileRule,
  CompileWarning,
  Position,
  RuntimeError,
  RuntimeErrorCode,
  RuntimeRule,
  WarningCode,
} from './errors';
export { LIMITS, checkExpressionCount } from './limits';
export {
  SLOTS,
  SLOT_NAMES,
  slotDef,
  CountsType,
  ResourceType,
  SessionType,
  TemplateType,
  type CompileContext,
  type CustomFieldType,
  type EventSubject,
  type SlotDef,
  type SlotName,
  type ViewEntity,
} from './slots';
export { T, typeToString, type Type } from './types';
export { Duration, Timestamp, toJson } from './values';
