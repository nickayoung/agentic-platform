# Kairos spec v3.0: revision notes for review 3

**Inputs:** the brief; spec v2.1 + Gusto CSV (commit `3b59747`, the "version 1" of this revision); review 3 (`docs/reviews/review-3.md`, H-01 – H-28); product-owner answers. The product owner answered one question in this round: **keep yoga-only scope (D-25)**. No other answers were supplied, so every other "Decision the spec must make" uses the reviewer's recommended answer and is marked **Assumed, not confirmed** in §16.

**Output:** spec v3.0 in `docs/spec/` (part 4 of the deliverable: complete, with no references to earlier versions for content), fixtures, scenarios and evals updated to match. Spec v3.0 is the "version 2" the revision method asks for. It is numbered 3.0 because the repository already used 2.0 and 2.1.

## 1. Triage

| ID | Sev. | Action | Spec sections changed | Reason |
|---|---|---|---|---|
| H-01 | Blocker | Fix | §3A.1 C4, §3A.2, §3A.9.4, §3.6 I-14, §3.8.1, §7.1, §7.6, §7.13, §8.6, §15 Ph 3–4, §18.5.1, A.4, `a4_…`, §16 D-44, A-15 | Correct: §8.6 and Phase 3 acceptance required refunds that §7.13 forbids while bookings aren't owned |
| H-02 | Blocker | Fix | §4.6, §6.3, §4b.1, fixture, §15 Ph 0, A.1, §16 D-45/A-16, §17 Q-17, eval golden_ignore | Correct: verified by script. With 1 lane, Dumbo is uncoverable on Mon–Sat; with 2 lanes, every studio-day is coverable |
| H-03 | Blocker | Fix | §4.11, §8.3, §6.3, §4b.1, fixture, A.1, A.5, §16 D-46, eval Y-REF-01 | Correct: `min_rest` had no scope, so `desk_rest` covered every pair of claims |
| H-04 | Blocker | Fix | `a5_…`, `a4_…`, A.4, A.5, §14.1 | Correct: both variants contradicted the spec's own rules |
| H-05 | Major | Fix | §18.2, §18.7, §18.9, §15 Ph 1 and Ph 3, §16 D-47 | Correct: §18.9 skipped the §18.7 gate; the 60-day check didn't fit in an 8-week phase |
| H-06 | Major | Fix | §3.8, §3A.14, §8.6, §10.4, §11.3, §12.4, §12.8, §13.2, §14.1, §16 D-57 | Correct: two creators, no guard |
| H-07 | Major | Fix | **§3A (new)**, §3.12 → pointer, references in §1, §4, §4b, §6, §10, §11, §13–§16, §18, A | Correct: lifecycle matrix had 60 Partial/Missing cells |
| H-08 | Major | Fix | §3.10, §3A.16, §11.3, §12.7, §18.8.1, §16 D-54/D-55, §17 Q-20 | Correct |
| H-09 | Major | Fix | §3.8 TermsSnapshot, §3.8.1, §4.8, §7.6, §3A.12.7, §9.6, §4b.1, §16 D-48, §17 Q-18 | Correct |
| H-10 | Major | Fix | §3.6, §3A.9.2–9.3, §7.4, §7.9, §11.3, §18.4, §16 D-49 | Correct |
| H-11 | Major | Fix | §3.8 `end_reason`, §3A.13, §3A.7, §3A.9.4, §3A.9.6 | Correct |
| H-12 | Major | Fix | §3A.18, §3.8 `origin`, §18.7, §15 Ph 3–4, §16 D-53/D-60 | Correct |
| H-13 | Major | Fix | §4.12 `scope`, §5.3 `event.domain/source`, §9.2, §9.3, §6.3, §4b.1, §14.1, §16 D-51 | Correct: no workflow restriction existed |
| H-14 | Major | Fix | §11.2, §11.3, §18.4 | Correct: listed endpoints were missing or inconsistent |
| H-15 | Major | Fix | §3A Notify rows, §9.2 R column, §9.4 `event_people`, §6.3 `NOTICE_MISSING`, §4b.1 (+25 workflows) | Correct: the brief requires workflow actions to call the notification service |
| H-16 | Minor | Fix | §3.5 TimeOff, §3A.11, §16 D-52 | Correct |
| H-17 | Minor | Fix | §3.8.1, §3A.12.9, §7.9, §11.3, §16 D-50 | Correct |
| H-18 | Minor | Fix | §3.8.1, §7.8, §3A.12.4, §3A.9.6, §16 D-58 | Correct |
| H-19 | Minor | Fix | §12.5, §3A.9.6 | Correct |
| H-20 | Minor | Fix | §5.3, §9.2, §4b.1, fixture, §2 "Channel" | Correct |
| H-21 | Minor | Fix | §3.8, §12.4 | Correct |
| H-22 | Minor | Fix | §8.6, §3A.14, A.4 | Correct |
| H-23 | Minor | Fix | §6.1, §6.3, §6.9 | Correct |
| H-24 | Minor | Fix | §2 | Correct |
| H-25 | Minor | Fix | §7.7, §3A.13, §9.6, A.3, `a3_…`, §16 D-59 | Correct |
| H-26 | Minor | Fix | §18.5 shift mapping | Correct |
| H-27 | Minor | Fix | §15 Ph 1, Ph 3 | Correct |
| H-28 | Minor | Fix | §3.10 `template_key`, §14.1 lint, §16 D-56 | Correct |

