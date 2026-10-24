// L3: the real CEL checker (§5, §6.3), built from @kairos/expr with the config's own context: closed history keys
// from the template keys and tags, custom booking fields, and each view's row entity.
import { compile, type CompileContext, type SlotName } from '@kairos/expr';
import type { ConfigDocument } from './schema';
import type { ExprChecker, ExprCheckResult, ExprContext, ExprSlot } from './validate/l3';

export function celChecker(doc: ConfigDocument): ExprChecker {
  const templates = doc.templates ?? [];
  const base: CompileContext = {
    historyKeys: {
      templates: templates.map((t) => t.key),
      tags: [...new Set(templates.flatMap((t) => t.tags ?? []))],
    },
    bookingFields: Object.fromEntries((doc.custom_fields ?? []).filter((f) => f.entity === 'booking').map((f) => [f.key, f.type])),
  };
  return {
    check(source: string, slot: ExprSlot, ctx: ExprContext): ExprCheckResult {
      const name: SlotName = slot === 'event' && ctx.result === 'value' ? 'event_value' : slot;
      const cctx: CompileContext = { ...base };
      if (slot === 'row') {
        const i = /^\/views\/(\d+)\//.exec(ctx.path)?.[1];
        const view = i === undefined ? undefined : doc.views?.[Number(i)];
        if (view) cctx.rowEntity = view.entity;
      }
      const r = compile(source, name, cctx);
      if (!r.ok) {
        const e = r.errors[0]!;
        return { ok: false, code: e.code, message: `${e.message} (line ${e.position.line}, col ${e.position.column})` };
      }
      const w = r.warnings[0];
      if (w) return { ok: false, code: w.code, severity: 'W', message: w.message };
      return { ok: true };
    },
  };
}
