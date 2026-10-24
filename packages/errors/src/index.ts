// Reason codes (§7.9) and the one error type Kairos throws on purpose (§19.11).

export const REASON_STATUS = {
  PLACE_TAKEN: 409,
  HOLD_EXPIRED: 409,
  SESSION_FULL: 409,
  SESSION_CHANGED: 409,
  OFFER_FILLED: 409,
  RESOURCE_CONFLICT: 409,
  STALE_VERSION: 409,
  INSUFFICIENT_UNITS: 422,
  LIMIT_REACHED: 422,
  TOO_LATE_TO_CANCEL: 422,
  MOVE_NOT_ALLOWED: 422,
  PAYMENT_FAILED: 402,
  IMPACT_UNACKNOWLEDGED: 422,
  CONFIRMATION_STALE: 409,
  OUTSIDE_AVAILABILITY: 422,
  SKILL_MISSING: 422,
  ROLE_MISSING: 422,
  REST_VIOLATION: 422,
  MAX_HOURS: 422,
  MAX_ASSIGNMENTS: 422,
  TRANSFER_TIME: 422,
  CONSECUTIVE_DAYS: 422,
  MIRROR_STALE: 409,
  DOMAIN_NOT_OWNED: 409,
  OUTSIDE_UNAVAILABLE: 503,
  WRITE_FROZEN: 503,
  TENANT_MISMATCH: 403,
  IDEMPOTENCY_MISMATCH: 422,
  SCHEMA_INVALID: 422,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
} as const;

export type ReasonCode = keyof typeof REASON_STATUS;

export interface Reason {
  code: ReasonCode;
  message?: string;
  config_path?: string;
  facts?: Record<string, unknown>;
}

export class KairosError extends Error {
  readonly code: ReasonCode;
  readonly status: number;
  readonly reasons: Reason[];
  readonly alternatives: unknown[];

  constructor(code: ReasonCode, opts: { message?: string; reasons?: Reason[]; alternatives?: unknown[] } = {}) {
    super(opts.message ?? code);
    this.name = 'KairosError';
    this.code = code;
    this.status = REASON_STATUS[code];
    this.reasons = opts.reasons ?? [];
    this.alternatives = opts.alternatives ?? [];
  }
}

export const isKairosError = (e: unknown): e is KairosError => e instanceof KairosError;