No finding was rejected.

## 2. Change log

| Section | What changed | Finding IDs |
|---|---|---|
| §1–2 Overview, glossary | 20 new terms (dry run, write freeze, push, adoption, staleness guard, workflow run/scope, event domain, required notice, outbox, saga, lifecycle card, impact plan, studio cancel, unstaffed check, over capacity, `release_place`, hours record, channel); "Booking", "Offer", "Proposal", "Domain mode" sharpened; scope line points to §3A | H-24, H-20, H-07 |
| §3 Domain model | §3.12 replaced by a pointer to §3A. New fields: `TimeOff.decided_by/at`, `Session.cancel_reason/over_capacity`, `TermsSnapshot.origin`, `WaitlistEntry.end_reason`, `Offer.lapsed/proposal_id/end_reason` + storage mapping note, `HoursRecord.template_key/void_reason/pay_protected/final`. I-14, I-23 updated; I-28b added. Booking transitions: late price refund, rejection at start, mirrored cancels, move window | H-01, H-06, H-07, H-08, H-09, H-10, H-11, H-12, H-16, H-17, H-18, H-21, H-28 |
| **§3A Lifecycles (new)** | Card format and common rules C1–C7; domain-mode matrix (moved from §7.13 and §18.5.1); cards for tenant, studio, room/mat, staff, member, agent clients, class session (materialise, edit, over capacity, cancel, checks, start/end), desk shift, assignment/time off/swaps, hold/booking, waitlist/place offer, substitute offer/proposal, entitlement, hours, config version, domain-mode transitions with in-flight tables; failure-pattern summary | H-07, H-01, H-08, H-10, H-11, H-12, H-15, H-16 |
| §4 Config schema | Schema 2.1: `min_rest.from/to`, `refund.late`, `WorkflowDef.scope`, list form of `trigger.event`; lane-aware shift candidates note; `closure_pay_notice` meaning | H-03, H-09, H-13, H-02, H-08 |
| §4b Example configs + fixtures | `schema_version: "2.1"`; `db_desk` 2 lanes; scoped `desk_rest`; `refund.late: none`; `booked_via`; `cross_domain_alert` also on `push_failed`; 25 new workflows covering every required notice; notes explaining each change; starter's `NOTICE_MISSING` warnings | H-02, H-03, H-09, H-20, H-01, H-15 |
| §5 Expression language | `booking.booked_via` replaces `booking.channel`; `event.domain`, `event.source` | H-20, H-13 |
| §6 Config agent | Layers named L1–L6 (impact is L6); lane-aware `COVERAGE_UNCOVERABLE`; `NOTICE_MISSING` replaces `WAITLIST_SILENT`; `SCOPE_ALL_MEMBER_RECIPIENT`, `MIN_REST_SCOPE_UNKNOWN_TAG` | H-23, H-02, H-15, H-13, H-03 |
| §7 Booking engine | Timers point to §3A.9.5; step 3 refuses `over_capacity`; studio cancel and late refund rules; penalty steps split by payment method; reservation only for eligible waiting entries; auto-charge failure; approval at start; new reason codes `SESSION_CHANGED`, `MOVE_NOT_ALLOWED`, `OFFER_FILLED`, `PAYMENT_FAILED`, `IMPACT_UNACKNOWLEDGED`; §7.13 matrix moved to §3A.2 plus the mixed-domain rule | H-01, H-09, H-10, H-17, H-18, H-25, H-06 |
| §8 Rostering | Scoped `min_rest` encoding; 6 h boundary; engine-created proposal and `lapsed`; step 7 split by bookings mode | H-03, H-22, H-06, H-01 |
| §9 Workflow engine | Event list triggers; catalog rewritten with domain and required-notice columns and 20 new events; scope rule; `event_people` recipient; `location: session` fallback; `session_customers` on cancel; cancel action points to §3A.9.4; two new §9.6 variants | H-13, H-15, H-09, H-25, H-01 |
| §10 Runtime hooks | H3 loses `create_proposal`; `record_reply` semantics; H3 observes accepts; `offer.withdrawn` → filled notice; resumes on `lapsed` | H-06 |
| §11 Public API | `me` alias; body-only `preview`; session edit body; session waitlist; member waitlist list; entitlement cancel; swap reject; hours PATCH; substitute accept response; move window | H-14, H-10, H-06, H-08, H-17 |
| §12 Storage | Offer state CHECK, `proposal_id`, `end_reason`, scoped unique indexes (one accepted substitute per slot, one open place offer per entry); `saga` table; hours partial unique; counter lifecycle; hazard rows | H-06, H-21, H-07, H-08, H-19 |
| §13 Security | Section refs; per-event audit pointer; sub finder no longer proposes | H-07, H-06 |
| §14 Testing | New invariants (hours, accepted offers, no writes on unowned domains, sagas); concurrency rows (double accept, retime vs hold); mixed-mode and scope cases; lifecycle and config-rule suites; DSL keys `outside`, `send_offer`, `pays`; lint scope for `kind` | H-01, H-06, H-08, H-13, H-03, H-02, H-28, H-04 |
| §15 Delivery plan | Phase 0: schema 2.1, saga runner, lane-aware validator and L5 probe on the fixture. Phase 1: shifts shadow → owner, scope rule, revised hours gate. Phase 3: session edits, adoption, mixed-mode cancel, `invoke_hook` + H3, ShiftTool retirement gate. Phase 4: owner-mode A.3/A.4 suites and the cutover in-flight rules | H-05, H-27, H-01, H-12, H-02 |
| §16 Decisions | D-44 – D-60 (D-44 – D-55 assumed, not confirmed); A-15, A-16; §16.5 trace; old trace refs updated | all |
| §17 Questions, risks | Q-17 – Q-20; R-11, R-12 | H-02, H-09, H-01, H-08 |
| §18 Reference deployment | Shifts shadow in onboarding and cutover order; front-end API rows fixed; shift mapping; §18.5.1 table moved to §3A.2; shadow disagreement table per domain; in-flight pointer; hours lifecycle pointer | H-05, H-14, H-26, H-07, H-12, H-08 |
| Appendix A | A.1 rows for lanes, scoped rest, late refund, notices; A.3 two variants; A.4 accept batch, busy variant, Phase 3 trace; A.5 step 7 | H-02, H-03, H-09, H-25, H-06, H-01, H-04 |
| `fixtures/scenarios/` | A.3 +2 variants; A.4 fixed busy variant, explicit late offer, +3 variants (double accept, Phase 3, push fails); A.5 order-2 fix | H-04, H-01, H-06, H-09, H-25 |
| `evals/config-agent/cases.yaml` | Y-REF-01: scoped-rest assertions; `db_desk` lanes ignored in golden match | H-03, H-02 |
| README files | v3.0 status, contents (§3A), what changed, review links | — |

