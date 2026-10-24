# 10. Runtime agent hooks

Runtime agents are **clients of the public API**. They have no private endpoints, no database access and no config access. Hooks are bounded LLM functions hosted in `kairos-agent`. Each hook has typed inputs and outputs, a fixed tool list, and guardrails. A hook produces only two kinds of output: data that the engine validates (queries, proposals, offers), or text that is checked against structured facts.

**Hosting (D-12).**
- The **substitute finder** (H3) is hosted by Kairos, because workflows trigger it.
- The **member support assistant** and the **staff assistant** belong to the tenant's apps. They call the public API and may use H1, H2 and H4.

All agents use `@kairos/agent-tools`, which is generated from the OpenAPI spec, so each tool is exactly one API call.

## 10.1 Common guardrails

| Guardrail | Mechanism |
|---|---|
| Identity | Agent token with `actor.type = agent`, `agent`, `run_id` and `on_behalf_of`. Effective scopes = the principal's permissions ∩ the agent's allowlist. The principal's `state` is checked on every call |
| Proposal, not commit | Every staff-side change is a `Proposal` and needs a human approver, unless an explicit flag (`substitute.auto_approve`) allows otherwise |
| Member money and penalties | An agent may finalise **only** actions that are reversible and cost nothing: booking with units while free cancellation is still open, joining or leaving a waitlist, a timely cancellation. Anything that charges money, forfeits units, or is a late cancellation returns a `confirmation` (§11.6). Only a member-token call can redeem it |
| Bounded tools | A per-agent allowlist, enforced by the API, not by the prompt |
| Untrusted input | Member messages, help articles and email bodies go to the model as delimited data. Tool outputs are typed |
| PII minimisation | Member-facing agents never see staff contact details. Fields with `pii: true` are redacted unless the agent has `pii:read` (staff assistant only, own studio only) |
| Rate limits | Member assistant: 30 writes per member per hour. Substitute finder: 20 offers per slot. Staff assistant: 60 proposals per person per hour |
| Kill switch and revocation | Flag `agent.<name>.enabled`. `DELETE /agents/clients/{id}` revokes the client credential immediately. Outstanding tokens expire within 15 minutes and fail the per-request client check before then (§3.12.6) |
| Audit | `run_id`, prompt hash and tool-call sequence, for every call |
| Deterministic fallback | Every hook has a non-LLM fallback, so booking never depends on an LLM |

## 10.2 H1 `parse_booking_request`

```ts
input:  { text: string; locale: string; now: UtcMs;
          customer: { id: string; tier: string | null; home_location: string | null; timezone: string } }
output: { kind: 'query'; query: ClassQuery; unresolved: string[] } | { kind: 'clarify'; question: string; options?: string[] }
interface ClassQuery { templates?: string[]; template_tags?: string[]; locations?: string[];
  date_range: { from: LocalDate; to: LocalDate };           // ≤ 31 days
  time_of_day?: { from: LocalTime; to: LocalTime }[];
  teacher_ids?: string[];                                    // only ids returned by resolve_teacher
  place_prefs?: { attributes: Record<string, unknown> } }    // e.g. { by_wall: true }
```

- **Tools:** `list_templates`, `list_locations`, `resolve_teacher(name)` (public teacher profiles only), `list_place_attributes(template)`.
- **Validation:** the output is checked against the schema, and every ID must exist. An unknown key gets one retry, then the hook returns `clarify`. Relative dates resolve in the **studio's** zone; if the member's home studio is unknown, the hook uses the member's zone and says so in `unresolved`.
- **Use:** the caller runs `GET /sessions` with the query.

## 10.3 H2 `explain_decision`

```ts
input:  { decision_id: string; audience: 'member' | 'staff'; locale: string }
output: { text: string; facts_used: string[]; next_actions: NextAction[] }
type NextAction = { type: 'join_waitlist'; session_id: string } | { type: 'other_session'; session_ids: string[] }
  | { type: 'buy_product'; product_keys: string[] } | { type: 'contact_desk'; location: string } | { type: 'retry_at'; at: UtcMs };
```

