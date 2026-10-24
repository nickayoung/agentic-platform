// The manual config pipeline (§6, §15 Phase 0): draft → validate (L1–L4) → impact → submit → approve and publish,
// with rollback. Validation and compilation are pure and run outside transactions; each state change is one batch.
// Impact (L6) is a placeholder until sessions are materialised (Phase 1+): it reports no impact groups.
import {
  applyJsonPatch, celChecker, compile, PatchError, parseConfigYaml, validate,
  type ConfigDocument, type Domain, type DomainMode as ConfigDomainMode, type JsonPatchOp, type ValidationReport,
} from '@kairos/config-schema';
import { canonicalJson, type Tx } from '@kairos/db';
import { KairosError } from '@kairos/errors';
import type { TickSource } from '@kairos/scheduler';
import { materializeStructural } from './resources';
import type { Db } from '@kairos/db';

export type DraftState = 'editing' | 'validated' | 'awaiting_approval' | 'published' | 'abandoned';

/**
 * A JSON value crossing RPC. `unknown` types as `never` on the stub, and a recursive JSON type is too deep for the
 * RPC type mapping, so payloads whose shape Zod checks elsewhere are typed shallowly here.
 */
export type Json = string | number | boolean | null | object;
export type JsonObject = Record<string, Json>;

export interface Draft {
  id: string;
  base_number: number | null;
  state: DraftState;
  version: number;
  /** A ConfigDocument (§4); typed as JSON for RPC. */
  document: JsonObject;
  validation: { ok: boolean; issues: { layer: string; code: string; severity: string; path: string; message: string }[] } | null;
  impact: { groups: Json[] } | null;
  author: Json;
}

export interface ConfigVersionSummary {
  number: number;
  content_hash: string;
  state: 'staged' | 'active' | 'superseded';
  effective_from: number;
  published_at: number;
  summary: string;
  rollback_of: number | null;
  parent_number: number | null;
}

interface DraftRow {
  id: string; base_number: number | null; state: DraftState; version: number; document: string; validation: string | null;
  impact: string | null; author: string; [k: string]: SqlStorageValue;
}

export const toDraft = (r: DraftRow): Draft => ({
  id: r.id, base_number: r.base_number, state: r.state, version: r.version, document: JSON.parse(r.document) as JsonObject,
  validation: r.validation ? (JSON.parse(r.validation) as Draft['validation']) : null,
  impact: r.impact ? (JSON.parse(r.impact) as Draft['impact']) : null, author: JSON.parse(r.author) as Json,
});

export function loadDraft(tx: Tx, id: string): DraftRow {
  const r = tx.maybe<DraftRow>('SELECT * FROM config_draft WHERE id = ?', id);
  if (!r) throw new KairosError('NOT_FOUND', { message: `draft ${id}` });
  return r;
}

export function activeVersion(tx: Tx): { number: number; document: ConfigDocument } | undefined {
  const r = tx.maybe<{ number: number; document: string }>(`SELECT number, document FROM config_version WHERE state = 'active'`);
  return r && { number: r.number, document: JSON.parse(r.document) as ConfigDocument };
}

/** Parses YAML or accepts a JSON object; schema errors become SCHEMA_INVALID with the issues attached. */
export function readDocument(input: { yaml: string } | { document: unknown }): ConfigDocument {
  if ('yaml' in input) {
    const r = parseConfigYaml(input.yaml);
    if (!r.ok) throw new KairosError('SCHEMA_INVALID', { message: 'config does not parse', reasons: r.issues.map((i) => ({ code: 'SCHEMA_INVALID' as const, message: i.message, config_path: i.path })) });
    return r.document;
  }
  return input.document as ConfigDocument;
}

export function patchDocument(doc: ConfigDocument, ops: readonly JsonPatchOp[]): ConfigDocument {
  try {
    return applyJsonPatch(doc, ops);
  } catch (e) {
    if (e instanceof PatchError) throw new KairosError('SCHEMA_INVALID', { message: `patch op ${e.index}: ${e.message}` });
    throw e;
  }
}

