// TenantSync: one Durable Object per (tenant, env), holding the kairos-sync database (§12.1). Phase 0 skeleton:
// polling of BookingVendor and ShiftTool through the gateway into raw snapshots, signed and deduplicated inbound
// events, and mirror ingestion of BookingVendor classes into TenantCore (`mirrorApply`, §12.1). Shadow mode and the
// other entities' ingestion come later in Phase 1.
import { DurableObject } from 'cloudflare:workers';
import { ScopeGuard, type MirrorClass, type MirrorResult, type Scope, type TenantCore } from '@kairos/core';
import { applyMigrations, canonicalJson, createDb, sha256Hex, type Db, type Migration } from '@kairos/db';
import { Scheduler, type TickSource } from '@kairos/scheduler';
import sync0001 from '../migrations/0001_sync.sql';
import { ADAPTERS, readPage, type GatewayEnv, type OutsideRecord } from './adapters';

export const syncMigrations: readonly Migration[] = [{ id: '0001_sync', sql: sync0001 }];

export const INBOUND_DEDUPE_MS = 7 * 86_400_000;   // §12.6
const MAX_PAGES_PER_POLL = 20;

export interface SyncEnv extends GatewayEnv {
  /** The tenant's core objects, for mirror ingestion (§12.1: kairos-sync writes through kairos-core's API). */
  TENANT_CORE?: DurableObjectNamespace<TenantCore>;
}

/** The normalised BookingVendor class record the gateway returns (`data` of each record). */
interface BvClass {
  template_key: string;
  location_key: string;
  room_key?: string | null;
  start: number;
  end: number;
  status?: 'scheduled' | 'cancelled';
  teacher?: { external_id: string; email?: string | null; name: string } | null;
}

const toMirrorClass = (r: OutsideRecord): MirrorClass => {
  const d = r.data as unknown as BvClass;
  return {
    external_id: r.external_id, template_key: d.template_key, location_key: d.location_key, room_key: d.room_key ?? null,
    start: d.start, end: d.end, status: d.status ?? 'scheduled',
    teacher: d.teacher ? { external_id: d.teacher.external_id, email: d.teacher.email ?? null, name: d.teacher.name } : null,
  };
};

export interface PollReport {
  system: string;
  entity: string;
  records: number;
  changed: number;
  error?: string;
}

export class TenantSync extends DurableObject<SyncEnv> {
  readonly db: Db;
  readonly scheduler: Scheduler;
  private readonly guard: ScopeGuard;
  private scope: Scope | undefined;

