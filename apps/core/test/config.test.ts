import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import lotusYaml from '../../../fixtures/configs/lotus_line.yaml';
import golden from '../../../fixtures/configs/golden-hashes.json';
import type { CallContext, Scope } from '../src/index';

let n = 0;
const fresh = async () => {
  const scope: Scope = { tenant: `cfg-${n++}`, env: 'preview' };
  const stub = env.TENANT_CORE.get(env.TENANT_CORE.idFromName(`${scope.tenant}:${scope.env}`));
  const c: CallContext = { scope, actor: { type: 'staff', subject: 'owner_1', roles: ['owner'] }, requestId: 'req' };
  await stub.init(c);
  return { scope, stub, c };
};
const failure = (p: Promise<unknown>) => Promise.resolve(p).then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as Error & { code?: string });

async function publishLotus() {
  const f = await fresh();
  const d0 = await f.stub.createDraft(f.c, { yaml: lotusYaml });
  const d1 = await f.stub.validateDraft(f.c, d0.id);
  const d2 = await f.stub.submitDraft(f.c, d0.id, d1.version);
  const v = await f.stub.approveAndPublish(f.c, d0.id, d2.version, { summary: 'initial config' });
  return { ...f, draftId: d0.id, v };
}

describe('manual config pipeline (§6, §15 Phase 0 acceptance 1)', () => {
  it('lotus_line.yaml: draft → validate (L1–L4, real CEL) → submit → approve → publish, at its golden hash', async () => {
    const { stub, scope, c } = await fresh();
    const d0 = await stub.createDraft(c, { yaml: lotusYaml });
    expect(d0.state).toBe('editing');
    const d1 = await stub.validateDraft(c, d0.id);
    expect(d1.validation!.issues.filter((i) => i.severity === 'E')).toEqual([]);
    expect(d1.validation!.issues.filter((i) => i.code === 'NOTICE_MISSING')).toEqual([]);
    expect(d1.state).toBe('validated');
    expect(d1.impact).toEqual({ groups: [] });
    const d2 = await stub.submitDraft(c, d0.id, d1.version);
    const v = await stub.approveAndPublish(c, d0.id, d2.version, { summary: 'initial config' });
    expect(v).toMatchObject({ number: 1, state: 'active' });
    // the published version stores the compiled (defaulted) document's hash
    const goldenHashes = golden as Record<string, { compiled_hash: string }>;
    expect(v.content_hash).toBe(goldenHashes['lotus_line.yaml']!.compiled_hash);
    const active = await stub.getActiveConfig(scope);
    expect(active).toMatchObject({ number: 1, epoch: 1 });
    expect((await stub.getDraft(scope, d0.id)).state).toBe('published');
  });

  it('a patch that breaks a rule fails validation and stays in editing', async () => {
    const { stub, c, scope } = await publishLotus();
    const d0 = await stub.createDraft(c, null);   // from the active version
    expect(d0.base_number).toBe(1);
    const p = await stub.patchDraft(c, d0.id, [{ op: 'replace', path: '/schema_version', value: '9.9' }], d0.version);
    const v = await stub.validateDraft(c, p.id);
    expect(v.state).toBe('editing');
    expect(v.validation!.issues.some((i) => i.code === 'SCHEMA_INVALID')).toBe(true);
    expect((await failure(stub.submitDraft(c, p.id, v.version))).code).toBe('FORBIDDEN');
    expect((await stub.getActiveConfig(scope))!.number).toBe(1);
  });

  it('patches need If-Match, and any edit invalidates an earlier validation', async () => {
    const { stub, c } = await publishLotus();
    const d0 = await stub.createDraft(c, null);
    const d1 = await stub.validateDraft(c, d0.id);
    expect(d1.state).toBe('validated');
    expect((await failure(stub.patchDraft(c, d0.id, [{ op: 'replace', path: '/tenant/hold_ttl', value: '10m' }], d0.version))).code).toBe('STALE_VERSION');
    const d2 = await stub.patchDraft(c, d0.id, [{ op: 'replace', path: '/tenant/hold_ttl', value: '10m' }], d1.version);
    expect(d2.state).toBe('editing');
    expect(d2.validation).toBeNull();
    expect(JSON.parse(JSON.stringify(d2))).toMatchObject({ document: { tenant: { hold_ttl: '10m' } } });
  });

  it('a draft based on a version that is no longer active cannot be published', async () => {
    const { stub, c } = await publishLotus();
    const a = await stub.createDraft(c, null);
    const b = await stub.createDraft(c, null);
    for (const d of [a, b]) {
      const v = await stub.validateDraft(c, d.id);
      await stub.submitDraft(c, d.id, v.version);
    }
    const av = await stub.getDraft(c.scope, a.id);
    await stub.approveAndPublish(c, a.id, av.version, { summary: 'a' });
    const bv = await stub.getDraft(c.scope, b.id);
    expect((await failure(stub.approveAndPublish(c, b.id, bv.version, { summary: 'b' }))).code).toBe('STALE_VERSION');
  });

  it('rollback publishes an earlier document as a new active version', async () => {
    const { stub, c, scope } = await publishLotus();
    const d = await stub.createDraft(c, null);
    const p = await stub.patchDraft(c, d.id, [{ op: 'replace', path: '/tenant/hold_ttl', value: '10m' }], d.version);
    const v = await stub.validateDraft(c, p.id);
    const s = await stub.submitDraft(c, p.id, v.version);
    const v2 = await stub.approveAndPublish(c, p.id, s.version, { summary: 'longer holds' });
    expect(v2.number).toBe(2);
    const r = await stub.rollbackConfig(c, 1, 'undo');
    expect(r).toMatchObject({ number: 3, rollback_of: 1, state: 'active' });
    const active = await stub.getActiveConfig(scope);
    expect(JSON.parse(JSON.stringify(active))).toMatchObject({ document: { tenant: { hold_ttl: '5m' } } });
    expect(active!.epoch).toBe(3);
    const versions = await stub.listConfigVersions(scope);
    expect(versions.map((x) => [x.number, x.state])).toEqual([[3, 'active'], [2, 'superseded'], [1, 'superseded']]);
  });

  it('a future effective_from stages the version; the scheduler activates it on time (I-01)', async () => {
    const { stub, c, scope } = await publishLotus();
    const d = await stub.createDraft(c, null);
    const v = await stub.validateDraft(c, d.id);
    const s = await stub.submitDraft(c, d.id, v.version);
    const at = Date.now() + 3_600_000;
    // make sure no unrelated wake (the daily maintenance slot) comes first, whatever the time of day
    await runInDurableObject(stub, (obj) => obj.db.tx((tx) => tx.run(
      `UPDATE scheduler_state SET value = ? WHERE key = 'maintenance_due'`, String(at + 86_400_000))));
    const staged = await stub.approveAndPublish(c, d.id, s.version, { summary: 'next hour', effective_from: at });
    expect(staged.state).toBe('staged');
    expect((await stub.getActiveConfig(scope))!.number).toBe(1);
    await runInDurableObject(stub, async (obj, state) => {
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(at);
      obj.db.tx((tx) => tx.run(`UPDATE config_version SET effective_from = 0 WHERE state = 'staged'`));
      await obj.alarm();
    });
    expect((await stub.getActiveConfig(scope))!.number).toBe(2);
  });

  it('every pipeline step is audited in one hash chain', async () => {
    const { stub } = await publishLotus();
    await runInDurableObject(stub, async (obj) => {
      const actions = obj.db.tx((tx) => tx.all<{ action: string }>('SELECT action FROM audit ORDER BY seq')).map((a) => a.action);
      expect(actions).toEqual(['config_draft.created', 'config_draft.validated', 'config_draft.submitted', 'config.published']);
      const { verifyAudit } = await import('@kairos/db');
      expect(obj.db.tx((tx) => verifyAudit(tx))).toBeNull();
    });
  });
});
