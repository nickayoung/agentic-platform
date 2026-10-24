// Query definitions for every read the console makes, so keys stay consistent and mutations can invalidate them.
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, isUnavailable } from './api';
import { getSession } from './session';
import type {
  ClassSession, ConfigActive, ConfigDraft, ConfigVersion, DomainMode, HoursRecord, Items, Location, Me, Person, ShiftWeek, TimeOff,
} from './types';

/** Don't retry answers that won't change on retry (missing endpoint, no access, bad request). */
function retry(count: number, e: unknown): boolean {
  if (e instanceof ApiError && e.status >= 400 && e.status < 500) return false;
  return count < 2;
}

export const queryDefaults = { retry, staleTime: 30_000, refetchOnWindowFocus: true } as const;

export const meQuery = () => queryOptions({ queryKey: ['me'], queryFn: () => api<Me>('/me'), staleTime: 5 * 60_000 });

export interface Locations { items: Location[]; source: 'api' | 'config' | 'session' }

const prettyKey = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Studios. `GET /locations` is the contract; until it is deployed, read them from the active config (owner and
 * admin only), and failing that from the studios on the signed-in user's token.
 */
export const locationsQuery = () => queryOptions({
  queryKey: ['locations'],
  staleTime: 10 * 60_000,
  queryFn: async (): Promise<Locations> => {
    try {
      return { items: (await api<Items<Location>>('/locations')).items, source: 'api' };
    } catch (e) {
      if (!isUnavailable(e)) throw e;
    }
    try {
      const doc = (await api<ConfigActive>('/config/active')).document as { locations?: Location[] };
      if (doc.locations?.length) return { items: doc.locations.map(({ key, name, timezone }) => ({ key, name, timezone })), source: 'config' };
    } catch {
      // fall through
    }
    return { items: (getSession()?.user.studios ?? []).map((key) => ({ key, name: prettyKey(key) })), source: 'session' };
  },
});

export const peopleQuery = (role?: string, location?: string) => queryOptions({
  queryKey: ['people', role ?? null, location ?? null],
  queryFn: () => api<Items<Person>>('/people', { query: { role, location } }),
});

export const shiftsQuery = (week: string, location: string) => queryOptions({
  queryKey: ['shifts', location, week],
  queryFn: () => api<ShiftWeek>('/shifts', { query: { week, location } }),
});

export const sessionsQuery = (from: number, to: number, location?: string) => queryOptions({
  queryKey: ['sessions', from, to, location ?? null],
  queryFn: () => api<Items<ClassSession>>('/sessions', { query: { from, to, location } }),
});

export const timeOffQuery = (from: number, to: number) => queryOptions({
  queryKey: ['time-off', from, to],
  queryFn: () => api<Items<TimeOff>>('/time-off', { query: { from, to } }),
});

export const hoursQuery = (from: number, to: number) => queryOptions({
  queryKey: ['hours', from, to],
  queryFn: () => api<Items<HoursRecord>>('/hours', { query: { from, to } }),
});

export const configActiveQuery = () => queryOptions({ queryKey: ['config', 'active'], queryFn: () => api<ConfigActive>('/config/active') });
export const configVersionsQuery = () => queryOptions({ queryKey: ['config', 'versions'], queryFn: () => api<Items<ConfigVersion>>('/config/versions') });
export const domainModesQuery = () => queryOptions({ queryKey: ['domain-modes'], queryFn: () => api<Items<DomainMode>>('/domain-modes') });
export const draftQuery = (id: string) => queryOptions({ queryKey: ['config', 'draft', id], queryFn: () => api<ConfigDraft>(`/config/drafts/${id}`) });