## 3. Acceptance traces against v3.0

Domain modes are stated per trace. Times are `America/New_York`.

### T1. The reference tenant expressed entirely through the schema: **Pass**

1. **Studios, rooms, layouts.** `locations` (3, one zone); `resources` (4 rooms, 3 desks); `layouts` `mats_30/24/36` with `generate` and `overrides` (front row, wall, walk-in). Dumbo has no layout and is selected by tag `no_map`. Schema: §4.3–§4.5.
2. **Class types.** `vinyasa_60` (mixed: `front_row_unlimited` releases at T−24h, `walk_in` desk-only until T−2h), `hot_75` (heated room, `hot_cert`, intake on first hot class), `flow_pooled_60` (`pooled_from_space`), `prenatal_60` (`pooled: 12`, intake). Schema: §4.6.
3. **Timetable.** 7 series with weekday and weekend RRULEs, an exdate, and a fixed `@staff:amara`. Validated by `TIMETABLE_CONFLICT` and `SERIES_OUTSIDE_HOURS`.
4. **Terms.** `class_policy`: window 14 d at 12:00; free cancel 12 h; late penalty (credit forfeited; $10 membership fee; waived if refilled); no-show penalty ($15, a strike); `refund: {timely: full, late: none, studio_cancel: full}`; limits; approval at 3 strikes in 90 d; minimum 3 at T−2h; unstaffed T−90m; waitlist auto then offers. Schema: §4.8 (2.1 adds `late`).
5. **Products.** Unlimited (freeze, cap 2/day), 10-pack (26 w), refund credit, intro month (first use). Schema: §4.9.
6. **Desk.** Three rostered templates with per-day, per-studio `starts`; every desk has 2 lanes; three hard coverage rules. **Lane-aware `COVERAGE_UNCOVERABLE`:** the check script over every studio × weekday finds all intervals coverable (with 1 Dumbo lane it would fail Mon–Sat; the tenant confirmed 2 seats, D-45).
7. **Labour rules.** `desk_week` (40 h, all work), `desk_rest` (10 h **closing → opening**, `min_rest.from/to`), `teach_day`, `teach_rest`, `transfer`, fairness, continuity, preferences, stability. Schema: §4.11 (2.1).
8. **Reactions.** 36 workflows; every required-notice event in §9.2 has one, so there's no `NOTICE_MISSING`; `tenant.member_messaging: kairos`, so Kairos sends every message (D-51).
9. **Access.** Issuers, role mappings, staff role mappings (placeholders, Q-11).
10. **No special-case code.** Engines read only requirements, capacity, scheduling, cost, policies, constraints and CEL. The `kind` lint (§14.1) allows only `packages/export`.
11. **Fixture discipline.** The YAML in §4b is byte-identical to `fixtures/configs/*.yaml` (CI check). Both parse; Phase 0 acceptance requires the real validator to pass L1–L4 and the L5 probe to be feasible with a seeded staff set.

