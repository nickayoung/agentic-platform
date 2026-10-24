// Mirror ingestion (§12.1, §18.5): kairos-sync hands BookingVendor classes to TenantCore through RPC, so mirrored
// claims pass the same occupancy table as owned ones (I-17). The outside system is the record; Kairos never refuses
// a mirrored class. A claim that collides is stored `conflicted`, keeps its time blocked, and is reported as drift.
import { canonicalJson, GRAIN_MS, ingestMirrorClaim, releaseClaim, sha256Hex, type Tx } from '@kairos/db';
import { emitEvent } from './events';
import type { ActiveConfig } from './model';
import { durationMs } from './time';

export interface MirrorClass {
  external_id: string;
  template_key: string;                 // already mapped from the outside class code by kairos-sync (code_mapping)
  location_key: string;
  room_key: string | null;
  start: number;
  end: number;
  status: 'scheduled' | 'cancelled';
  teacher: { external_id: string; email: string | null; name: string } | null;
}

export interface MirrorResult {
  applied: number;
  unchanged: number;
  conflicts: { external_id: string; resource: string; session_id: string }[];
  unmapped: { external_id: string; teacher_external_id: string; name: string }[];
}

const SYSTEM = 'booking_vendor';
const id = (p: string) => `${p}_${crypto.randomUUID().replaceAll('-', '')}`;
const floorGrain = (ms: number) => Math.floor(ms / GRAIN_MS) * GRAIN_MS;
const ceilGrain = (ms: number) => Math.ceil(ms / GRAIN_MS) * GRAIN_MS;

/** Person mapping (§18.5): an existing mapping, else exactly one directory email match, else unmatched. */
function mapTeacher(tx: Tx, t: NonNullable<MirrorClass['teacher']>, now: number): string | null {
  const m = tx.maybe<{ resource_id: string | null; match: string }>(
    'SELECT resource_id, match FROM person_mapping WHERE system = ? AND external_person_id = ?', SYSTEM, t.external_id);
  if (m?.resource_id) return m.resource_id;
  if (m && m.match === 'manual') return null;
  const hits = t.email ? tx.all<{ id: string }>(`SELECT id FROM resource WHERE kind = 'person' AND email = ?`, t.email.toLowerCase()) : [];
  const resourceId = hits.length === 1 ? hits[0]!.id : null;
  tx.run(
    `INSERT INTO person_mapping (system, external_person_id, resource_id, match, matched_at, matched_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (system, external_person_id) DO UPDATE SET resource_id = excluded.resource_id, match = excluded.match,
       matched_at = excluded.matched_at, matched_by = excluded.matched_by`,
    SYSTEM, t.external_id, resourceId, resourceId ? 'email' : 'unmatched', resourceId ? now : null, resourceId ? '{"type":"system","component":"sync"}' : null,
  );
  return resourceId;
}

function releaseSessionClaims(tx: Tx, sessionId: string, now: number): void {
  for (const a of tx.all<{ id: string; claim_id: string | null }>(
    `SELECT id, claim_id FROM assignment WHERE session_id = ? AND state = 'confirmed'`, sessionId)) {
    if (a.claim_id) releaseClaim(tx, a.claim_id);
    tx.run(`UPDATE assignment SET state = 'released', updated_at = ? WHERE id = ?`, now, a.id);
  }
}

