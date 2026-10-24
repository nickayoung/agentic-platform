// Test-only worker: a bare Durable Object with SQLite storage and the core migrations applied.
import { DurableObject } from 'cloudflare:workers';
import { applyMigrations, coreMigrations, createDb, type Db } from '../src/index';

export class TestDb extends DurableObject {
  readonly db: Db;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage, { place_claim: 'PLACE_TAKEN', entitlement_balance: 'INSUFFICIENT_UNITS' });
    ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx.storage, coreMigrations, Date.now());
    });
  }
}

export default {
  fetch: () => new Response('test worker'),
};
