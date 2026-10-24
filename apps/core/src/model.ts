// The active compiled config, cached in object memory per version number. The object is the only writer, so the
// cache is invalidated by number alone (§19.3).
import type { ConfigDocument } from '@kairos/config-schema';
import type { Tx } from '@kairos/db';
import { KairosError } from '@kairos/errors';
import { durationMs } from './time';

export type Doc = ConfigDocument;
export type TemplateDef = Doc['templates'][number];
export type LocationDef = Doc['locations'][number];

export interface ActiveConfig {
  number: number;
  doc: Doc;
  zoneOf(location: string): string;
  template(key: string): TemplateDef;
  /** Travel time between two studios in ms, or 0 when the same or unknown (§4.3). */
  transfer(from: string, to: string): number;
}

let cache: ActiveConfig | null = null;

export function activeConfig(tx: Tx): ActiveConfig {
  const row = tx.maybe<{ number: number; compiled: string }>(`SELECT number, compiled FROM config_version WHERE state = 'active'`);
  if (!row) throw new KairosError('NOT_FOUND', { message: 'no config has been published' });
  if (cache?.number === row.number) return cache;
  const doc = (JSON.parse(row.compiled) as { document: Doc }).document;
  const locations = new Map(doc.locations.map((l) => [l.key, l]));
  const templates = new Map(doc.templates.map((t) => [t.key, t]));
  cache = {
    number: row.number,
    doc,
    zoneOf: (key) => locations.get(key)?.timezone ?? doc.tenant.default_timezone,
    template: (key) => {
      const t = templates.get(key);
      if (!t) throw new KairosError('NOT_FOUND', { message: `template ${key}` });
      return t;
    },
    transfer: (from, to) => {
      if (from === to) return 0;
      const t = locations.get(from)?.transfer_times?.find((x) => x.to === to);
      return t ? durationMs(t.duration) : 0;
    },
  };
  return cache;
}

/** Test hook: forget the cached config. */
export const resetConfigCache = (): void => {
  cache = null;
};
