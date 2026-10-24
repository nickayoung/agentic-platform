// The validator (§6.3), layers L1–L4. L5 (solver probe) and L6 (impact plan) live elsewhere.
import type { ConfigDocument } from '../schema';
import { withDefaults } from '../upgrade';
import { Issues, report, type ValidationReport } from '../report';
import { checkDurationGrain, checkLockedPaths, parseSchema } from './l1';
import { checkReferences } from './l2';
import { checkExpressions, type ExprChecker } from './l3';
import { checkSemantics, type L4Options } from './l4';
import { buildModel } from './model';

export interface ValidateOptions extends L4Options {
  /** L3 checker from `packages/expr`. Without it, L3 is skipped. */
  expr?: ExprChecker;
  /** The published document. When given, LOCKED_PATH is checked; leave it out for an owner's draft (§4.1.1). */
  base?: ConfigDocument;
  /** Layers to run (default all four). L1 always runs: later layers need a schema-valid document. */
  layers?: readonly ('L2' | 'L3' | 'L4')[];
}

/**
 * Validates a document (any parsed JSON/YAML value). If the schema check fails, only L1 issues are returned. The later
 * layers run on the upgraded, defaulted document; paths are unchanged by that, so they point into the input.
 */
export function validate(input: unknown, opts: ValidateOptions = {}): ValidationReport {
  const parsed = parseSchema(input);
  if (!parsed.ok) return report(parsed.issues);
  const l1 = new Issues('L1');
  checkDurationGrain(parsed.doc, l1);
  if (opts.base !== undefined) checkLockedPaths(parsed.doc, opts.base, l1);

  const doc = withDefaults(parsed.doc);
  const m = buildModel(doc);
  const layers = new Set(opts.layers ?? ['L2', 'L3', 'L4']);
  const l2 = new Issues('L2');
  const l3 = new Issues('L3');
  const l4 = new Issues('L4');
  if (layers.has('L2')) checkReferences(doc, opts, l2, m);
  if (layers.has('L3') && opts.expr !== undefined) checkExpressions(doc, opts.expr, l3);
  if (layers.has('L4')) checkSemantics(doc, opts, l4, m);
  return report([...l1.list, ...l2.list, ...l3.list, ...l4.list]);
}