/** L1–L4 with the real CEL checker (L3), the tenant's domain modes and enabled flags (for NOTICE_MISSING). */
export function runValidation(
  doc: ConfigDocument, ctx: { modes: Partial<Record<Domain, ConfigDomainMode>>; flags: ReadonlySet<string> },
): ValidationReport {
  let expr;
  try {
    expr = celChecker(doc);
  } catch {
    expr = undefined;   // a document that fails L1 has no usable templates; validate reports L1 only
  }
  return validate(doc, { expr, domainModes: ctx.modes, flags: ctx.flags });
}

export const hasErrors = (r: ValidationReport): boolean => r.issues.some((i) => i.severity === 'E');

/** Publishes a compiled document as the next version. Active now, or staged until `effectiveFrom` (I-01). */
export function insertVersion(
  tx: Tx,
  a: { document: ConfigDocument; actor: unknown; now: number; effectiveFrom: number; summary: string; rollbackOf: number | null },
): ConfigVersionSummary {
  const compiled = compile(a.document);
  const prev = tx.maybe<{ number: number }>(`SELECT max(number) AS number FROM config_version`)?.number ?? null;
  const number = (prev ?? 0) + 1;
  const active = tx.maybe<{ number: number }>(`SELECT number FROM config_version WHERE state = 'active'`)?.number ?? null;
  const immediate = a.effectiveFrom <= a.now;
  if (immediate) tx.run(`UPDATE config_version SET state = 'superseded' WHERE state IN ('active','staged')`);
  else tx.run(`UPDATE config_version SET state = 'superseded' WHERE state = 'staged'`);   // a newer publish replaces a pending one
  tx.run(
    `INSERT INTO config_version (id, number, content_hash, document, compiled, parent_number, published_at, published_by,
       effective_from, summary, rollback_of, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    `cfv_${crypto.randomUUID().replaceAll('-', '')}`, number, compiled.content_hash, canonicalJson(a.document), canonicalJson(compiled),
    active, a.now, canonicalJson(a.actor), a.effectiveFrom, a.summary, a.rollbackOf, immediate ? 'active' : 'staged',
  );
  if (immediate) {
    bumpEpoch(tx);
    materializeStructural(tx, compiled.document, a.now);
  }
  return {
    number, content_hash: compiled.content_hash, state: immediate ? 'active' : 'staged', effective_from: a.effectiveFrom,
    published_at: a.now, summary: a.summary, rollback_of: a.rollbackOf, parent_number: active,
  };
}

/** `config_epoch` is read on every request; any activation bumps it so caches keyed by it turn over (§12.8). */
export function bumpEpoch(tx: Tx): number {
  const cur = Number(tx.maybe<{ value: string }>(`SELECT value FROM scheduler_state WHERE key = 'config_epoch'`)?.value ?? 0);
  tx.run(`INSERT INTO scheduler_state (key, value) VALUES ('config_epoch', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, String(cur + 1));
  return cur + 1;
}

/** Activates a staged version when its effective_from arrives (I-01). */
export function activationSource(db: Db, onActivate: (tx: Tx, number: number, now: number) => void): TickSource {
  return {
    name: 'config_activation',
    nextDue: (d) => d.tx((tx) => tx.maybe<{ t: number | null }>(`SELECT min(effective_from) AS t FROM config_version WHERE state = 'staged'`)?.t ?? null),
    async run(now) {
      return db.tx((tx) => {
        const due = tx.maybe<{ number: number }>(
          `SELECT number FROM config_version WHERE state = 'staged' AND effective_from <= ? ORDER BY number DESC LIMIT 1`, now);
        if (!due) return 0;
        tx.run(`UPDATE config_version SET state = 'superseded' WHERE state = 'active'`);
        tx.run(`UPDATE config_version SET state = 'active' WHERE number = ?`, due.number);
        bumpEpoch(tx);
        const compiled = JSON.parse(tx.one<{ compiled: string }>('SELECT compiled FROM config_version WHERE number = ?', due.number).compiled) as { document: ConfigDocument };
        materializeStructural(tx, compiled.document, now);
        onActivate(tx, due.number, now);
        return 1;
      });
    },
  };
}
