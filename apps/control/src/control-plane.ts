// ControlPlane: one object per environment, named "control:{env}" (§19.1). Holds the tenant registry, the
// wrapped per-tenant keys and tenant lifecycle state (§3.3, §3A.3).
import { DurableObject } from 'cloudflare:workers';
import { appendAudit, applyMigrations, createDb, type Db, type Migration } from '@kairos/db';
import { KairosError } from '@kairos/errors';
import { importKek, newWrappedKey } from '@kairos/crypto';
import control0001 from '../migrations/0001_control.sql';

export const controlMigrations: readonly Migration[] = [{ id: '0001_control', sql: control0001 }];

export type TenantState = 'provisioning' | 'onboarding' | 'live' | 'offboarding' | 'closed' | 'deleted';

export interface IdentityConfig {
  member: { issuer: string; audience: string; jwks_url: string };
  staff: { issuer: string; audience: string; jwks_url: string };
}

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  state: TenantState;
  legal_hold: boolean;
  region_hint: string;
  identity: IdentityConfig;
  version: number;
}

/** Allowed lifecycle moves (§3A.3). Closed tenants may only be deleted; deletion is final. */
const TRANSITIONS: Record<TenantState, TenantState[]> = {
  provisioning: ['onboarding'],
  onboarding: ['live', 'offboarding'],
  live: ['offboarding'],
  offboarding: ['closed', 'live'],
  closed: ['deleted'],
  deleted: [],
};

/** States whose tenants have objects to keep alive (backstop cron, §19.5). */
export const ACTIVE_STATES: readonly TenantState[] = ['provisioning', 'onboarding', 'live', 'offboarding'];

export interface ControlEnv {
  KEK?: { get(): Promise<string> };   // Secrets Store binding (§19.13)
  KEK_VERSION?: string;
}

type Actor = { type: string; [k: string]: unknown };

interface TenantRow {
  id: string; slug: string; name: string; state: TenantState; legal_hold: number; region_hint: string;
  identity: string; version: number; [k: string]: SqlStorageValue;
}

const toRecord = (r: TenantRow): TenantRecord => ({
  id: r.id, slug: r.slug, name: r.name, state: r.state, legal_hold: r.legal_hold === 1,
  region_hint: r.region_hint, identity: JSON.parse(r.identity) as IdentityConfig, version: r.version,
});

export class ControlPlane extends DurableObject<ControlEnv> {
  private readonly db: Db;

  constructor(ctx: DurableObjectState, env: ControlEnv) {
    super(ctx, env);
    this.db = createDb(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx.storage, controlMigrations, Date.now());
    });
  }

  async createTenant(
    input: { slug: string; name: string; identity: IdentityConfig; region_hint?: string },
    actor: Actor, requestId: string,
  ): Promise<TenantRecord> {
    // keys are generated and wrapped before the transaction (WebCrypto is async, §19.2)
    const kekB64 = await this.env.KEK?.get();
    if (!kekB64) throw new Error('KEK secret is not bound');
    const kek = await importKek(kekB64);
    const [dataKey, indexKey] = await Promise.all([newWrappedKey(kek), newWrappedKey(kek)]);
    const kekVersion = Number(this.env.KEK_VERSION ?? 1);
    const now = Date.now();
    const id = `ten_${crypto.randomUUID().replaceAll('-', '')}`;

    return this.db.tx((tx) => {
      if (tx.maybe('SELECT 1 FROM tenant WHERE slug = ?', input.slug)) {
        throw new KairosError('STALE_VERSION', { message: `tenant slug ${input.slug} exists` });
      }
      tx.run(
        `INSERT INTO tenant (id, slug, name, state, region_hint, identity, created_at, updated_at)
         VALUES (?, ?, ?, 'provisioning', ?, ?, ?, ?)`,
        id, input.slug, input.name, input.region_hint ?? 'enam', JSON.stringify(input.identity), now, now,
      );
      for (const [purpose, wrapped] of [['data', dataKey], ['blind_index', indexKey]] as const) {
        tx.run(
          `INSERT INTO tenant_key (tenant_id, purpose, key_version, wrapped, kek_version, state, created_at)
           VALUES (?, ?, 1, ?, ?, 'active', ?)`,
          id, purpose, wrapped, kekVersion, now,
        );
      }
      appendAudit(tx, {
        id: `aud_${crypto.randomUUID()}`, at: now, actor, action: 'tenant.provisioned',
        target: { type: 'tenant', id }, before_hash: null, after: { slug: input.slug, name: input.name },
        request_id: requestId, config_version: 0,
      });
      return toRecord(tx.one<TenantRow>('SELECT * FROM tenant WHERE id = ?', id));
    });
  }

  async getTenant(slug: string): Promise<TenantRecord | null> {
    const r = this.db.tx((tx) => tx.maybe<TenantRow>('SELECT * FROM tenant WHERE slug = ?', slug));
    return r ? toRecord(r) : null;
  }

  async listActive(): Promise<string[]> {
    const states = ACTIVE_STATES.map(() => '?').join(',');
    return this.db.tx((tx) => tx.all<{ slug: string }>(`SELECT slug FROM tenant WHERE state IN (${states}) ORDER BY slug`, ...ACTIVE_STATES)).map((r) => r.slug);
  }

  async setState(slug: string, to: TenantState, expectedVersion: number, actor: Actor, requestId: string): Promise<TenantRecord> {
    const now = Date.now();
    return this.db.tx((tx) => {
      const t = tx.maybe<TenantRow>('SELECT * FROM tenant WHERE slug = ?', slug);
      if (!t) throw new KairosError('NOT_FOUND', { message: `tenant ${slug}` });
      if (t.version !== expectedVersion) throw new KairosError('STALE_VERSION');
      if (!TRANSITIONS[t.state].includes(to)) {
        throw new KairosError('FORBIDDEN', { message: `tenant ${slug}: ${t.state} → ${to} is not allowed` });
      }
      if (to === 'deleted' && t.legal_hold === 1) throw new KairosError('FORBIDDEN', { message: 'legal hold blocks deletion' });
      const closedAt = to === 'closed' ? now : null;
      tx.run(
        `UPDATE tenant SET state = ?, closed_at = coalesce(?, closed_at),
           delete_after = CASE WHEN ? = 'closed' THEN ? + 30 * 86400000 ELSE delete_after END,
           updated_at = ?, version = version + 1 WHERE id = ?`,
        to, closedAt, to, now, now, t.id,
      );
      appendAudit(tx, {
        id: `aud_${crypto.randomUUID()}`, at: now, actor, action: 'tenant.state_changed',
        target: { type: 'tenant', id: t.id }, before_hash: null, after: { from: t.state, to },
        request_id: requestId, config_version: 0,
      });
      return toRecord(tx.one<TenantRow>('SELECT * FROM tenant WHERE id = ?', t.id));
    });
  }

  /** Wrapped keys for one tenant; only the tenant's own objects call this, at startup (§19.13). */
  async wrappedKeys(tenantId: string): Promise<{ purpose: 'data' | 'blind_index'; key_version: number; wrapped: string }[]> {
    return this.db.tx((tx) =>
      tx.all<{ purpose: 'data' | 'blind_index'; key_version: number; wrapped: string }>(
        `SELECT purpose, key_version, wrapped FROM tenant_key WHERE tenant_id = ? AND state != 'destroyed'`, tenantId),
    );
  }
}
