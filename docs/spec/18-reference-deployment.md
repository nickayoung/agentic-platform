# 18. Reference deployment: Lotus & Line Yoga

## 18.1 The tenant today

| Item | Facts used in this spec |
|---|---|
| Studios | Park Slope (Studio 1: 30 mats; Studio 2, heated: 24 mats), Williamsburg (36 mats), Dumbo (28 places, no mat map). All in `America/New_York` |
| People | About 40 teachers and about 25 desk staff. Some do both |
| Outside systems | **BookingVendor** is the record for classes, bookings, members, memberships and payments. **ShiftTool** holds desk shifts. **Gusto** pays staff. Kairos hands it hours as a CSV file that a manager uploads (§18.8) |
| Front ends | Public website; desk operations app (web, plus a desktop app at each front desk); staff portal (web, plus a phone app) |
| Shared services | Member sign-in, staff sign-in, gateway, notification service, help-article base, typed contracts |

The studio names, sizes and outside-system names in this table are the reference values the spec uses. Everything else about the tenant (API details, group names, labour rules) is an open question (Q-11, Q-03). Its config is §4b.1.

The gateway system keys are: `booking_vendor`, `shift_tool`, `payments` (the card processor), `calendar`, `llm`, `staff_directory`. Gusto has no gateway key, because Kairos makes no calls to Gusto (§18.8).

## 18.2 Onboarding the tenant

The tenant is onboarded using the procedure in §3A.3. Specific to this tenant:

1. Config starts from `yoga_starter.yaml`. The owner's description (eval case Y-REF-01) is turned into `lotus_line.yaml`.
2. All four domains start in `mirror`. ShiftTool backfills −8 to +8 weeks of desk shifts. BookingVendor backfills −26 weeks to +90 days of classes and bookings, plus all active members.
3. Every BookingVendor instructor ID is mapped to a staff person, by email first and manually after that (§18.5). Go-live requires every mapping to be complete.
4. After the go-live checklist passes, Phase 1 starts: `shifts` goes mirror → **shadow** for 14 days, then → **owner** through the gate in §18.7 (flag `sync.shifts.owner`, D-47).

## 18.3 Fitting beside the shared services

| Service | How Kairos uses it | What Kairos does not do |
|---|---|---|
| Member sign-in | Validates JWTs; maps `sub` → `Customer`; links to mirrored members by verified email | Store passwords or sessions |
| Staff sign-in and directory | Validates JWTs; maps groups → roles; handles `person.created` and `person.deactivated` through the gateway, with a nightly sync as backstop; supplies the emails used for person mapping | Hold staff credentials |
| Gateway | Every outbound call (BookingVendor, ShiftTool, payments, calendar, LLM, directory). Kairos authenticates with its own service identity, and the gateway adds the outside credentials. Inbound events arrive at `POST /sync/inbound/{system}`, signed. Credential rotation for outside systems happens in the gateway and needs no Kairos change. Adding or removing an integration means adding or removing a gateway route; the Kairos side is a `DomainModeSetting` or flag change | Hold any outside key |
| Notification service | Every message: workflows, offers, confirmations, export links. Recipients are references (`customer:…`, `staff:…`) that the notification service resolves | Send email, SMS, push or chat directly |
| Help-article base | Read by the member and staff assistants. Scheduling policy answers come from `GET /policies/{key}/text`, so they match the live config | Store help content |
| Typed contracts | OpenAPI and JSON Schema event contracts in `packages/contracts`. The services above are consumed the same way | Read another service's database |
| **Calendar sync** (staff) | One-way push of each opted-in person's confirmed assignments (classes and desk shifts) through `gateway/calendar`. Event ID = assignment ID. Changes are re-pushed; releases, opt-outs and offboarding delete the events | Read staff calendars |

**What Kairos requires of these services:**
- The notification service and the gateway must deduplicate on `Idempotency-Key` for at least 7 days.
- The gateway must sign inbound events with a timestamp.
- The gateway must have a preview mode that never reaches production endpoints.
- The gateway must have an admin contract to remove a tenant's routes when the tenant is offboarded.

## 18.4 Front ends

None of the front ends contains scheduling logic. They render what the API returns: availability, reasons, alternatives, quotes and confirmations.

### Public website

