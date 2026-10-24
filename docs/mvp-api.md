# MVP API contract (preview)

The subset of §11 the MVP console uses. Base: `https://kairos-api-preview.lucky-shadow-edb4.workers.dev/v1/t/lotus-line/preview`. All requests carry `Authorization: Bearer <JWT>` from the demo sign-in service. Errors are `application/problem+json` with `code`, `detail`, `reasons[]` (each `{ code, message?, facts? }`) and `alternatives[]`. Times are UTC milliseconds; local display is America/New_York.

## Sign-in (demo, preview only)

`https://kairos-dev-idp.lucky-shadow-edb4.workers.dev`

- `GET /users` → `{ items: [{ sub, name, groups, studios }] }`
- `POST /token { sub, password }` → `{ token, user: { sub, name, groups, studios } }`. The token lasts 8 hours.

## Who am I

- `GET /me` → `{ subject, kind, roles: PlatformRole[], locations: string[] | null, resource: { id, name, roles } | null }`

## Config (exists)

- `GET /config/active` → `{ number, content_hash, epoch, document }`
- `GET /config/versions` → `{ items: [{ number, content_hash, state, effective_from, published_at, summary, rollback_of }] }`
- Drafts: `POST /config/drafts {yaml}`, `PATCH /config/drafts/{id}` (JSON Patch, `If-Match`), `POST …/validate`, `POST …/submit` (`If-Match`), `POST …/approve {summary}` (`If-Match`), `POST …/reject {reason}`, `POST /config/rollback {to_version, summary}`
- `GET /domain-modes` → `{ items: [{ domain, mode, outside_system, … }] }`

## Studios and people

- `GET /locations` → `{ items: [{ key, name, timezone }] }` (from the active config)
- `GET /people?role=desk_staff|teacher&location=` → `{ items: [{ id, staff_key, name, email, roles: string[], location_keys: string[], state }] }`
- `POST /directory/sync { people: [{ staff_key, name, email, groups: string[], studios?: string[] }] }` (owner/admin) → `{ created, updated }`

## Desk shifts (owned)

- `GET /shifts?week=YYYY-MM-DD&location=<key>` (week starts Monday, local date) →
  ```
  { week_start, location,
    slots: [{ slot_key, template_key, template_name, location_key, start, end,
              local: { date, start, end },            // "2027-03-08", "06:15", "12:45"
              state: 'open' | 'filled' | 'vacated',
              session_id: string | null,
              worker: { resource_id, name } | null }],
    coverage: [{ date, from, to, min, have }] }      // only segments where have < min
  ```
- `POST /shifts/assign { template_key, location_key, start, resource_id }` → the slot. Refusals are 409/422 problems with `code`: `RESOURCE_CONFLICT` (person busy, including a mirrored class they teach, or desk full), `ROLE_MISSING`, `OUTSIDE_AVAILABILITY` (time off), `REST_VIOLATION`, `MAX_HOURS`, `TRANSFER_TIME`.
- `POST /shifts/{session_id}/unassign` → `{ ok: true }` (removes the shift)
- `POST /time-off { resource_id, start, end, reason: 'sick'|'vacation'|'personal', immediate?: boolean }` → `{ id, state, vacated: [{ session_id, template_key, start }] }`. A sick call (`immediate`) vacates overlapping owned shifts (§3A.11.2).
- `GET /time-off?from&to` → `{ items: [{ id, resource_id, name, start, end, reason, state }] }`

## Classes (mirrored from BookingVendor)

- `GET /sessions?from=<ms>&to=<ms>&location=` → `{ items: [{ id, template_key, name, location_key, start, end, status, source: 'mirror'|'platform', teacher: { resource_id, name } | null, conflicted: boolean }] }`

## Hours and payroll export

- `GET /hours?from=<ms>&to=<ms>` → `{ items: [{ id, resource_id, name, kind, location_key, start, end, minutes, state }] }`
- `POST /hours/{id}/approve` → the record
- `GET /hours/export?period_start=YYYY-MM-DD` → `text/csv` Gusto employee CSV for the pay period (§18.8)
