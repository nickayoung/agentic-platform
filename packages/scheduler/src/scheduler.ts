// One scheduler per Durable Object drives the object's single alarm (§19.5, D-65). Every "alarm" and "sweep" in
// the spec is a tick source here. A tick handles each source in order, then re-arms at the earliest due time,
// never later than one minute while any work is pending.
import type { Db } from '@kairos/db';

export const MAX_IDLE_WAKE_MS = 60_000;

export interface TickSource {
  /** Stable name, used in logs and metrics. */
  readonly name: string;
  /** Earliest time this source has work due, or null when it has none. Read-only. */
  nextDue(db: Db, now: number): number | null;
  /** Handles due work. Each item runs in its own transaction; awaits happen between transactions. */
  run(now: number, budget: number): Promise<number>;
}

export interface SchedulerOptions {
  storage: DurableObjectStorage;
  db: Db;
  sources: readonly TickSource[];
  /** Time of the next maintenance slot after `now` (pruning, reconciliation, export). */
  nextMaintenance?: (now: number) => number;
  clock?: () => number;
  budgetPerSource?: number;
  onSourceError?: (source: string, error: unknown) => void;
}

export interface TickReport {
  at: number;
  handled: Record<string, number>;
  errors: string[];
  nextAlarm: number | null;
}

export class Scheduler {
  private readonly o: Required<Omit<SchedulerOptions, 'nextMaintenance' | 'onSourceError'>> &
    Pick<SchedulerOptions, 'nextMaintenance' | 'onSourceError'>;
  private ticking = false;

  constructor(opts: SchedulerOptions) {
    this.o = { clock: Date.now, budgetPerSource: 200, ...opts };
  }

  /** The time the alarm should fire next, or null if nothing at all is scheduled. */
  nextWake(now = this.o.clock()): number | null {
    let next: number | null = null;
    let pending = false;
    for (const s of this.o.sources) {
      const due = s.nextDue(this.o.db, now);
      if (due === null) continue;
      pending = true;
      next = next === null ? due : Math.min(next, due);
    }
    if (pending) next = Math.min(next!, now + MAX_IDLE_WAKE_MS);
    const maint = this.o.nextMaintenance?.(now);
    if (maint !== undefined) next = next === null ? maint : Math.min(next, maint);
    return next === null ? null : Math.max(next, now);
  }

  /** Sets the alarm to `nextWake()`. During a tick this is left to the end of the tick. */
  async rearm(now = this.o.clock()): Promise<number | null> {
    if (this.ticking) return null;
    const next = this.nextWake(now);
    if (next === null) await this.o.storage.deleteAlarm();
    else await this.o.storage.setAlarm(next);
    return next;
  }

  /** Called after a commit that may have created earlier work (a hold, an outbox row, …). */
  async poke(due: number): Promise<void> {
    const current = await this.o.storage.getAlarm();
    if (current === null || due < current) await this.o.storage.setAlarm(Math.max(due, this.o.clock()));
  }

  /** The alarm handler. Sources run in order; one source failing does not stop the others. */
  async tick(): Promise<TickReport> {
    const now = this.o.clock();
    const handled: Record<string, number> = {};
    const errors: string[] = [];
    this.ticking = true;
    try {
      for (const s of this.o.sources) {
        try {
          handled[s.name] = await s.run(now, this.o.budgetPerSource);
        } catch (e) {
          errors.push(s.name);
          this.o.onSourceError?.(s.name, e);
        }
      }
    } finally {
      this.ticking = false;
    }
    const nextAlarm = this.nextWake(this.o.clock());
    if (nextAlarm === null) await this.o.storage.deleteAlarm();
    else await this.o.storage.setAlarm(nextAlarm);
    return { at: now, handled, errors, nextAlarm };
  }

  /** Backstop (§19.5): sets the alarm if it is missing. Returns true if it was missing. */
  async ensureAlarm(): Promise<boolean> {
    const current = await this.o.storage.getAlarm();
    if (current !== null) return false;
    const next = this.nextWake();
    if (next === null) return false;
    await this.o.storage.setAlarm(next);
    return true;
  }
}
