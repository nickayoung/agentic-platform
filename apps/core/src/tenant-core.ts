// TenantCore: one Durable Object per (tenant, env). It holds the kairos-core database (§12) and runs the engines.
// Every write is one synchronous transaction (§12.2, §19.2); the scheduler drives the object's single alarm (§19.5).
import { DurableObject } from 'cloudflare:workers';
import {
  appendAudit, applyMigrations, canonicalJson, coreMigrations, createDb, sha256Hex, type ConstraintMap, type Db, type Tx,
} from '@kairos/db';
import { KairosError } from '@kairos/errors';
import { enqueue, outboxSource, sagaSource, Scheduler, type OutboxInput, type SagaDefinition } from '@kairos/scheduler';
import { httpDeliver, type DeliveryEnv } from './deliver';
import { emitEvent, type EventInput } from './events';
import {
  activationSource, activeVersion, hasErrors, insertVersion, loadDraft, patchDocument, readDocument, runValidation, toDraft,
  type ConfigVersionSummary, type Draft, type JsonObject,
} from './config';
import type { ConfigDocument, JsonPatchOp } from '@kairos/config-schema';
import { nextMaintenanceSlot, runMaintenance, type MaintenanceReport } from './maintenance';
import { objectName, ScopeGuard, type Scope } from './scope';

export interface CoreEnv extends DeliveryEnv {
  ARCHIVE?: R2Bucket;   // locked audit/decision archive (§19.7)
}

export type ActorRef = { type: 'member' | 'staff' | 'agent' | 'service' | 'system'; [k: string]: unknown };

export interface CallContext {
  scope: Scope;
  actor: ActorRef;
  requestId: string;
}

export type Domain = 'classes' | 'bookings' | 'members' | 'shifts';
export type DomainModeName = 'mirror' | 'shadow' | 'owner';

export interface DomainMode {
  domain: Domain;
  mode: DomainModeName;
  outside_system: string | null;
  outbound_push: boolean;
  retired: boolean;
  write_freeze: boolean;
  version: number;
}

export interface Flag {
  key: string;
  enabled: boolean;
  allow_locations: string[] | null;
  allow_roles: string[] | null;
  owner: string;
  remove_by: string;
  version: number;
}

/** Reason codes for named constraints and tables (§12.2 step 4). */
export const CORE_CONSTRAINTS: ConstraintMap = {
  place_claim: 'PLACE_TAKEN',
  booking: 'STALE_VERSION',
  entitlement_balance_nonneg: 'INSUFFICIENT_UNITS',
  limit_counter_within_max: 'LIMIT_REACHED',
  offer: 'OFFER_FILLED',
};

/** §18.2: every domain starts in mirror. */
const INITIAL_MODES: { domain: Domain; outside_system: string }[] = [
  { domain: 'classes', outside_system: 'booking_vendor' },
  { domain: 'bookings', outside_system: 'booking_vendor' },
  { domain: 'members', outside_system: 'booking_vendor' },
  { domain: 'shifts', outside_system: 'shift_tool' },
];

/** Saga kinds register here as the phases add them (§12.7). */
export const SAGAS: SagaDefinition<never>[] = [];

export class TenantCore extends DurableObject<CoreEnv> {
  readonly db: Db;
  readonly scheduler: Scheduler;
  private readonly guard: ScopeGuard;
  private scope: Scope | undefined;