- **Tools:** `get_decision`, and `get_policy_text(policy_key)` (`GET /policies/{key}/text`, which renders policy text from config).
- **Checker:** every number, time and amount in `text` must appear in the trace facts. Every ID in `next_actions` must come from the trace. If the check fails, the hook returns a templated explanation built from the §7.9 messages.
- **Member audience:** no config paths, internal codes, or other people's data.

## 10.4 H3 `substitute_finder`

```ts
input:  { session_id: string; requirement_key: string; deadline: UtcMs; max_parallel_offers?: number /* 3 */ }
output: { status: 'filled' | 'proposed' | 'exhausted' | 'deadline_passed'; proposal_id?: string;
          contacted: { resource_id: string; offer_id: string; outcome: string }[]; manager_summary: string }
```

**Tools (allowlist).**

| Tool | API call |
|---|---|
| `get_session` | `GET /sessions/{id}` |
| `get_substitute_candidates` | `GET /sessions/{id}/substitutes?requirement=` |
| `send_offer` | `POST /offers {kind: substitute, session_id, requirement_key, resource_id, expires_at, note?}` |
| `get_offer` | `GET /offers/{id}` |
| `record_reply` | `POST /offers/{id}/reply {text, interpreted: accept \| decline \| conditional}` |
| `withdraw_offer` | `POST /offers/{id}/withdraw` |
| `create_proposal` | `POST /proposals` |
| `create_task` | `POST /tasks` |
| `emit_exhausted` | `POST /events/custom {name: substitute_exhausted}` (agent-scoped) |

**Behaviour.**
1. Fetch candidates.
2. Offer the top *k* in rank order. Each offer's expiry follows D-33.
3. When an offer is accepted, `offer.accepted` fires. Create the proposal, then withdraw the other open offers with a "filled, thanks" message.
4. On a decline or expiry, offer the next candidate. Re-fetch candidates before every wave.
5. If the proposal expires unapproved (I-28a), resume outreach.
6. At the deadline, or when no candidates remain, end the run as `deadline_passed` or `exhausted`. Create a manager task and emit `custom.substitute_exhausted`. The built-in unstaffed check then decides the class's fate (§8.6 step 7).

**Guardrails.**
- Contact only people returned by `get_substitute_candidates` in the current run.
- Offers go only through `send_offer`. Messages use fixed notification-service templates. The only free text is a note of up to 280 characters, screened for PII and links.
- Quiet hours are 22:00–07:00 in the candidate's zone, unless the class starts within 12 h.
- The hook cannot approve its own proposal, and sends at most 20 offers per slot.

**Deterministic mode.** With `agent.substitute_finder.mode = deterministic`, candidates must reply through buttons or keywords (`YES`/`NO`), and no LLM is used. The LLM adds two things in normal mode: interpreting free-text SMS replies such as "yes if I can leave by 7:45" as `conditional`, which goes to the manager, and writing the manager summary.

## 10.5 H4 `staff_draft`

Drafts replies to support-inbox messages, using only facts from read tools: bookings, entitlements, policy text and help articles. Drafts are never sent automatically. Refunds and credit adjustments are proposals: desk staff may approve up to 1 credit; anything larger needs a manager.

## 10.6 The tenant's runtime agents

| Agent | Principal | Hooks | Tools |
|---|---|---|---|
| Member support assistant (web chat, email, SMS) | The member's token | H1, H2 | Sessions (read), holds, bookings (within §10.1), cancel preview and confirmation, waitlist, own entitlements, policy text |
| Staff assistant (desk app, portal) | The staff member's token | H2, H4 | Sessions, assignments and rosters (read), substitutes (read), proposals (create), tasks |
| Substitute finder | `system` (workflow), or the manager who started it | — (it is H3) | §10.4 |

Example flows are in §18.4.4.