/** One class per call keeps each batch small (§19.2); kairos-sync calls this per changed record. */
export function applyMirrorClass(tx: Tx, cfg: ActiveConfig, c: MirrorClass, now: number, out: MirrorResult): void {
  const hash = sha256Hex(canonicalJson(c));
  const ref = tx.maybe<{ entity_id: string; content_hash: string }>(
    `SELECT entity_id, content_hash FROM external_ref WHERE system = ? AND entity_type = 'session' AND external_id = ?`, SYSTEM, c.external_id);
  if (ref?.content_hash === hash) {
    out.unchanged++;
    return;
  }
  const template = cfg.template(c.template_key);
  const zone = cfg.zoneOf(c.location_key);

  let sessionId: string;
  if (ref) {
    sessionId = ref.entity_id;
    releaseSessionClaims(tx, sessionId, now);
    tx.run(`UPDATE session SET template_key = ?, location_key = ?, start_at = ?, end_at = ?, zone = ?, status = ?, updated_at = ?,
              version = version + 1, cancel_reason = ? WHERE id = ?`,
      c.template_key, c.location_key, c.start, c.end, zone, c.status === 'cancelled' ? 'cancelled' : 'scheduled', now,
      c.status === 'cancelled' ? 'outside' : null, sessionId);
    tx.run(`UPDATE external_ref SET content_hash = ?, last_seen_at = ? WHERE system = ? AND entity_type = 'session' AND external_id = ?`,
      hash, now, SYSTEM, c.external_id);
  } else {
    sessionId = id('ses');
    tx.run(
      `INSERT INTO session (id, template_key, occurrence_key, location_key, start_at, end_at, zone, status, capacity_total,
         config_version, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'mirror', ?, ?)`,
      sessionId, c.template_key, `bv:${c.external_id}`, c.location_key, c.start, c.end, zone,
      c.status === 'cancelled' ? 'cancelled' : 'scheduled', cfg.number, now, now);
    tx.run(`INSERT INTO external_ref (id, system, entity_type, entity_id, external_id, content_hash, last_seen_at)
            VALUES (?, ?, 'session', ?, ?, ?, ?)`, id('ext'), SYSTEM, sessionId, c.external_id, hash, now);
  }
  out.applied++;
  if (c.status === 'cancelled') return;

  const claim = (requirementKey: string, resourceId: string, label: string) => {
    const req = template.requirements.find((r) => r.key === requirementKey);
    const before = req?.buffers?.before ? durationMs(req.buffers.before) : 0;
    const after = req?.buffers?.after ? durationMs(req.buffers.after) : 0;
    const asg = id('asg');
    const clm = id('clm');
    tx.run(`INSERT INTO assignment (id, session_id, requirement_key, resource_id, state, claim_id, assigned_by, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'confirmed', ?, '{"type":"system","component":"sync"}', 'mirror', ?, ?)`, asg, sessionId, requirementKey, resourceId, clm, now, now);
    const state = ingestMirrorClaim(tx, {
      id: clm, resourceId, ownerType: 'assignment', ownerId: asg, start: c.start, end: c.end,
      occStart: floorGrain(c.start - before), occEnd: ceilGrain(c.end + after), mode: 'exclusive', domain: 'classes', source: 'mirror',
    });
    if (state === 'conflicted') {
      out.conflicts.push({ external_id: c.external_id, resource: label, session_id: sessionId });
      emitEvent(tx, { name: 'sync.cross_domain_conflict', subject: { type: 'session', id: sessionId },
        data: { external_id: c.external_id, resource_id: resourceId, requirement_key: requirementKey } }, now);
    }
  };

  if (c.room_key) {
    const room = tx.maybe<{ id: string; name: string }>('SELECT id, name FROM resource WHERE config_key = ?', c.room_key);
    if (room) claim('room', room.id, room.name);
  }
  let status = 'scheduled';
  if (c.teacher) {
    const teacherId = mapTeacher(tx, c.teacher, now);
    if (teacherId) claim('teacher', teacherId, c.teacher.name);
    else {
      status = 'needs_mapping';
      out.unmapped.push({ external_id: c.external_id, teacher_external_id: c.teacher.external_id, name: c.teacher.name });
    }
  }
  tx.run('UPDATE session SET status = ? WHERE id = ?', status, sessionId);
}

export interface ClassRow {
  id: string;
  template_key: string;
  name: string;
  location_key: string;
  start: number;
  end: number;
  status: string;
  source: string;
  teacher: { resource_id: string; name: string } | null;
  conflicted: boolean;
}

export function listClasses(tx: Tx, cfg: ActiveConfig, from: number, to: number, location: string | null): ClassRow[] {
  const rows = tx.all<{ id: string; template_key: string; location_key: string; start_at: number; end_at: number; status: string;
    source: string; teacher_id: string | null; teacher_name: string | null; conflicted: number }>(
    `SELECT s.id, s.template_key, s.location_key, s.start_at, s.end_at, s.status, s.source,
            a.resource_id AS teacher_id, r.name AS teacher_name,
            EXISTS (SELECT 1 FROM assignment a2 JOIN claim c ON c.id = a2.claim_id
                     WHERE a2.session_id = s.id AND a2.state = 'confirmed' AND c.state = 'conflicted') AS conflicted
       FROM session s
       LEFT JOIN assignment a ON a.session_id = s.id AND a.requirement_key = 'teacher' AND a.state = 'confirmed'
       LEFT JOIN resource r ON r.id = a.resource_id
      WHERE s.start_at >= ? AND s.start_at < ? AND (? IS NULL OR s.location_key = ?) AND s.capacity_total >= 0
        AND s.template_key IN (SELECT value FROM json_each(?))
      ORDER BY s.start_at`,
    from, to, location, location, JSON.stringify(cfg.doc.templates.filter((t) => t.participants.who !== 'none').map((t) => t.key)),
  );
  return rows.map((r) => ({
    id: r.id, template_key: r.template_key, name: (() => { try { return cfg.template(r.template_key).name; } catch { return r.template_key; } })(),
    location_key: r.location_key, start: r.start_at, end: r.end_at, status: r.status, source: r.source,
    teacher: r.teacher_id ? { resource_id: r.teacher_id, name: r.teacher_name ?? '' } : null, conflicted: r.conflicted === 1,
  }));
}
