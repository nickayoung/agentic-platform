// L3: expressions (§6.3, §5). The CEL checker lives in `packages/expr`; this package only finds every CEL-valued field,
// names its slot (§5.3), and reports what the injected checker says.
import type { ConfigDocument } from '../schema';
import { Issues, pointer } from '../report';

export type ExprSlot = 'booking' | 'candidate' | 'event' | 'row';
export type ExprCode = 'EXPR_SYNTAX' | 'EXPR_TYPE' | 'EXPR_UNKNOWN_VAR' | 'EXPR_COST' | 'UNKNOWN_HISTORY_KEY' | 'EXPR_NULLABLE';

export interface ExprContext {
  path: string;                                       // JSON Pointer of the field
  result: 'bool' | 'value';                           // action input/vars/data/value are values; everything else is bool
}
export type ExprCheckResult =
  | { ok: true }
  | { ok: false; message: string; code?: ExprCode; severity?: 'E' | 'W' };   // default code EXPR_TYPE (E); EXPR_NULLABLE is W

export interface ExprChecker {
  check(source: string, slot: ExprSlot, ctx: ExprContext): ExprCheckResult;
}

export interface ExprField { path: PropertyKey[]; source: string; slot: ExprSlot; result: 'bool' | 'value' }

/** Every CEL-valued field in the document with its slot (§5.3 table). */
export function exprFields(doc: ConfigDocument): ExprField[] {
  const out: ExprField[] = [];
  const add = (source: string | undefined, slot: ExprSlot, path: PropertyKey[], result: 'bool' | 'value' = 'bool'): void => {
    if (source !== undefined) out.push({ path, source, slot, result });
  };
  const values = (rec: Record<string, string> | undefined, path: PropertyKey[]): void => {
    for (const [k, v] of Object.entries(rec ?? {})) add(v, 'event', [...path, k], 'value');
  };

  doc.templates.forEach((t, i) => {
    const at = (...p: PropertyKey[]): PropertyKey[] => ['templates', i, ...p];
    add(t.eligible_if, 'booking', at('eligible_if'));
    add(t.intake?.when, 'booking', at('intake', 'when'));
    t.cost?.price_rules?.forEach((r, j) => add(r.when, 'booking', at('cost', 'price_rules', j, 'when')));
    if (t.participants.who === 'customers' && t.participants.capacity.mode === 'mixed') {
      t.participants.capacity.partitions.forEach((p, j) =>
        add(p.eligible_if, 'booking', at('participants', 'capacity', 'partitions', j, 'eligible_if')));
    }
    t.requirements.forEach((q, j) => add(q.select.where, 'candidate', at('requirements', j, 'select', 'where')));
  });
  doc.policies.forEach((p, i) => {
    const at = (...x: PropertyKey[]): PropertyKey[] => ['policies', i, ...x];
    add(p.eligible_if, 'booking', at('eligible_if'));
    for (const which of ['late', 'no_show'] as const) {
      add(p.cancellation[which].fee_if, 'booking', at('cancellation', which, 'fee_if'));
      add(p.cancellation[which].waive_if, 'booking', at('cancellation', which, 'waive_if'));
    }
    p.limits.forEach((l, j) => {
      add(l.count_if, 'booking', at('limits', j, 'count_if'));
      add(l.applies_if, 'booking', at('limits', j, 'applies_if'));
    });
    add(p.approval?.required_if, 'booking', at('approval', 'required_if'));
  });
  doc.entitlement_products.forEach((e, i) => {
    add(e.covers, 'booking', ['entitlement_products', i, 'covers']);
    e.caps?.forEach((c, j) => add(c.count_if, 'booking', ['entitlement_products', i, 'caps', j, 'count_if']));
  });
  doc.custom_fields.forEach((f, i) => add(f.required_if, 'booking', ['custom_fields', i, 'required_if']));
  doc.constraints.forEach((c, i) => {
    add(c.applies_to.people_where, 'candidate', ['constraints', i, 'applies_to', 'people_where']);
    if (c.rule.type === 'assignment_expr') add(c.rule.must, 'candidate', ['constraints', i, 'rule', 'must']);
  });
  doc.workflows.forEach((w, i) => {
    const at = (...p: PropertyKey[]): PropertyKey[] => ['workflows', i, ...p];
    if ('event' in w.trigger) add(w.trigger.where, 'event', at('trigger', 'where'));
    add(w.condition, 'event', at('condition'));
    w.actions.forEach((a, j) => {
      add(a.when, 'event', at('actions', j, 'when'));
      if (a.type === 'notify') values(a.vars, at('actions', j, 'vars'));
      if (a.type === 'invoke_hook') values(a.input, at('actions', j, 'input'));
      if (a.type === 'emit_event') values(a.data, at('actions', j, 'data'));
      if (a.type === 'set_field') add(a.value, 'event', at('actions', j, 'value'), 'value');
    });
  });
  doc.views.forEach((v, i) => add(v.filter, 'row', ['views', i, 'filter']));
  return out;
}

export function checkExpressions(doc: ConfigDocument, checker: ExprChecker, out: Issues): void {
  for (const f of exprFields(doc)) {
    const r = checker.check(f.source, f.slot, { path: pointer(f.path), result: f.result });
    if (r.ok) continue;
    const code = r.code ?? 'EXPR_TYPE';
    out.add(code, r.severity ?? (code === 'EXPR_NULLABLE' ? 'W' : 'E'), f.path, r.message);
  }
}
