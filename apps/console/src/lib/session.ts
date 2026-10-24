// The staff session: the bearer token and who it belongs to. Held in memory and mirrored to sessionStorage (so a
// reload keeps you signed in, a new tab does not). Storage can throw (private windows, blocked site data), so every
// access is guarded and the console still works from memory alone.
import { useSyncExternalStore } from 'react';
import type { IdpUser } from './types';

export interface Session { token: string; user: IdpUser; expiresAt: number }

const KEY = 'kairos.console.session';
let session: Session | null | undefined; // undefined: not yet read from storage
const listeners = new Set<() => void>();

function expiry(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : Date.now() + 8 * 3600_000;
  } catch {
    return Date.now() + 8 * 3600_000;
  }
}

function load(): Session | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function getSession(): Session | null {
  if (session === undefined) session = load();
  if (session && session.expiresAt <= Date.now()) {
    // expired: forget it quietly (this runs during render, so no listener calls)
    session = null;
    store(null);
  }
  return session ?? null;
}

function store(next: Session | null): void {
  try {
    if (next) window.sessionStorage.setItem(KEY, JSON.stringify(next));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // memory only
  }
}

function publish(next: Session | null): void {
  session = next;
  store(next);
  for (const l of listeners) l();
}

export function startSession(token: string, user: IdpUser): Session {
  const s = { token, user, expiresAt: expiry(token) };
  publish(s);
  return s;
}

export function clearSession(): void {
  if (session === null) return;
  publish(null);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, getSession, () => null);
}
