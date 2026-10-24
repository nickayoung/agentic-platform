# 17. Open questions and risks

## 17.1 Open questions (for the product owner or the tenant)

| ID | Question | Recommended answer | Needed by |
|---|---|---|---|
| Q-01 | Does BookingVendor support reserving a mat during checkout? | If not, mirror-mode holds are advisory and the "taken" result comes from BookingVendor (§7.12) | Phase 2 |
| Q-02 | When a studio closes at short notice, are desk staff paid for the shift? | Pay if the closure is posted less than 2 h before the shift (`closure_pay_notice`) | Phase 1 |
| Q-03 | Should instructors who also work the desk have a total weekly cap above the desk cap (New York labour rules)? | Keep 40 h combined until legal confirms | Phase 1 |
| Q-04 | Are workshops (multi-session series sold as one product) and per-mat surcharges needed? | Out of v2.0; consider for schema 2.1 | Phase 6 |
| Q-05 | Should a desk shift be vacated automatically when BookingVendor assigns that person a class over it (D-34)? | Not at first. Revisit after 30 days of Phase 1 conflict data | Phase 1 + 30 d |
| Q-06 | When BookingVendor is unreachable at roster publish: block or warn? | Block, with an audited manager override (§18.6) | Phase 1 |
| Q-07 | Who may approve substitute proposals: managers only, or also senior teachers? | Managers and desk staff with the `manager` mapping only | Phase 3 |
| Q-08 | Retention for closed member accounts: 2 years, then erase? | Yes, subject to legal | Phase 2 |
| Q-09 | Guests booked with a member (`allow_guests`): how many, and paid how? | 1 guest per booking, paid by drop-in price | Phase 4 |
| Q-10 | Minimum age for online booking, and how it is collected (D-31)? | 18; a date of birth at signup through the member sign-in service | Phase 2 |
| Q-11 | Real issuer URLs, directory group names (including the groups for `teacher` and `desk_staff`), and BookingVendor/ShiftTool API details (Gusto needs no API: §18.8, Q-14) | Collect at onboarding (the §4b.1 values are placeholders) | Phase 0 |
| Q-12 | Real desk shift start times per studio and weekday (§4b.1 `starts` are placeholders that fit the published hours) | Tenant ops to confirm before the first roster publish | Phase 1 |
| Q-13 | Which system feeds teaching hours to Gusto today (BookingVendor export, or manual)? | Keep it until the classes cutover (D-36) | Phase 1 |
| Q-14 | The exact header rows of the tenant's Gusto employee and contractor CSV templates, and which column Gusto matches people on (employee ID or name) | Download both templates in Gusto at onboarding and copy the headers into `payroll_export.template_headers`; set `payroll_ref` per person | Phase 1 |
| Q-15 | Are teachers employees or contractors in Gusto? Are any desk staff contractors? | Set `payroll_type` per person at onboarding | Phase 1 |
| Q-16 | Do teaching and desk work have different pay rates in Gusto, and how does the employee template take hours per rate or job? | If yes, `split_by_kind: true`, with one row per kind mapped to the Gusto job; confirm against the template | Phase 1 |
| Q-17 | *(Resolved: yes, 2 seats; D-45.)* | — | — |
| Q-18 | Should a drop-in who cancels late be refunded if the mat is refilled (D-48)? | No (`refund.late: none`) | Phase 2 |
| Q-19 | *(Resolved: Kairos notifies members itself, D-51.)* | — | — |
| Q-21 | Can BookingVendor's member notifications be switched off individually, keeping only its payment receipts (D-51, A-17)? | Check in BookingVendor's admin before go-live | Phase 1 |
| Q-20 | Are teachers paid for a class cancelled for low attendance at T−2h (`closure_pay_notice` 2 h, D-55)? | Not at exactly 2 h; pay only for cancels under 2 h | Phase 3 |

## 17.2 Risks

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R-01 | Mirror staleness: an outside class assignment Kairos hasn't seen yet collides with a new desk shift | M | M | Events plus a targeted pull before staff commits; alert on conflict; the conflicted claim still blocks new claims |
| R-02 | Unmapped or wrongly mapped teachers in BookingVendor | M | H | Go-live needs 100 % mapped; `unmapped_person` blocks desk assignment and alerts; matching on email first |
| R-03 | Write throughput during booking-open rushes on one tenant database | L | H | SessionGate; small batches; load tests at 3× peak |
| R-04 | Maturity of the TypeScript CEL library | M | M | Small profile, conformance tests, in-house fallback |
| R-05 | The solver container adds operational load | M | L | Stateless worker; the booking path doesn't depend on it |
| R-06 | The config agent produces plausible but wrong configs | M | H | Scenario evals, simulation, impact plans, human approval, fast rollback |
| R-07 | Shadow disagreements dominated by undocumented BookingVendor rules | H | M | Triage categories; `config_fix` loop; explicit acceptance before cutover |
| R-08 | Agents mis-explain policy | M | M | Policy text rendered from config; H2 checker; confirmations |
| R-09 | Rollback fails after a long time in owner mode | M | H | Continuous push with verification; rehearsals; retire only after 60 days |
| R-10 | Small team working mostly through coding agents | H | M | Typed contracts, fixtures, scenario DSL, property tests, assert lint |
| R-11 | A Phase 3 class cancel push fails and members arrive to a cancelled class | L | H | Push retries within 10 min, then an urgent task and a non-rate-limited staff page (§3A.9.4) |
| R-12 | §3A grows out of step with the mechanisms in §7–§12 | M | M | One test file per lifecycle card (§14.1); a card change requires its test change in the same PR |
