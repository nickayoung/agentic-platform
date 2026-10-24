// Every call into a tenant object names its tenant and environment, and the object checks it against its own
// name (§13.1). An object is named "{tenant}:{env}" (§19.1).
import { KairosError } from '@kairos/errors';
import type { Db } from '@kairos/db';

export type Environment = 'preview' | 'production';

export interface Scope {
  tenant: string;   // slug, confirmed by the control plane before any object is addressed
  env: Environment;
}

export const objectName = (s: Scope): string => `${s.tenant}:${s.env}`;

export class ScopeGuard {
  private name: string | undefined;

  constructor(private readonly db: Db) {}

  check(s: Scope): void {
    const want = objectName(s);
    if (this.name === undefined) {
      this.name = this.db.tx((tx) => {
        const r = tx.maybe<{ value: string }>(`SELECT value FROM scheduler_state WHERE key = 'object_name'`);
        if (r) return r.value;
        tx.run(`INSERT INTO scheduler_state (key, value) VALUES ('object_name', ?)`, want);
        return want;
      });
    }
    if (this.name !== want) throw new KairosError('TENANT_MISMATCH', { message: `object ${this.name} got ${want}` });
  }
}
