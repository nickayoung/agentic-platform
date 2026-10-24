// Response shapes from docs/mvp-api.md. Times are UTC milliseconds unless a field says "local".

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  reasons?: ({ code: string; message?: string; facts?: Record<string, unknown> } & Record<string, unknown>)[];
  alternatives?: unknown[];
  issues?: { path?: (string | number)[]; message?: string }[];
  request_id?: string;
}

export interface IdpUser { sub: string; name: string; groups: string[]; studios?: string[] }

export interface Me {
  subject: string;
  kind: string;
  roles: string[];
  locations: string[] | null;
  resource: { id: string; name: string; roles: string[] } | null;
}

export interface Location { key: string; name: string; timezone?: string }

export interface Person {
  id: string;
  staff_key: string;
  name: string;
  email: string;
  roles: string[];
  location_keys: string[];
  state: string;
}

export type SlotState = 'open' | 'filled' | 'vacated';

export interface ShiftSlot {
  slot_key: string;
  template_key: string;
  template_name: string;
  location_key: string;
  start: number;
  end: number;
  local: { date: string; start: string; end: string };
  state: SlotState;
  session_id: string | null;
  worker: { resource_id: string; name: string } | null;
}

export interface CoverageGap { date: string; from: string; to: string; min: number; have: number }

export interface ShiftWeek { week_start: string; location: string; slots: ShiftSlot[]; coverage: CoverageGap[] }

export type TimeOffReason = 'sick' | 'vacation' | 'personal';

export interface TimeOff { id: string; resource_id: string; name: string; start: number; end: number; reason: string; state: string }

export interface TimeOffResult { id: string; state: string; vacated: { session_id: string; template_key: string; start: number }[] }

export interface ClassSession {
  id: string;
  template_key: string;
  name: string;
  location_key: string;
  start: number;
  end: number;
  status: string;
  source: 'mirror' | 'platform';
  teacher: { resource_id: string; name: string } | null;
  conflicted: boolean;
}

export interface HoursRecord {
  id: string;
  resource_id: string;
  name: string;
  kind: string;
  location_key: string;
  start: number;
  end: number;
  minutes: number;
  state: string;
}

export interface ConfigActive { number: number; content_hash: string; epoch: number; document: Record<string, unknown> }

export interface ConfigVersion {
  number: number;
  content_hash: string;
  state: 'staged' | 'active' | 'superseded';
  effective_from: number;
  published_at: number;
  summary: string;
  rollback_of: number | null;
}

export interface ValidationIssue { layer: string; code: string; severity: string; path: string; message: string }

export interface ConfigDraft {
  id: string;
  base_number: number | null;
  state: 'editing' | 'validated' | 'awaiting_approval' | 'published' | 'abandoned';
  version: number;
  document: Record<string, unknown>;
  validation: { ok: boolean; issues: ValidationIssue[] } | null;
  impact: { groups: unknown[] } | null;
}

export interface DomainMode {
  domain: string;
  mode: string;
  outside_system: string | null;
  outbound_push?: boolean;
  retired?: boolean;
  write_freeze?: boolean;
  version?: number;
}

export interface Items<T> { items: T[] }
