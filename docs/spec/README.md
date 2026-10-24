# Kairos for Yoga Studios — Technical Specification

**Status:** Draft v2.1 (yoga-only; second review applied) · **Audience:** platform engineers and coding agents · **Date:** 2026-10-24

Kairos is a scheduling platform for **multi-studio yoga businesses**. The studio owner describes how the business works: studios, rooms, mat layouts, class types, timetable, memberships, cancellation rules, desk cover. A configuration agent compiles that description into a typed, versioned configuration document. Deterministic engines execute it. No LLM call sits in the booking path.

The first and only tenant in scope is the multi-studio yoga business described in §18 (the **reference tenant**). The platform plugs into that tenant's three front ends. It runs beside the tenant's outside booking system, outside staff-scheduling tool and outside payroll system.

## What changed in v2.0

v1.0 targeted five business shapes. v2.0 is **yoga studios only** (D-25):

- **Removed:** appointments, gyms, restaurants, field service, coworking; on-demand slot search; arrival windows; routing; travel; territories; service sites; vehicles and equipment resources.
- **Kept:** the configurable core (schema, CEL, configuration agent, versioned publish) and the shared occupancy model. The schema now covers only what yoga studios need, so another studio can still be configured without code.
- **Folded in:** every Blocker and Major finding from the v1.0 review. The trace is in §16.3.
- **v2.1:** applies the second review (G-01 – G-23, trace in §16.4): built-in behaviour only on owned domains (§7.13), per-studio desk shift starts, staff role mappings, offer-to-hold atomicity, strike decay, payroll source per phase, the eval grammar and the acceptance scenario files.

## Contents

| # | Section | File |
|---|---|---|
| 1–2 | Overview, design principles, glossary | [01-overview-and-glossary.md](01-overview-and-glossary.md) |
| 3 | Domain model and lifecycles | [03-domain-model.md](03-domain-model.md) |
| 4 | Configuration schema | [04-configuration-schema.md](04-configuration-schema.md) |
| 4b | Example configurations (reference tenant + single-studio variant) | [04b-example-configs.md](04b-example-configs.md) |
| 5 | Expression language (CEL profile) | [05-expression-language.md](05-expression-language.md) |
| 6 | Configuration agent | [06-configuration-agent.md](06-configuration-agent.md) |
| 7 | Booking engine | [07-booking-engine.md](07-booking-engine.md) |
| 8 | Rostering engine | [08-rostering-engine.md](08-rostering-engine.md) |
| 9 | Workflow engine | [09-workflow-engine.md](09-workflow-engine.md) |
| 10 | Runtime agent hooks | [10-runtime-agent-hooks.md](10-runtime-agent-hooks.md) |
| 11 | Public API | [11-public-api.md](11-public-api.md) |
| 12 | Data storage | [12-data-storage.md](12-data-storage.md) |
| 13 | Security, safety, operations | [13-security-and-safety.md](13-security-and-safety.md) |
| 14 | Testing and evals | [14-testing-and-evals.md](14-testing-and-evals.md) |
| 15 | Phased delivery plan | [15-delivery-plan.md](15-delivery-plan.md) |
| 16 | Decisions and assumptions | [16-decisions-and-assumptions.md](16-decisions-and-assumptions.md) |
| 17 | Open questions and risks | [17-open-questions-and-risks.md](17-open-questions-and-risks.md) |
| 18 | Reference deployment | [18-reference-deployment.md](18-reference-deployment.md) |
| A | Acceptance-test walkthrough | [appendix-a-acceptance-walkthrough.md](appendix-a-acceptance-walkthrough.md) |
| — | Config-agent eval cases | [../../evals/config-agent/](../../evals/config-agent/) |

Normative words follow RFC 2119. Tags: decisions `D-nn` (§16), assumptions `A-nn` (§16), invariants `I-nn` (§3), reason codes `UPPER_SNAKE` (§7.9).

## Acceptance test (yoga scope)

This restates the original test for yoga only (D-25). The spec passes if all of the following hold:

1. **Expressible through the schema.** The reference tenant can be expressed entirely through the schema, with no special-case code: heated and unheated studios, mat spot maps, pooled rooms, an unlimited-reserved front row, class packs and memberships, desk shifts, and instructor rostering.
2. **Engine behaviour.** The engines correctly handle a **mat-hold race**, a **late cancellation with waitlist promotion**, and an **instructor sick call**.
3. **Mixed domain modes.** With classes in mirror mode and desk shifts in owner mode at the same time, the engine refuses to put a person on the desk during a class that person teaches.

| Requirement | Satisfied in |
|---|---|
| Tenant expressed through the schema | §4b.1, Appendix A.1 |
| Mat-hold race | §7.5, §12.4, Appendix A.2 |
| Late cancel with waitlist promotion | §7.6–7.7, §9.6, Appendix A.3 |
| Instructor sick call | §8.6, §10.4, Appendix A.4 |
| Built-in behaviour only on owned domains | §7.13 |
| Mirror classes + owner desk shifts | §12.3, §18.5, Appendix A.5 |