Result: every owner requirement from Y-REF-01 maps to a schema element, and the two v2.1 failures (scoped rest, Dumbo coverage) are fixed. **Pass.**

### T2. Mat-hold race: **Pass**

Modes: bookings `owner` (Phase 4+). Engine concurrency tests run it from Phase 2.

1. Amy and Ben hold **Mat 12** (row 2, wall mat, `general`) on Tue 07:00 Vinyasa, Park Slope Studio 1, within 50 ms. Both pass checks 1–8.
2. The SessionGate orders them: Amy, then Ben.
3. Amy's batch upserts `place_claim` with `expires_at = now + 5m`. The scalar assert `holder_id = hold_a` → 1, and the assert "usable" (not disabled, not `reserved_for`) → 1. Commit → `201 {hold_id, expires_at, quote}`.
4. Ben's batch: the upsert's `WHERE` is false (Amy's hold is live), so no row changes. The assert → 0, `CHECK (ok = 1)` fails, and the batch rolls back → `409 PLACE_TAKEN` with alternatives `[Mat 18, Mat 24]` (equal attributes, nearest).
5. Gate down: single-writer SQLite gives the same order and outcome.
6. Amy abandons: at +5 min, `release_place` deletes the claim (guarded), marks the hold `expired`, reserves the mat only if an eligible waiting entry exists (D-59), and emits `place.released{hold_expired}`. A lost alarm is covered by the sweep or by the next upsert.
7. Amy confirms after expiry: the guard fails; one transparent re-hold; otherwise `409 HOLD_EXPIRED` and the authorisation is voided by outbox.
8. A staff retime racing Amy's confirm: either the confirm commits first and the booking moves with the session, or it gets `SESSION_CHANGED` (§14.1).

Fixture `a2_mat_race.yaml` asserts steps 2–6. **Pass.**

### T3. Late cancellation with waitlist promotion: **Pass**

Modes: bookings `owner`. Class Tue 9 Mar 18:30 Vinyasa, Williamsburg, 36/36. Waitlist #1 Dana (pack_10, 3 credits, prefers Mat 3), #2 Eli (unlimited). Cara (unlimited) holds Mat 3 (front row; released to `general` Mon 18:30). Cara's terms: free until 06:30; late penalty as T1 step 4.

| Time | Step |
|---|---|
| 08:00:00 | Cara cancels. 08:00 ≥ 06:30 → **late** (§3A.12.6). One batch: booking `late_cancelled`; place claim deleted through `release_place`; limit counters −1; reserve kept; penalty scheduled for 18:30. Dana is eligible for `general` → `reserved_for = waitlist` (D-27, D-59). Events `booking.late_cancelled`, `place.released{cancel}` |
| 08:00:00.01 | Fay holds Mat 3 → assert 3 fails (reserved, no offer) → `409 PLACE_TAKEN` |
| 08:00:00.05 | Gate runs promotion; the mode at 08:00 is `auto_promote` (until 16:30) |
| 08:00:00.08 | Dana passes steps 3, 5–10; pack_10 covers her. One batch: booking `confirmed` on Mat 3, `booked_via: waitlist`; balance 3 → 2 with `reserve −1`; `reserved_for` cleared; entry `promoted`; `booked_count` 36 |
| 08:00:01 | `booking.confirmed` (`booked_via = waitlist`) → `promoted_notice` → SMS through the notification service (Kairos sends every member message, D-51) |
| 18:30:00 | Penalty (§3A.12.7): `place_refilled` = true (Dana's confirmed booking holds Mat 3) → waived: units `release` row (delta 0, unlimited); no fee; no strike. `booking.penalty_assessed{waived: true}`; `penalty_notice` does not fire (`where: !waived`) |

Variants, each asserted in `a3_…`:
- **Dana has 0 credits:** `skipped` (`INSUFFICIENT_UNITS`) → `skipped_notice`; Eli promoted onto Mat 3.
- **17:00 (offer_all):** offers to Dana and Eli expire 17:15; Mat 3 stays reserved; Eli accepts → one batch creates the hold (offer `accepted`, `hold_id` set, assert 3 passes) → confirm.
- **Gate down:** the promotion sweep promotes Dana within 90 s.
- **Cara paid $30:** no units, no fee (`fee_if` false); `refund.late: none` → no refund; `penalty_assessed{waived: true, refund: none}` (D-48).
- **Front row before release (Mon 12:00, timely cancel):** Dana isn't eligible for `front_row_unlimited`, but Eli is, so the place is reserved and Eli is promoted; Dana keeps position 1.
- **Bookings mirrored (Phase 1):** no Kairos writes besides mirror apply and the write-through; Dana stays `waiting` in the mirror.

**Pass.**

### T4. Instructor sick call: **Pass**

Modes for the main trace: all `owner`. Maya teaches Tue 9 Mar 18:00 Hot 75, Park Slope Studio 2, 20 booked (16 credits, 4 drop-ins). Policy: hook deadline T−2h = 16:00; unstaffed check T−90m = 16:30.

| Time | Step |
|---|---|
| 12:00:00 | `POST /time-off {sick, immediate}` (§3A.11.2). One batch: TimeOff `approved` (system, D-52); assignment `released` (`sick`); claim released; hours voided; session `needs_staff`. Events `timeoff.submitted` → `timeoff_notice`; `assignment.vacated` → `sub_finder` |
| 12:00:02 | H3 fetches candidates: `teacher` + unexpired `hot_cert`, available, no overlapping claim in any domain or source, `teach_rest`, `teach_day`, transfer. Ranked Leo, Ana, Ravi |
| 12:00:03 | Three offers; `start − now = 6h ≤ 6h` → each expires 12:10 (D-33). `offer.sent` → `substitute_offer_notice` (SMS) |
| 12:10 | All expire; the re-fetch finds no new candidate → run `exhausted`, `custom.substitute_exhausted`, manager task |
| 16:30 | Unstaffed check (§3A.9.5): slot empty, no pending proposal → studio cancel (§3A.9.4), `no_staff`. Session batch: `cancelled`, claims released, timers cancelled. Bookings saga (bookings owned): 20 bookings `cancelled`; 16 `release +1` ledger rows; 4 refund jobs to the payments gateway; waitlist entries `expired`; `session.cancelled` → `no_sub_notice` texts the 20 customers whose bookings were active just before the cancel |

Variants, each asserted in `a4_…`:
- **Ana accepts at 12:04:** one engine batch (D-57): offer `accepted`, proposal created and validated, Leo and Ravi `withdrawn` → `substitute_filled_notice`; `approval_needed`. Manager approves at 12:15 → re-validated; Ana's claim and hours; session `scheduled`; `sub_assigned_notice`.
- **Two accept at once:** the unique index lets exactly one commit; the other gets `409 OFFER_FILLED`; one pending proposal.
- **Ana became busy:** Ana (also `desk_staff` in this variant) is given desk_mid 16:00–20:00 at 12:06 (`201`, the proposal isn't committed). Approval at 12:15 → `RESOURCE_CONFLICT` → proposal `failed`, offer `lapsed`, outreach continues.
- **Late accept:** a manager offers Ravi at 15:50 (expires 16:00); he accepts at 15:58 → proposal expires 17:30; at 16:30 the check defers once to 17:30 and emits `proposal.urgent` → `approval_urgent`; approved 16:45 → `scheduled`.
- **Phase 3 (classes owner, bookings shadow):** the 16:30 session batch is identical; no booking, ledger or refund rows; one push `gateway.booking_vendor.classes.cancel`; BookingVendor cancels and refunds (confirmed, D-44); 20 mirrored cancellations arrive; `no_sub_notice` texts the 20 members (D-51); shadow compares the outcome with the dry-run studio cancel.
- **Phase 3, push fails:** after 3 attempts (by 16:40) `push_failed` drift → `cross_domain_alert` staff page + urgent task.
- **Phases 1–2 (classes mirrored):** only owned desk shifts are vacated; the class claim stays; the portal links to BookingVendor.

**Pass.**

### T5. Classes mirrored, desk shifts owned; no desk shift during a class the person teaches: **Pass**

Modes: classes, bookings, members `mirror`; shifts `owner` (Phase 1 after the shifts cutover). Priya has roles `teacher` and `desk_staff`; `BV-1187` ↔ Priya by email.

**Order 1, class first (Tue 9 Mar).**
1. `class.updated` for 09:00 Vinyasa, Park Slope, instructor BV-1187 → `kairos-sync` dedupes and maps it (`VIN60` → `vinyasa_60`, `PS-1` → `ps_studio_1`, BV-1187 → Priya).
2. `POST /internal/mirror/apply`: one batch upserts the session, the assignment and claim C1 on Priya, 08:50–10:10 (10-min buffers), `source = mirror`, `active`.
3. A manager assigns Priya to Park Slope `desk_open` (06:15–12:45) → staleness guard pulls Priya's Tuesday (fresh) → validator finds C1 overlapping → `409 RESOURCE_CONFLICT` `{person: Priya, conflict: "Vinyasa 60 09:00–10:00 Park Slope", source: BookingVendor}`.
4. Backstop: had the validator been bypassed, the insert into `occupancy (priya, grain(08:50), 0)` violates the PK, and the batch aborts.
5. The solver gets C1 in `fixed_busy`; `AddNoOverlap` makes the shift impossible; `solution.not_assigned` holds.

**Order 2, shift first (Wed 10 Mar).**
1. Priya is assigned `desk_open` D1 06:15–12:45 → `201`.
2. BookingVendor assigns her the 09:00 class → ingestion inserts with `ON CONFLICT DO NOTHING`; every grain is taken by D1 → C2 `conflicted` (I-18).
3. `cross_domain_conflict` drift → `cross_domain_alert` (scope `owned`, event domain `none`) → staff chat + task within 60 s.
4. A `desk_mid` at 11:00 for Priya → `409 RESOURCE_CONFLICT` (it overlaps D1). A `desk_mid` at 16:00 → `201`: it overlaps neither D1 nor the class, and `desk_rest` applies only closing → opening (D-46).
5. The manager moves D1 by proposal → D1's release batch re-homes C2's grains → C2 `active`. D1 is never vacated automatically (D-34).

**Order 3, unmapped teacher (Thu 11 Mar).** BV-2290 has no mapping → class `needs_mapping`, `unmapped_person` drift. Priya (a teacher) is assigned Dumbo `desk_open` 07:00–13:30 → overlaps the WB class 09:00–10:00 ± 40 min → `409 RESOURCE_CONFLICT` "unmapped teacher" (D-26); the solver has the same rule as `unmapped_blocks`.

**Mode guard.** A mirrored class with 1 booking passes its minimum-attendance time: no cancel, no push (§3A.2). If BookingVendor itself cancels a mirrored class, mirror ingestion emits `session.cancelled{source: mirror}`, and Kairos texts its members (D-51; `a5_…` variant).

**During the 14-day shifts shadow** (before the cutover), the same overlap on a ShiftTool shift is a validator disagreement, not a refused write (§18.9).

Fixture `a5_…` asserts all of this. **Pass.**

## 4. Self-check before publishing

| Check | Result |
|---|---|
| Every glossary term has one meaning | `channel` (request) vs `booked_via` (stored) made explicit; "Booking" and "Proposal" definitions updated to match §3.8.1 and §3A.14. `vacated` (replacement needed) vs `released` (session cancelled) are distinct events |
| Example configs valid against schema and CEL | Both fixtures parse as YAML 1.2; every field used exists in §4 at 2.1; every workflow event is in the §9.2 catalog (scripted check); every workflow named in §3A exists in §4b.1 (scripted check); CEL uses only §5.3 variables (`event.data[...]`, `event.reason`, `booking.booked_via`); lane-aware coverage script passes |
| Every endpoint a front end or agent uses exists in §11 | §18.4 rows and H1–H4 tools checked against §11.3, with `me` alias and body `preview` defined in §11.2 |
| No phase depends on a later phase | Saga runner in Phase 0; scope rule in Phase 1; shifts shadow inside Phase 1; `invoke_hook` + H3 in Phase 3, where first used; owner-mode A.3/A.4 suites in Phase 4, which comes after Phase 3's substitute flow; ShiftTool retirement (Phase 3) ≥ 60 days after the Phase 1 shifts cutover |
| No new text contradicts the brief | Yoga-only scope (D-25) departs from the brief's five shapes, and the product owner confirmed it in this round. D-09 (holds authoritative in the DB) remains the one stated departure from the technical context. All other new text stays inside the brief: notifications only through workflows and the notification service; outside calls only through the gateway; feature flags off by default; preview never writes production |

## 5. Remaining open items

**Findings only partly fixed:** none at the spec level. Two fixes rest on tenant facts that are placeholders:
- **H-02:** resolved. The tenant confirmed 2 seats at the Dumbo desk (D-45).
- **H-01:** BookingVendor refunding on cancel is confirmed (D-44). Only whether it also **notifies members** is still assumed (A-15, Q-19). If it doesn't, `no_sub_notice` runs with `scope: all` during Phase 3.
- **H-12 (rollback of waitlists):** pushing Kairos waitlists back to BookingVendor depends on BookingVendor support; otherwise it degrades to manager tasks (§3A.18).

**Decisions marked "Assumed, not confirmed"** (reviewer's recommended answers; no product-owner answer was supplied):

| Decision | Question |
|---|---|
| D-46 | DQ-3: `desk_rest` applies closing → opening only |
| D-47 | DQ-4: shifts go through 14 days of shadow |
| D-48 | DQ-5: no refund for a late-cancelled drop-in, even if refilled |
| D-49 | DQ-6: studio-initiated session changes keep bookings and extend free cancellation |
| D-50 | DQ-8: moves only before `free_cancel_until` |
| D-52 | DQ-9: sick calls can't be rejected; cancelling doesn't restore assignments |
| D-53 | DQ-10: imported bookings get the active policy's terms |
| D-54 | DQ-11: no hours records for mirrored work |
| D-55 | DQ-12: pay protection for any short-notice studio cancel |

**Confirmed in this round:** D-25 (yoga-only scope); D-45 (Dumbo desk seats 2); D-44 (BookingVendor cancels and refunds bookings when Kairos cancels a class); D-51 (Kairos manages everything, including every member and staff message).

## 6. Product-owner answers after the first draft

| Answer | Effect on the spec |
|---|---|
| Dumbo desk seats 2 | D-45 confirmed; A-16 and Q-17 resolved; placeholder notes removed |
| BookingVendor refunds on cancel | D-44 confirmed |
| "Kairos manages everything and uses the Stripe API" | **D-51 reversed and confirmed:** new `tenant.member_messaging` (schema 2.1). The reference tenant uses `kairos`: Kairos sends every member and staff message in every domain mode; mirror ingestion emits events for observed outside changes (§18.6); BookingVendor's member messages are switched off at go-live (§3A.3), except receipts for its own charges until the payment cutovers. **Stripe** is the processor: new §18.10 maps every payment action to a Stripe API call through the gateway; schema 2.1 adds `processor_price_ref`; Phases 4–5 name Stripe. Target state in §18.1: Kairos manages everything except payroll (Gusto stays, a brief non-goal). A-15 and Q-19 resolved; A-17, A-18 and Q-21 added. An earlier answer kept checkout and refunds outside; this one supersedes it, so checkout and refunds move to Kairos with Stripe at their cutovers, as planned |