| Feature | API |
|---|---|
| Timetable | `GET /sessions?…&include=availability`. Anonymous requests are edge-cached; signed-in requests get personalised eligibility and price |
| Mat map | `GET /sessions/{id}/places`, showing mat states, partition badges and waitlist-reserved mats |
| Book | `POST /holds` → quote and terms (waiver or intake if required) → `POST /bookings` (for price payments, the processor's hosted step comes first) |
| Cancel | `POST /bookings/{id}/cancel {preview: true}` → shows the penalty → `POST /bookings/{id}/cancel` (or the confirmation flow for agents, §11.6) |
| Waitlist | `POST /sessions/{id}/waitlist`. Offer links call `POST /offers/{id}/accept`, which returns a hold, then `POST /bookings` confirms |
| Account page | `GET /customers/me`, `GET /bookings?customer_id=me`, `GET /waitlist-entries?customer_id=me`, `GET /customers/me/entitlements`, `POST /entitlements/{id}/freeze`, `POST /entitlements/{id}/cancel`, `POST /customers/me/close`, `POST /customers/me/export` |
| Checkout (packs and memberships) | Phases 1–4: BookingVendor's embedded checkout. Phase 5: processor checkout plus `POST /entitlements` |
| AI chat assistant | Member support assistant (§18.4.4) |

### Desk operations app

| Feature | API |
|---|---|
| Support inbox | The desk app owns the inbox. Kairos provides member context, decisions and H4 drafts |
| Who is on the desk now | `GET /desk/now?location=` |
| Today's classes and rosters | `GET /sessions?…&include=assignments,places_summary`, `GET /sessions/{id}/roster`, `GET /sessions/{id}/waitlist` |
| Check-ins | `POST /check-ins {client_key}`, with an offline queue in the desktop app. Walk-ins: `POST /customers` (guest) → hold and booking on the `desk` channel |
| Checklists and reminders | `GET /tasks?list=desk_checklist…`, `POST /tasks/{id}/complete` |
| Mat out of service | `POST /resources/{mat}/blocks {preview: true}` → shows re-seats → `POST /resources/{mat}/blocks` |

### Staff portal (web and phone app)

| Feature | API |
|---|---|
| My shifts and classes | `GET /assignments?resource_id=me` (each item shows its `source`) |
| Substitute offers | `GET /offers?recipient=me` → accept or decline |
| Swaps | `POST /swaps` → `POST /swaps/{id}/accept` → manager `POST /swaps/{id}/approve` or `/reject` |
| Time off and sick calls | `POST /time-off` (`immediate: true` for sick); managers `POST /time-off/{id}/approve` / `/reject` |
| Availability | `GET`/`POST /resources/me/availability`, `DELETE /resources/me/availability/{avl}` |
| Time clock (later) | `POST /time-clock/punches` |
| **Managers:** desk roster | `POST /rosters/solve {scope: {roles: [desk_staff]}}` → proposal → `POST /proposals/{id}/ops` edits → approve = publish |
| **Managers:** teacher schedule | Same flow with `roles: [teacher]`. Until classes are owned, the result is a set of write-through teacher changes to BookingVendor |
| **Managers:** class edits | `PATCH /sessions/{id} {…, preview: true}` → impact → commit with `acknowledge` (§3A.9.2) |
| **Managers:** hours | `GET /hours`, `PATCH /hours/{id}`, `POST /hours/{id}/approve`, exports (§18.8) |
| **Managers:** studio closures, staff offboarding, member suspensions and merges | §11.3 |

### 18.4.4 Runtime agents

**Member support assistant** (web chat, email, SMS):
- "Hot class with Maya Thursday evening, by the wall" → H1 → `GET /sessions` → hold on a wall mat → book with a credit while free cancellation is open (allowed directly, §10.1).
- "Cancel tonight" when inside 12 h → preview → confirmation card or signed link.
- "Why can't I book?" → H2.
- Policy questions → policy text plus help articles.

**Staff assistant** (desk app and portal):
- "Who's teaching the 6 pm?" → sessions with assignments, including the source and its freshness.
- "Put Sam on Friday's Dumbo closing shift" → a proposal, validated immediately.
- Inbox drafts through H4.

**Substitute finder**: §8.6 and §10.4.

## 18.5 Domain modes and data contracts

| Domain | Kairos entities | Outside record before owner |
|---|---|---|
| `classes` | class sessions, teacher assignments, rooms and template mapping | BookingVendor |
| `bookings` | bookings, place claims, waitlist, check-ins | BookingVendor |
| `members` | customers, entitlements, ledger, payment references | BookingVendor (+ processor) |
| `shifts` | desk-shift sessions, worker assignments, availability, time off, swaps | ShiftTool |

**Contract per mode:**

| | Mirror | Shadow | Owner |
|---|---|---|---|
| Record | Outside system | Outside system | Kairos |
| Reads | Kairos copy (`source = mirror`) with `stale_since` | Kairos copy | Kairos |
| Writes | Local pre-checks (permissions, member state, **cross-domain occupancy**, write freeze) → write-through via gateway; the outside answer is final; the copy is updated from it | As mirror, and Kairos also decides first and logs disagreements | Kairos decides and commits; pushes out if `outbound_push` |
| Refresh | Events (near real time) + timers: next 14 days every 5 min, days 15–60 hourly, everything nightly | Same | Push verification only |
| Copy vs outside conflicts | Outside wins (auto-resolved), except `cross_domain_conflict` and `unmapped_person` (manual) | Outside wins; logged | Kairos wins; re-push; `push_failed` after 3 attempts |
| Outside outage | Writes `OUTSIDE_UNAVAILABLE`; reads stale with banner (§7.12) | Same | Pushes queue in the outbox for 24 h |
| During a switch | `write_freeze` → `WRITE_FROZEN` with `Retry-After`; inbound events are buffered and applied after the switch | | |

**Canonical fields** (hashed for drift detection):
- **classes:** external ID, template key, studio, room, start and end (UTC), status, **teacher external ID → person mapping**, capacity.
- **bookings:** external ID, class, member, status, mat label, checked-in, booked-at.
- **members:** external ID, email blind index, product key, status, starts and ends, credit balance.
- **shifts:** external ID, studio, start, end, role, staff key, status.

**Code mapping** (in `kairos-sync`): outside class types map to template keys (e.g. "VIN60" → `vinyasa_60`), and outside rooms map to room keys. An unmapped code raises `field_mismatch`, and the record is stored with `template_key = 'unmapped'`. Its room claim is still written.

**Shift mapping** (H-26): a ShiftTool shift maps to the desk template whose `starts` entry matches its studio, weekday and local start time and whose `duration` equals the shift's length. Its worker maps through `staff_key`, and its desk lane claim goes on the studio's front desk. A shift that matches no template is stored with `template_key = 'unmapped'` and raises `field_mismatch`. Its worker claim is still written, so the shift keeps blocking the person's time.

**Person mapping** (`person_mapping`, §3.11), for the teachers of mirrored classes:
1. On the first sighting of a BookingVendor instructor ID, match it to a person by directory email. If exactly one person matches, the mapping is set with `match: email`.
2. Otherwise the mapping is `unmatched`. The mirrored class is stored with `status = needs_mapping`, and an `unmapped_person` drift item alerts managers (§4b.1 `cross_domain_alert`).
3. **While a class is unmapped, the validator refuses any desk assignment, at any studio, for a person with the `teacher` role, if it overlaps `[class.occ_start − max transfer time, class.occ_end + max transfer time]`.** The refusal is `RESOURCE_CONFLICT` with the reason "unmapped teacher". Kairos doesn't know who the teacher is, so every teacher is a possible match (D-26). Desk workers without the `teacher` role are not affected. The solver gets the same rule through `unmapped_blocks` (§8.3).
4. A manager fixes the mapping in the portal (`PUT /sync/person-mappings/…`). The class's teacher claim is then written onto the person, and the class becomes `scheduled`.

### 18.5.1 Staff and lifecycle writes by mode

What Kairos does for each staff, member and lifecycle write in each mode is the domain-mode matrix in **§3A.2**. The cross-domain rule for events such as a class cancel while bookings are mirrored is §3A.1 C4.

**Allowed mode combinations.** A domain may be `owner` only once its dependencies are `owner`:
- shifts: no dependencies;
- classes: no dependencies (classes are pushed to BookingVendor);
- bookings: requires classes;
- members: requires bookings. While members is still mirrored, owned bookings write their debits through as a saga: hold → debit → confirm, releasing on failure.

## 18.6 Drift detection

1. **Event compare.** Each inbound event (deduplicated per §12.6) is fetched, mapped, hashed, and compared with the copy.
2. **Window scans.** Timer-driven scans compare ID sets and hashes over each window.
3. **Bucket checksums.** Every night, for each domain and each local day from −30 to +60 days, compute `(count, sha256(sorted(id‖hash)))` on both sides. Drill into any day that differs.
4. **Push verification** in owner mode: read back after write. A mismatch after 5 min raises `push_failed`.
5. **Cross-domain conflicts and unmapped people**, raised during mirror ingestion.

**Alerts:** any `cross_domain_conflict` or `unmapped_person`; drift above 0.5 % for 1 h; any item open more than 24 h; staleness above 15 min.

**Repair.** Mirror and shadow: auto-resolve toward the outside system, except the manual kinds. Owner: re-push. Manual items are fixed in the portal; each fix is a normal API write, so it is validated.

**Staleness guard for staff writes.** Before any assignment or roster commit for people who have mirrored claims, Kairos does a **targeted pull** of their affected days from BookingVendor (≤ 5 s). If BookingVendor can't be reached and the data is more than 15 min old, the commit fails with `MIRROR_STALE`. A manager can override this, and the override is audited (Q-06).

## 18.7 Mode transitions and rollback

Every mode change is behind a flag and is audited. It follows the **two-person rule**: `POST /sync/domains/{d}/mode` creates a `domain_mode` proposal, and a **different** owner or admin approves it (`POST /proposals/{id}/approve`). The change takes effect only when that approval is applied.

**Mirror → shadow**
- *Gate:* drift below 0.5 % for 7 days.
- *Procedure:* turn the flag on.

**What "disagreement" means per domain in shadow**

| Domain | Kairos computes | A disagreement is |
|---|---|---|
| classes | Occurrences from the timetable; built-in cancels (minimum attendance, unstaffed) | An occurrence on one side only; a cancel decided on one side only |
| bookings | The full pipeline for each write-through request; waitlist promotions; penalties; studio-cancel refunds | A different outcome (allowed vs denied), a different promoted member, a different fee or refund |
| members | Entitlement coverage, expiry, freeze and past-due | A different coverage verdict or balance |
| shifts | The person-rule validator on every ShiftTool shift and assignment; coverage per studio and day; hours per person and day | A ShiftTool assignment that the validator refuses (for example overlapping a mirrored class); a coverage shortfall ShiftTool doesn't show; hours that differ by more than 1 minute |

**Shadow → owner (cutover)**
- *Gate:* disagreement below 0.2 % for 14 days, all of it triaged; no drift item open more than 24 h; a preview rehearsal.
- *Procedure:*
  1. Set `write_freeze` (≤ 15 min); writes return `WRITE_FROZEN`.
  2. Drain inbound events.
  3. Fully reconcile the active window to zero drift.
  4. Set mode `owner` with `outbound_push`.
  5. Run smoke tests.
  6. Lift the freeze.

**Owner → mirror (rollback)**
- *Gate:* outside system not retired; push lag under 5 min; no `push_failed` items.
- *Procedure:*
  1. Set `write_freeze`.
  2. Drain the domain's outbox.
  3. Fully reconcile, pushing any records that exist only in Kairos. Records that can't be pushed are listed for manual entry.
  4. Set mode `mirror`.
  5. Re-enable inbound refresh.
  6. Lift the freeze.
- *Target:* ≤ 30 min.
- *Ordering:* rolling back `classes` requires `bookings` to be in mirror or shadow first.

**In-flight items** at a cutover or a rollback (holds, outside waitlists, pending penalties, imported terms, adoption of mirrored sessions into series, open proposals and offers) are handled per **§3A.18**.

**Owner → retired**
- *Gate:* at least 60 days in owner with no rollback, and owner sign-off.
- *Procedure:* outside writes stop and the setting becomes `retired = true`. Rollback is no longer possible.

**Source of truth during a switch.** While `write_freeze` is set, the outside system remains the record. The new mode takes effect in the same batch that clears the freeze.

## 18.8 Payroll export to Gusto (CSV)

Kairos stops at hours. It never holds pay rates, computes pay, or calls Gusto. For each pay period it produces CSV files in **Gusto's CSV upload format**. A manager downloads them and uploads them in Gusto's run-payroll screen (Gusto: *Upload employees' hours and earnings to payroll*). Gusto then applies pay rates, taxes and overtime pay.

### 18.8.1 Hours records

- **Lifecycle:** §3A.16. In short: records exist only for assignments in **owned** domains (desk shifts from the shifts cutover, teaching from the classes cutover, D-54); they are voided when the assignment is vacated or the session cancelled, unless the cancel was within `closure_pay_notice` (`pay_protected`, D-55); they become `worked` at session end, `approved` by a manager, and `exported` when the period is submitted.
- **Offboarded staff:** their hours up to the effective date are included and flagged `final` in the export summary.
- **Approval gate:** the export only includes `approved` records. If any record in the period is still `worked`, the export reports it, and the manager approves those records or excludes them explicitly.

### 18.8.2 What goes in the files

- **Employees and contractors.** Gusto uses different CSV templates for employees and contractors. Each person has `payroll_type: employee | contractor` (a person field, §3.4), so one export makes **up to two files**: `…_employees.csv` and `…_contractors.csv`. Many studios pay teachers as contractors (Q-15).
- **Employee file rows.** One row per **employee × workweek** inside the pay period. The workweek starts on `tenant.week_starts` and must match the workweek set in Gusto. The row's workweek column lets Gusto compute the regular rate across mixed work.
- **Hour columns.**
  - Regular, overtime and double-overtime hours are decimals with 2 places (`12.50`).
  - They are summed from elapsed minutes (I-28) and rounded half-up once per cell.
  - A person who does both desk work and teaching gets **one row per kind** when `payroll_export.split_by_kind` is true, so different Gusto pay rates can apply. Gusto must have a matching job or pay rate for each kind (Q-16). Otherwise everything goes in one row.
- **Overtime classification** (D-43). Kairos only *classifies* hours; Gusto prices them.
  - The rule comes from `payroll_export.overtime`. The default is the FLSA rule used in New York: weekly hours over 40 are overtime; no daily overtime.
  - When a week mixes desk work and teaching, overtime is assigned to the **chronologically last** hours of the workweek. This is deterministic, and it is the usual employer practice.
  - The rule is for legal confirmation (Q-03).
- **Contractor file.** One row per contractor for the pay period, giving hours worked only, with no wage. Gusto applies the contractor's hourly rate.
- **People identifiers.** Every person with hours in the period must have `payroll_ref`, the identifier Gusto's template matches on (Q-14). If any is missing, the export fails with `PAYROLL_REF_MISSING` and lists the people.
- **Columns Kairos owns vs the rest.**
  - Kairos fills only the columns mapped in `payroll_export.columns`.
  - It writes an explicit `0.00` in owned hour columns that have no hours, so a re-upload replaces earlier values. Gusto treats a zero as an overwrite and a blank as "leave unchanged".
  - It leaves every other template column **blank**, so bonuses, reimbursements and similar entries made in Gusto are untouched.
- **File format.**
  - RFC 4180 CSV, UTF-8, with no byte-order mark (BOM) and CRLF line endings.
  - The header row is the exact Gusto template header row, in the template's column order, stored in `payroll_export.template_headers`.
  - Rows are sorted by last name, first name, workweek start, then kind.
  - File name: `<tenant>_<env>_<period_start>_<period_end>_<employees|contractors>_v<n>.csv`. In preview, the name starts with `PREVIEW_`.

### 18.8.3 Config (locked; owner only)

```ts
interface PayrollExportSettings {                   // TenantSettings.payroll_export (§4.3)
  format: 'gusto_csv';
  pay_period: { frequency: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'; anchor: LocalDate };  // must match Gusto
  template_headers: { employees: string[]; contractors: string[] };   // copied verbatim from Gusto's downloaded templates
  columns: {                                        // Kairos field → Gusto header (must appear in template_headers)
    employees: { payroll_ref: string; last_name?: string; first_name?: string; workweek?: string;
                 job?: string;                      // required when split_by_kind: identifies the Gusto job / pay rate
                 regular_hours: string; overtime_hours?: string; double_overtime_hours?: string };
    contractors: { payroll_ref: string; last_name?: string; first_name?: string; hours: string };
  };
  overtime: { weekly_hours: number | null; daily_hours: number | null; daily_double_hours: number | null };
  split_by_kind: boolean;
  job_names?: { shift: string; teaching: string };  // the values written in the job column; must match Gusto job titles
}
```

Validation:
- Every mapped header must exist in `template_headers` (`PAYROLL_HEADER_UNKNOWN`).
- `split_by_kind: true` requires `columns.employees.job` and `job_names` (`PAYROLL_JOB_COLUMN_MISSING`). Without a job column, two rows for one person and workweek would be ambiguous in Gusto.
- `weekly_hours` must be at least the highest `max_hours/week` rule in the config, or the warning `PAYROLL_OT_BELOW_ROSTER_CAP` is shown.

The values in §4b.1 are **placeholders**. They are replaced with the headers from the tenant's own downloaded templates at onboarding (Q-14). Gusto's help pages don't publish the header list, so it must be taken from the template itself.

### 18.8.4 Producing, correcting and re-exporting

1. `POST /exports/hours {period_start, period_end}` (manager or owner) checks that the period matches `pay_period`. It builds the files from approved records and returns `{export_id, version, summary}`. The summary gives totals per person, per kind and per workweek, plus every overtime row and every warning.
2. `GET /exports/hours/{id}/files/{employees|contractors}` returns a signed download URL that is valid for 24 h. The files contain names and identifiers, so they are treated as PII: they are kept 30 days, and every download is audited (§13.3).
3. **Before upload:** a manager can fix hours and export again. That creates a new version, `v2`, built completely from the current approved hours. Uploading it in Gusto replaces the earlier entries, because Gusto overwrites prior uploads for the same payroll.
4. `POST /exports/hours/{id}/mark-submitted` (after the manager runs the payroll in Gusto) moves its records to `exported` and locks the period.
5. **After submission:** a change to hours in a locked period is never folded into a later period's file, because that would misstate its workweek and overtime. Instead:
   - Kairos writes an adjustment row to `GET /exports/hours/{id}/corrections.csv`, with the person, workweek, kind, old hours, new hours and reason;
   - it creates a `manager_inbox` task to enter the correction in Gusto (an off-cycle payroll or an adjustment);
   - the correction is marked done with `POST /exports/hours/{id}/corrections/{c}/done`.
6. Exports are deterministic: the same approved records always produce byte-identical files, which is checked by golden-file tests (§14.1). An example file is at `fixtures/exports/gusto_employees.example.csv`.

### 18.8.5 Which system sends each kind of hours to Gusto (D-36)

Kairos exports only the kinds it is the source for, so nobody is paid twice:

| Phase (§15) | Desk hours (`kind: shift`) | Teaching hours (`kind: teaching`) |
|---|---|---|
| Before Phase 1 | ShiftTool, or however desk hours reach Gusto today | The current system, as today (Q-13) |
| 1–2 | **Kairos**, from the shifts cutover date. ShiftTool's hours stop going to Gusto on that date. During the 60-day push period, ShiftTool receives shifts but its hours are not uploaded | Current system |
| 3 onwards | Kairos | **Kairos**, from the classes cutover date. The current teaching-hours feed stops on that date |

The cutover date is an export boundary: hours whose `scheduled_start` is before it belong to the old system. If a pay period straddles the cutover, Kairos exports only its side, and the summary says so. The Phase 1 parallel-run check (§15) compares Kairos's desk hours against ShiftTool's **computed** hours. Only Kairos's file is uploaded.

## 18.9 Cutover order

| Phase (§15) | classes | bookings | members | shifts |
|---|---|---|---|---|
| 1 | mirror | mirror | mirror | **shadow** (14 days) → **owner** (ShiftTool kept current by push for 60 days) |
| 2 | shadow | shadow | mirror | owner |
| 3 | **owner** | shadow | mirror | owner (ShiftTool retired) |
| 4 | owner | **owner** | mirror | owner |
| 5 | owner | owner | shadow → **owner** | owner (BookingVendor retired after 60 days) |

**Phase 1, after the shifts cutover, is the acceptance-test configuration.** Classes are mirrored while desk shifts are owned. Appendix A.5 shows the refusal in all three orders. The refusal also holds during the 14-day shifts shadow, because the validator is always on (§3A.2). There it is reported as a disagreement on ShiftTool's shift rather than a refused Kairos write.