  constructor(ctx: DurableObjectState, env: SyncEnv) {
    super(ctx, env);
    this.db = createDb(ctx.storage);
    this.guard = new ScopeGuard(this.db);
    this.scheduler = new Scheduler({ storage: ctx.storage, db: this.db, sources: [this.pollSource(), this.pruneSource()] });
    void ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx.storage, syncMigrations, Date.now());
    });
  }

  /** Seeds one cursor per adapter entity. `firstPollAt` defaults to now (onboarding may schedule the backfill later). */
  async init(scope: Scope, opts: { firstPollAt?: number } = {}): Promise<void> {
    this.enter(scope);
    const now = opts.firstPollAt ?? Date.now();
    this.db.tx((tx) => {
      for (const a of ADAPTERS) for (const e of a.entities) {
        tx.run(`INSERT INTO adapter_cursor (system, entity_type, next_poll_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, a.system, e, now);
      }
    });
    await this.scheduler.rearm();
  }

  override async alarm(): Promise<void> {
    await this.scheduler.tick();
  }

  /** Polls one adapter entity now, following cursors, and records changed snapshots. */
  async poll(scope: Scope, system: string, entity: string): Promise<PollReport> {
    this.enter(scope);
    return this.pollOne(system, entity, Date.now());
  }

  /**
   * Records an inbound event once (§12.6). Returns false for a duplicate, which the caller acknowledges with 200 and
   * drops. Signature and timestamp are checked by kairos-api before this is called (§13.7).
   */
  async receive(scope: Scope, system: string, eventId: string, payload: unknown): Promise<boolean> {
    this.enter(scope);
    const now = Date.now();
    return this.db.tx((tx) => {
      if (tx.run(`INSERT INTO inbound_event (system, event_id, received_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, system, eventId, now) === 0) {
        return false;
      }
      tx.run(`INSERT INTO inbound_buffer (system, event_id, payload, received_at, state) VALUES (?, ?, ?, ?, 'pending')`,
        system, eventId, canonicalJson(payload ?? null), now);
      return true;
    });
  }

  async status(scope: Scope): Promise<{ cursors: Record<string, SqlStorageValue>[]; snapshots: number; inboundPending: number }> {
    this.enter(scope);
    return this.db.tx((tx) => ({
      cursors: tx.all('SELECT * FROM adapter_cursor ORDER BY system, entity_type'),
      snapshots: tx.one<{ n: number }>('SELECT count(*) AS n FROM raw_snapshot').n,
      inboundPending: tx.one<{ n: number }>(`SELECT count(*) AS n FROM inbound_buffer WHERE state = 'pending'`).n,
    }));
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  private async pollOne(system: string, entity: string, now: number): Promise<PollReport> {
    const def = ADAPTERS.find((a) => a.system === system && a.entities.includes(entity));
    if (!def) throw new Error(`no adapter for ${system}/${entity}`);
    let cursor = this.db.tx((tx) =>
      tx.maybe<{ cursor: string | null }>('SELECT cursor FROM adapter_cursor WHERE system = ? AND entity_type = ?', system, entity))?.cursor ?? null;
    let records = 0;
    let changed = 0;
    try {
      for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
        const p = await readPage(this.env, this.knownScope(), system, entity, cursor);
        // classes are written into TenantCore before their snapshots: if that fails, the next poll sees them as changed
        const fresh = this.db.tx((tx) => p.records.filter((r) =>
          tx.maybe<{ content_hash: string }>('SELECT content_hash FROM raw_snapshot WHERE system = ? AND entity_type = ? AND external_id = ?',
            system, entity, r.external_id)?.content_hash !== sha256Hex(canonicalJson(r.data))));
        if (system === 'booking_vendor' && entity === 'classes' && fresh.length && this.env.TENANT_CORE) {
          const scope = this.knownScope();
          const core = this.env.TENANT_CORE.get(this.env.TENANT_CORE.idFromName(`${scope.tenant}:${scope.env}`));
          const res = await core.mirrorApply(scope, fresh.map(toMirrorClass));
          this.recordDrift(system, res, now);
        }
        // one transaction per page: snapshots and the cursor advance together
        changed += this.db.tx((tx) => {
          let c = 0;
          for (const r of p.records) {
            const hash = sha256Hex(canonicalJson(r.data));
            const w = tx.run(
              `INSERT INTO raw_snapshot (system, entity_type, external_id, external_version, content_hash, payload, first_seen_at, last_seen_at, changed_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)
               ON CONFLICT (system, entity_type, external_id) DO UPDATE SET
                 external_version = excluded.external_version, last_seen_at = excluded.last_seen_at,
                 payload = excluded.payload, content_hash = excluded.content_hash, changed_at = excluded.changed_at
               WHERE raw_snapshot.content_hash != excluded.content_hash`,
              system, entity, r.external_id, r.external_version ?? null, hash, canonicalJson(r.data), now,
            );
            if (w > 0) c++;
            else tx.run(`UPDATE raw_snapshot SET last_seen_at = ? WHERE system = ? AND entity_type = ? AND external_id = ?`, now, system, entity, r.external_id);
          }
          tx.run(`UPDATE adapter_cursor SET cursor = ? WHERE system = ? AND entity_type = ?`, p.next_cursor ?? cursor, system, entity);
          return c;
        });
        records += p.records.length;
        if (!p.next_cursor || p.next_cursor === cursor) break;
        cursor = p.next_cursor;
      }
      this.db.tx((tx) => tx.run(
        `UPDATE adapter_cursor SET next_poll_at = ?, last_success_at = ?, consecutive_failures = 0, last_error = NULL
         WHERE system = ? AND entity_type = ?`, now + def.pollEveryMs, now, system, entity));
      return { system, entity, records, changed };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // back off: 1, 2, 4 … minutes, capped at the poll interval
      this.db.tx((tx) => tx.run(
        `UPDATE adapter_cursor SET consecutive_failures = consecutive_failures + 1, last_error = ?,
           next_poll_at = ? + min(?, 60000 * (1 << min(consecutive_failures, 6)))
         WHERE system = ? AND entity_type = ?`, error, now, def.pollEveryMs, system, entity));
      return { system, entity, records, changed, error };
    }
  }

  /** Drift from mirror ingestion (§18.5): cross-domain conflicts and unmapped teachers are manual items. */
  private recordDrift(system: string, res: MirrorResult, now: number): void {
    this.db.tx((tx) => {
      const add = (kind: string, externalId: string, detail: unknown) => tx.run(
        `INSERT INTO drift_item (id, kind, system, entity_type, external_id, detail, state, created_at)
         VALUES (?, ?, ?, 'classes', ?, ?, 'open', ?) ON CONFLICT DO NOTHING`,
        `drf_${crypto.randomUUID().replaceAll('-', '')}`, kind, system, externalId, canonicalJson(detail), now);
      for (const c of res.conflicts) add('cross_domain_conflict', c.external_id, c);
      for (const u of res.unmapped) add('unmapped_person', u.external_id, u);
    });
  }

  async drift(scope: Scope): Promise<{ id: string; kind: string; external_id: string | null; detail: string; created_at: number }[]> {
    this.enter(scope);
    return this.db.tx((tx) => tx.all(`SELECT id, kind, external_id, detail, created_at FROM drift_item WHERE state = 'open' ORDER BY created_at DESC LIMIT 200`));
  }

  private pollSource(): TickSource {
    return {
      name: 'poll',
      nextDue: (db) => db.tx((tx) => tx.maybe<{ t: number | null }>('SELECT min(next_poll_at) AS t FROM adapter_cursor')?.t ?? null),
      run: async (now) => {
        const due = this.db.tx((tx) => tx.all<{ system: string; entity_type: string }>(
          'SELECT system, entity_type FROM adapter_cursor WHERE next_poll_at <= ? ORDER BY next_poll_at', now));
        for (const d of due) await this.pollOne(d.system, d.entity_type, now);
        return due.length;
      },
    };
  }

  private pruneSource(): TickSource {
    return {
      name: 'prune_inbound',
      nextDue: () => null,   // runs on whatever tick happens; never schedules a wake of its own
      run: async (now) =>
        this.db.tx((tx) => tx.run(
          `DELETE FROM inbound_event WHERE (system, event_id) IN
             (SELECT system, event_id FROM inbound_event WHERE received_at < ? LIMIT 500)`, now - INBOUND_DEDUPE_MS)),
    };
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
}
