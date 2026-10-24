// Sandbox limits (§5.5). Decisions depend only on these deterministic limits, never on wall time.

export const LIMITS = {
  /** Source length, in characters (UTF-16 code units). Compile. */
  sourceLength: 2000,
  /** AST nodes. Compile. */
  astNodes: 300,
  /** AST nesting depth. Compile. */
  astDepth: 12,
  /** Static cost estimate. Compile. */
  staticCost: 5000,
  /** Runtime step budget. Evaluate (EXPR_BUDGET). */
  runtimeSteps: 10_000,
  /** Elements a comprehension may range over. Evaluate. */
  comprehensionInput: 256,
  /** Bytes (UTF-8) in a produced string. Evaluate. */
  producedStringBytes: 1024,
  /** Elements in a produced list. Evaluate. */
  producedListElements: 256,
  /** Expressions per config. Compile (config level). */
  expressionsPerConfig: 2000,
  /** Wall-clock guard, metrics only. Evaluate. */
  wallClockMs: 2,
  /** `matches` pattern length (§5.2). Compile. */
  regexPatternLength: 128,
} as const;

/** Extra steps charged for an O(n) operation on a string of `n` code units. */
export const stringCharge = (n: number): number => Math.ceil(n / 256);
/** Extra steps charged for an O(n) operation on a list or map of `n` elements. */
export const listCharge = (n: number): number => Math.ceil(n / 64);
/** Extra steps charged for running a regex program of `prog` instructions over `n` code points. */
export const regexCharge = (n: number, prog: number): number => Math.ceil(((n + 1) * prog) / 4096);

/**
 * The per-config limit is enforced by the config compiler, which counts expressions;
 * this helper gives it the same message shape.
 */
export function checkExpressionCount(count: number): { code: 'EXPR_COST'; message: string } | null {
  return count > LIMITS.expressionsPerConfig
    ? { code: 'EXPR_COST', message: `config has ${count} expressions; the limit is ${LIMITS.expressionsPerConfig}` }
    : null;
}