  constructor(ctx: DurableObjectState, env: CoreEnv) {
    super(ctx, env);
    this.db = createDb(ctx.storage, CORE_CONSTRAINTS);
    this.guard = new ScopeGuard(this.db);
    this.scheduler = new Scheduler({
      storage: ctx.storage,
      db: this.db,
      sources: [
        outboxSource({ db: this.db, deliver: httpDeliver(env, () => this.knownScope()), onDead: (tx, row, error, now) => {
          emitEvent(tx, { name: 'outbox.dead', subject: { type: 'outbox', id: row.id }, data: { topic: row.topic, target: row.target, error } }, now);
        } }),
        sagaSource(this.db, SAGAS, (id, e) => console.error(JSON.stringify({ msg: 'saga step failed', saga: id, error: String(e) }))),
        activationSource(this.db, (tx, number, now) => {
          emitEvent(tx, { name: 'config.activated', subject: { type: 'config_version', id: String(number) } }, now);
        }),
      ],
      nextMaintenance: () => this.maintenanceDue(),
      onSourceError: (source, e) => console.error(JSON.stringify({ msg: 'tick source failed', source, error: String(e) })),
    });
    void ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx.storage, coreMigrations, Date.now());
    });
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------

  /** Called once at provisioning (§3A.3): seeds domain modes and arms the scheduler. Idempotent. */
  async init(c: CallContext): Promise<{ object: string; modes: DomainMode[] }> {
    this.enter(c.scope);
    const now = Date.now();
    this.db.tx((tx) => {
      for (const m of INITIAL_MODES) {
        tx.run(
          `INSERT INTO domain_mode (domain, mode, outside_system, changed_at, changed_by) VALUES (?, 'mirror', ?, ?, ?)
           ON CONFLICT (domain) DO NOTHING`,
          m.domain, m.outside_system, now, JSON.stringify(c.actor),
        );
      }
      tx.run(`INSERT INTO scheduler_state (key, value) VALUES ('maintenance_due', ?) ON CONFLICT (key) DO NOTHING`,
        String(nextMaintenanceSlot(now)));
    });
    await this.scheduler.rearm();
    return { object: objectName(c.scope), modes: await this.getDomainModes(c.scope) };
  }

  async health(scope: Scope): Promise<{ object: string; migrations: string[]; alarm: number | null }> {
    this.enter(scope);
    const migrations = this.db.tx((tx) => tx.all<{ id: string }>('SELECT id FROM _migrations ORDER BY id')).map((r) => r.id);
    return { object: objectName(scope), migrations, alarm: await this.ctx.storage.getAlarm() };
  }

  /** Backstop cron entry point (§19.5). */
  async ensureAlarm(scope: Scope): Promise<{ wasMissing: boolean }> {
    this.enter(scope);
    const wasMissing = await this.scheduler.ensureAlarm();
    if (wasMissing) console.warn(JSON.stringify({ msg: 'alarm_missing', object: objectName(scope) }));
    return { wasMissing };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    if (now >= this.maintenanceDue()) await this.maintain(now);
    await this.scheduler.tick();
  }

  // ---- domain modes and flags (§3.3) ------------------------------------------------------------------------------

  async getDomainModes(scope: Scope): Promise<DomainMode[]> {
    this.enter(scope);
    return this.db.tx((tx) =>
      tx.all<Record<string, SqlStorageValue>>('SELECT * FROM domain_mode ORDER BY domain').map((r) => ({
        domain: r.domain as Domain, mode: r.mode as DomainModeName, outside_system: r.outside_system as string | null,
        outbound_push: r.outbound_push === 1, retired: r.retired === 1, write_freeze: r.write_freeze === 1, version: r.version as number,
      })),
    );
  }

  async listFlags(scope: Scope): Promise<Flag[]> {
    this.enter(scope);
    return this.db.tx((tx) => tx.all<Record<string, SqlStorageValue>>('SELECT * FROM flag ORDER BY key').map(toFlag));
  }

  /** Creates or updates a flag. New flags default to off (I-30); every flag has an owner and a remove_by date (§15). */
  async setFlag(
    c: CallContext,
    f: { key: string; enabled: boolean; owner: string; remove_by: string; allow_locations?: string[]; allow_roles?: string[] },
    expectedVersion: number | null,
  ): Promise<Flag> {
    if (!/^[a-z][a-z0-9_.]{1,62}$/.test(f.key)) throw new KairosError('SCHEMA_INVALID', { message: 'flag key' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.remove_by)) throw new KairosError('SCHEMA_INVALID', { message: 'remove_by must be a date' });
    return this.mutate(c, (tx, now) => {
      const before = tx.maybe<Record<string, SqlStorageValue>>('SELECT * FROM flag WHERE key = ?', f.key);
      if ((before?.version ?? null) !== expectedVersion) throw new KairosError('STALE_VERSION');
      tx.run(
        `INSERT INTO flag (key, enabled, allow_locations, allow_roles, owner, remove_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET enabled = excluded.enabled, allow_locations = excluded.allow_locations,
           allow_roles = excluded.allow_roles, owner = excluded.owner, remove_by = excluded.remove_by,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by, version = flag.version + 1`,
        f.key, f.enabled ? 1 : 0, f.allow_locations ? JSON.stringify(f.allow_locations) : null,
        f.allow_roles ? JSON.stringify(f.allow_roles) : null, f.owner, f.remove_by, now, JSON.stringify(c.actor),
      );
      const after = toFlag(tx.one('SELECT * FROM flag WHERE key = ?', f.key));
      return {
        result: after,
        audit: { action: 'flag.changed', target: { type: 'flag', id: f.key }, before: before ? toFlag(before) : null, after },
        events: [{ name: 'flag.changed', subject: { type: 'flag', id: f.key }, data: { enabled: after.enabled } }],
      };
    });
  }

  // ---- config pipeline (§6, manual path) --------------------------------------------------------------------------

  /** Starts a draft from YAML or JSON, or from the active version when neither is given. */
  async createDraft(c: CallContext, input: { yaml: string } | { document: unknown } | null): Promise<Draft> {
    this.enter(c.scope);
    const fromInput = input ? readDocument(input) : null;
    return this.mutate(c, (tx, now) => {
      const active = activeVersion(tx);
      const document = fromInput ?? active?.document;
      if (!document) throw new KairosError('NOT_FOUND', { message: 'no active config to start from; pass a document' });
      const id = `dft_${crypto.randomUUID().replaceAll('-', '')}`;
      tx.run(
        `INSERT INTO config_draft (id, base_number, document, state, author, created_at, updated_at)
         VALUES (?, ?, ?, 'editing', ?, ?, ?)`,
        id, active?.number ?? null, canonicalJson(document), canonicalJson(c.actor), now, now,
      );
      const d = toDraft(loadDraft(tx, id));
      return { result: d, audit: { action: 'config_draft.created', target: { type: 'config_draft', id }, before: null, after: { base_number: d.base_number } } };
    });
  }

  async getDraft(scope: Scope, id: string): Promise<Draft> {
    this.enter(scope);
    return this.db.tx((tx) => toDraft(loadDraft(tx, id)));
  }

  /** Applies JSON Patch operations (§6.1) with If-Match on the draft version. Any edit returns the draft to editing. */
  async patchDraft(c: CallContext, id: string, ops: JsonPatchOp[], expectedVersion: number): Promise<Draft> {
    this.enter(c.scope);
    const current = this.db.tx((tx) => loadDraft(tx, id));
    const document = patchDocument(JSON.parse(current.document) as ConfigDocument, ops);   // pure, outside the batch
    return this.mutate(c, (tx, now) => {
      const d = loadDraft(tx, id);
      if (d.version !== expectedVersion) throw new KairosError('STALE_VERSION');
      if (d.state === 'published' || d.state === 'abandoned') throw new KairosError('FORBIDDEN', { message: `draft is ${d.state}` });
      const patches = JSON.parse((tx.one<{ patches: string }>('SELECT patches FROM config_draft WHERE id = ?', id)).patches) as unknown[];
      tx.run(
        `UPDATE config_draft SET document = ?, patches = ?, validation = NULL, impact = NULL, state = 'editing',
           version = version + 1, updated_at = ? WHERE id = ?`,
        canonicalJson(document), canonicalJson([...patches, ops]), now, id,
      );
      return { result: toDraft(loadDraft(tx, id)), audit: { action: 'config_draft.patched', target: { type: 'config_draft', id }, before: null, after: { ops } } };
    });
  }

  /** Runs L1–L4 (L5 and L6 come with the solver and materialisation). No errors → validated. */
  async validateDraft(c: CallContext, id: string): Promise<Draft> {
    this.enter(c.scope);
    const { doc, version, modes, flags } = this.db.tx((tx) => {
      const d = loadDraft(tx, id);
      const modeRows = tx.all<{ domain: string; mode: string }>('SELECT domain, mode FROM domain_mode');
      const flagRows = tx.all<{ key: string }>('SELECT key FROM flag WHERE enabled = 1');
      return {
        doc: JSON.parse(d.document) as ConfigDocument, version: d.version,
        modes: Object.fromEntries(modeRows.map((m) => [m.domain, m.mode])) as never,
        flags: new Set(flagRows.map((f) => f.key)),
      };
    });
    const report = runValidation(doc, { modes, flags });   // pure; may take tens of ms, so outside the batch
    return this.mutate(c, (tx, now) => {
      const d = loadDraft(tx, id);
      if (d.version !== version) throw new KairosError('STALE_VERSION', { message: 'draft changed during validation' });
      const ok = !hasErrors(report);
      tx.run(
        `UPDATE config_draft SET validation = ?, impact = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        canonicalJson(report), ok ? canonicalJson({ groups: [] }) : null, ok ? 'validated' : 'editing', now, id,
      );
      return {
        result: toDraft(loadDraft(tx, id)),
        audit: { action: 'config_draft.validated', target: { type: 'config_draft', id }, before: null, after: { ok, issues: report.issues.length } },
      };
    });
  }

  async submitDraft(c: CallContext, id: string, expectedVersion: number): Promise<Draft> {
    return this.mutate(c, (tx, now) => {
      const d = loadDraft(tx, id);
      if (d.version !== expectedVersion) throw new KairosError('STALE_VERSION');
      if (d.state !== 'validated') throw new KairosError('FORBIDDEN', { message: `draft is ${d.state}; validate it first` });
      tx.run(`UPDATE config_draft SET state = 'awaiting_approval', version = version + 1, updated_at = ? WHERE id = ?`, now, id);
      return { result: toDraft(loadDraft(tx, id)), audit: { action: 'config_draft.submitted', target: { type: 'config_draft', id }, before: null, after: {} } };
    });
  }

  /**
   * Approval by an owner or admin publishes the draft (§6, principle 6). The draft must be based on the version that
   * is active now; otherwise it must be re-created from the new base.
   */
  async approveAndPublish(
    c: CallContext, id: string, expectedVersion: number, opts: { effective_from?: number; summary: string },
  ): Promise<ConfigVersionSummary> {
    this.enter(c.scope);
    const now = Date.now();
    const effectiveFrom = opts.effective_from ?? now;
    if (effectiveFrom < now - 60_000) throw new KairosError('SCHEMA_INVALID', { message: 'effective_from is in the past' });
    return this.mutate(c, (tx, at) => {
      const d = loadDraft(tx, id);
      if (d.version !== expectedVersion) throw new KairosError('STALE_VERSION');
      if (d.state !== 'awaiting_approval') throw new KairosError('FORBIDDEN', { message: `draft is ${d.state}; submit it first` });
      const active = activeVersion(tx);
      if ((active?.number ?? null) !== d.base_number) {
        throw new KairosError('STALE_VERSION', { message: `draft is based on v${d.base_number}; v${active?.number} is active` });
      }
      const v = insertVersion(tx, {
        document: JSON.parse(d.document) as ConfigDocument, actor: c.actor, now: at, effectiveFrom, summary: opts.summary, rollbackOf: null,
      });
      tx.run(`UPDATE config_draft SET state = 'published', approved_by = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        canonicalJson(c.actor), at, id);
      return {
        result: v,
        audit: { action: 'config.published', target: { type: 'config_version', id: String(v.number) }, before: null, after: { ...v, draft_id: id } },
        events: [{ name: v.state === 'active' ? 'config.activated' : 'config.staged', subject: { type: 'config_version', id: String(v.number) } }],
      };
    });
  }

  /** Rejection by an owner or admin (§11.3). The draft is abandoned; a new draft starts from the active version. */
  async rejectDraft(c: CallContext, id: string, expectedVersion: number, reason: string): Promise<Draft> {
    return this.mutate(c, (tx, now) => {
      const d = loadDraft(tx, id);
      if (d.version !== expectedVersion) throw new KairosError('STALE_VERSION');
      if (d.state === 'published' || d.state === 'abandoned') throw new KairosError('FORBIDDEN', { message: `draft is ${d.state}` });
      tx.run(`UPDATE config_draft SET state = 'abandoned', version = version + 1, updated_at = ? WHERE id = ?`, now, id);
      return { result: toDraft(loadDraft(tx, id)), audit: { action: 'config_draft.rejected', target: { type: 'config_draft', id }, before: null, after: { reason } } };
    });
  }

  async getConfigVersion(scope: Scope, n: number): Promise<(ConfigVersionSummary & { document: JsonObject }) | null> {
    this.enter(scope);
    return this.db.tx((tx) => {
      const r = tx.maybe<Record<string, SqlStorageValue>>(
        `SELECT number, content_hash, state, effective_from, published_at, summary, rollback_of, parent_number, document
         FROM config_version WHERE number = ?`, n);
      return r ? { ...(r as unknown as ConfigVersionSummary), document: JSON.parse(r.document as string) as JsonObject } : null;
    });
  }

  /** Publishes an earlier version's document again as a new version (§6, principle 6: every change can be rolled back). */
  async rollbackConfig(c: CallContext, toNumber: number, summary: string): Promise<ConfigVersionSummary> {
    return this.mutate(c, (tx, now) => {
      const target = tx.maybe<{ document: string }>('SELECT document FROM config_version WHERE number = ?', toNumber);
      if (!target) throw new KairosError('NOT_FOUND', { message: `config v${toNumber}` });
      const v = insertVersion(tx, {
        document: JSON.parse(target.document) as ConfigDocument, actor: c.actor, now, effectiveFrom: now, summary, rollbackOf: toNumber,
      });
      return {
        result: v,
        audit: { action: 'config.rolled_back', target: { type: 'config_version', id: String(v.number) }, before: null, after: v },
        events: [{ name: 'config.activated', subject: { type: 'config_version', id: String(v.number) }, reason: 'rollback' }],
      };
    });
  }

  async listConfigVersions(scope: Scope): Promise<ConfigVersionSummary[]> {
    this.enter(scope);
    return this.db.tx((tx) => tx.all<ConfigVersionSummary & Record<string, SqlStorageValue>>(
      `SELECT number, content_hash, state, effective_from, published_at, summary, rollback_of, parent_number
       FROM config_version ORDER BY number DESC LIMIT 100`));
  }

  async getActiveConfig(scope: Scope): Promise<{ number: number; content_hash: string; epoch: number; document: JsonObject } | null> {
    this.enter(scope);
    return this.db.tx((tx) => {
      const r = tx.maybe<{ number: number; content_hash: string; document: string }>(
        `SELECT number, content_hash, document FROM config_version WHERE state = 'active'`);
      if (!r) return null;
      const epoch = Number(tx.maybe<{ value: string }>(`SELECT value FROM scheduler_state WHERE key = 'config_epoch'`)?.value ?? 0);
      return { number: r.number, content_hash: r.content_hash, epoch, document: JSON.parse(r.document) as JsonObject };
    });
  }

  // ---- internals --------------------------------------------------------------------------------------------------

  /**
   * One state change: the body's writes, its audit entry, its events and its outbox rows in one transaction
   * (I-29, §3A.1 C1). The alarm is moved earlier afterwards if an outbox row is due sooner.
   */
  protected async mutate<R>(
    c: CallContext,
    body: (tx: Tx, now: number) => {
      result: R;
      audit: { action: string; target: { type: string; id: string }; before: unknown; after: unknown };
      events?: EventInput[];
      outbox?: OutboxInput[];
    },
  ): Promise<R> {
    this.enter(c.scope);
    const now = Date.now();
    const { result, outboxDue } = this.db.tx((tx) => {
      const out = body(tx, now);
      const cv = tx.maybe<{ number: number }>(`SELECT number FROM config_version WHERE state = 'active'`)?.number ?? 0;
      appendAudit(tx, {
        id: `aud_${crypto.randomUUID().replaceAll('-', '')}`, at: now, actor: c.actor, action: out.audit.action,
        target: out.audit.target, before_hash: out.audit.before === null ? null : hashOf(out.audit.before),
        after: out.audit.after, request_id: c.requestId, config_version: cv,
      });
      for (const e of out.events ?? []) emitEvent(tx, e, now);
      let due: number | null = null;
      for (const o of out.outbox ?? []) {
        enqueue(tx, o, now);
        due = Math.min(due ?? Infinity, o.notBefore ?? now);
      }
      return { result: out.result, outboxDue: due };
    });
    if (outboxDue !== null) await this.scheduler.poke(outboxDue);
    return result;
  }

  private enter(scope: Scope): void {
    this.guard.check(scope);
    this.scope = scope;
  }

  private knownScope(): Scope {
    if (this.scope) return this.scope;
    const name = this.db.tx((tx) => tx.maybe<{ value: string }>(`SELECT value FROM scheduler_state WHERE key = 'object_name'`))?.value;
    if (!name) throw new Error('object has no name yet');
    const [tenant, env] = name.split(':') as [string, Scope['env']];
    return (this.scope = { tenant, env });
  }

  private maintenanceDue(): number {
    const r = this.db.tx((tx) => tx.maybe<{ value: string }>(`SELECT value FROM scheduler_state WHERE key = 'maintenance_due'`));
    return r ? Number(r.value) : nextMaintenanceSlot(Date.now());
  }

  private async maintain(now: number): Promise<MaintenanceReport> {
    const report = await runMaintenance(this.db, now, this.knownScope(), this.env.ARCHIVE);
    this.db.tx((tx) => tx.run(
      `INSERT INTO scheduler_state (key, value) VALUES ('maintenance_due', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      String(nextMaintenanceSlot(now)),
    ));
    console.log(JSON.stringify({ msg: 'maintenance', object: objectName(this.knownScope()), ...report }));
    return report;
  }
}

function toFlag(r: Record<string, SqlStorageValue>): Flag {
  return {
    key: r.key as string, enabled: r.enabled === 1,
    allow_locations: r.allow_locations ? (JSON.parse(r.allow_locations as string) as string[]) : null,
    allow_roles: r.allow_roles ? (JSON.parse(r.allow_roles as string) as string[]) : null,
    owner: r.owner as string, remove_by: r.remove_by as string, version: r.version as number,
  };
}

const hashOf = (v: unknown): string => sha256Hex(canonicalJson(v));
