# Kairos — Configurable Scheduling Platform: Technical Specification

**Status:** Draft v1.0 · **Audience:** platform engineers and coding agents · **Date:** 2026-10-24

Kairos is a scheduling platform that a business owner configures by describing how the business works. A configuration agent compiles that description into a typed, versioned configuration document. Deterministic engines execute the document. No LLM call sits in the booking hot path.

The first tenant is a multi-studio yoga business (the **reference tenant**, §18). The platform plugs into its three existing front ends and runs beside its outside booking system, staff-scheduling tool and payroll system.

## How to read this spec

| # | Section | File |
|---|---|---|
| 1–2 | Overview, design principles, glossary | [01-overview-and-glossary.md](01-overview-and-glossary.md) |
| 3 | Domain model | [03-domain-model.md](03-domain-model.md) |
| 4 | Configuration schema | [04-configuration-schema.md](04-configuration-schema.md) |
| 4b | Example configs for every business shape | [04b-example-configs.md](04b-example-configs.md) |
| 5 | Expression language (CEL profile) | [05-expression-language.md](05-expression-language.md) |
| 6 | Configuration agent | [06-configuration-agent.md](06-configuration-agent.md) |
| 7 | Booking engine | [07-booking-engine.md](07-booking-engine.md) |
| 8 | Rostering engine | [08-rostering-engine.md](08-rostering-engine.md) |
| 9 | Workflow engine | [09-workflow-engine.md](09-workflow-engine.md) |
| 10 | Runtime agent hooks | [10-runtime-agent-hooks.md](10-runtime-agent-hooks.md) |
| 11 | Public API | [11-public-api.md](11-public-api.md) |
| 12 | Data storage | [12-data-storage.md](12-data-storage.md) |
| 13 | Security and safety | [13-security-and-safety.md](13-security-and-safety.md) |
| 14 | Testing and evals | [14-testing-and-evals.md](14-testing-and-evals.md) |
| 15 | Phased delivery plan | [15-delivery-plan.md](15-delivery-plan.md) |
| 16 | Decisions and assumptions | [16-decisions-and-assumptions.md](16-decisions-and-assumptions.md) |
| 17 | Open questions and risks | [17-open-questions-and-risks.md](17-open-questions-and-risks.md) |
| 18 | Reference deployment (yoga tenant) | [18-reference-deployment.md](18-reference-deployment.md) |
| A | Acceptance-test walkthrough | [appendix-a-acceptance-walkthrough.md](appendix-a-acceptance-walkthrough.md) |

Normative words: **MUST**, **MUST NOT**, **SHOULD**, **MAY** follow RFC 2119. Decisions are tagged `D-nn` and listed in §16. Invariants are tagged `I-nn` (§3). Reason codes are `UPPER_SNAKE` and listed in §7.9.

## Acceptance-test traceability

| Acceptance requirement | Where it is satisfied |
|---|---|
| Boutique spin studio expressed only through schema | §4b.2, checked line by line in Appendix A.1 |
| Big-box gym (classes + PT sharing rooms and instructors) expressed only through schema | §4b.3, Appendix A.2 |
| Spot-hold race handled correctly | §7.5, §12.4, Appendix A.3 |
| Late cancellation with waitlist promotion | §7.6–7.7, §9.6, Appendix A.4 |
| Instructor sick call | §8.7, §10.4, Appendix A.5 |
| Classes in mirror mode and desk shifts in owner mode at once, with no desk shift during a class the person teaches | §12.3, §18.4, Appendix A.6 |
