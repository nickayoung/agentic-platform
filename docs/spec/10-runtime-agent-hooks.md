# 10. Runtime agent hooks

Runtime agents are **clients** of the public API. They have no private endpoints, no database access, and no ability to change config. "Hooks" are bounded LLM functions that the platform hosts in `kairos-agent`. Agents and workflows can call them. Each hook has a typed input, a typed output, a fixed tool list and guardrails. Every hook output is either data that the engine validates (a query, a proposal) or text that is checked against structured facts.

Hosting (D-12): the **substitute finder** runs in `kairos-agent`, because workflows trigger it. The **member support assistant** and the **staff assistant** belong to the tenant's apps, which already own the chat surfaces, the support inbox and the help-article base. They call Kairos through the public API and may call hooks H1, H2 and H4. All three use `@kairos/agent-tools`, a tool package generated from the OpenAPI spec, so every tool is an API call with the same validation as the UI.

## 10.1 Common guardrails (apply to every runtime agent and hook)

| Guardrail | Mechanism |
|---|---|
| Identity | An agent token: `actor.type = agent`, `agent = <name>`, `run_id`, `on_behalf_of` (a member or staff identity from the sign-in service, or `system` for workflow-invoked hooks). Scopes are the **intersection** of the agent's allowlist and the principal's permissions (§13.2) |
| Proposal, not commit | Staff-affecting changes (assignments, rosters, swaps, session cancellation) can only be created as `Proposal`s by agents. Approval needs a human token with the right role, unless a tenant policy explicitly auto-approves that proposal kind |
| Member money and penalty actions | An agent may complete **directly** only actions that are reversible and cost nothing: booking with units while free cancellation is still open; joining or leaving a waitlist; a timely cancellation. Anything that charges money, forfeits units, or is a late cancellation needs a **member confirmation**: the API returns a `confirmation` object (§11.6), and only a member-token call (a confirm card in chat, or a signed link in email/SMS) can redeem it |
| Bounded tools | Each agent has an explicit tool allowlist (below). Unknown tools are rejected by the API gateway layer, not just by the prompt |
| Untrusted input | Member messages, help articles, email bodies and tool text fields are passed to the model as data inside delimited blocks. Tool outputs are typed JSON. Instructions inside retrieved content are never treated as instructions |
| PII minimisation | Agents get the minimum fields. Staff phone numbers and emails are never returned to member-facing agents. Custom fields with `pii: true` are redacted unless the agent's scope includes `pii:read` (only the staff assistant, and only for the desk's own location) |
| Rate limits | Per agent and principal: member assistant 30 writes per member per hour; substitute finder 20 offers per vacated slot; staff assistant 60 proposals per staff member per hour |
| Kill switch | A feature flag per agent (`agent.<name>.enabled`). When it is off, agent tokens are refused with `AGENT_DISABLED` |
| Audit | Every agent call is audited with `run_id`, the prompt hash and the tool-call sequence (§13.4) |
| Determinism boundary | No hook output changes engine behaviour except through API calls that the engine fully validates |

## 10.2 H1 — `parse_booking_request`

Turns free text ("anything with Maya on Thursday evening, front row if possible") into a structured availability query.

```ts
input:  { text: string; locale: string; now: UtcMs;
          customer: { id: string; tier: string | null; home_location: string | null; timezone: string } }
output: { kind: 'query'; query: AvailabilityQuery; unresolved: string[] }
      | { kind: 'clarify'; question: string; options?: string[] }

interface AvailabilityQuery {
  templates?: string[]; template_tags?: string[]; locations?: string[];
  date_range: { from: LocalDate; to: LocalDate };              // ≤ 31 days
  time_of_day?: { from: LocalTime; to: LocalTime }[];
  resource_prefs?: { requirement: string; resource_ids: string[] }[];   // ids from resolve tools only
  place_prefs?: { attributes: Record<string, unknown> };      // e.g. { front_row: true }
  duration?: string;
}
```

- **Tools:** `list_templates`, `list_locations`, `resolve_staff(name)` (only people publicly listed as instructors, returning IDs and display names), `list_place_attributes(template)`.
- **Guardrails:** the output is checked against the schema and every ID is checked for existence. A query that names unknown keys is rejected and retried once, then `clarify`. Relative dates are resolved against `now` in the customer's zone. The result is only a query: the caller then runs `GET /sessions` or `POST /availability/search`.

## 10.3 H2 — `explain_decision`

Explains why a booking, hold, cancellation or assignment was blocked or charged.

```ts
input:  { decision_id: string; audience: 'member' | 'staff'; locale: string }
output: { text: string; facts_used: string[];     // ids of trace steps cited
          next_actions: NextAction[] }
type NextAction =
  | { type: 'join_waitlist'; session_id: string }
  | { type: 'other_session'; session_ids: string[] }       // only ids from the trace's alternatives
  | { type: 'buy_product'; product_keys: string[] }        // only products whose `covers` matched
  | { type: 'contact_desk'; location: string }
  | { type: 'retry_at'; at: UtcMs };                       // e.g. window opens
```

- **Tools:** `get_decision(decision_id)` (the trace, including `facts` and `config_path`), `get_policy_text(policy_key)` (rendered from config, not free text).
- **Checker:** every number, time and amount in `text` must appear in the trace facts, after locale formatting. Every `next_actions` ID must come from the trace. If the check fails, the hook returns a deterministic templated explanation built from the reason code messages (§7.9).
- **Audience:** member text never includes other customers' data, config paths or internal codes. Staff text may.

## 10.4 H3 — `substitute_finder` (exception resolution)

Invoked by a workflow on `assignment.vacated` (§4b.2 `sub_finder`), or by a manager from the staff portal.

```ts
input:  { session_id: string; requirement_key: string; deadline: UtcMs; max_parallel_offers?: number /* default 3 */ }
output: { status: 'filled' | 'proposed' | 'exhausted' | 'deadline_passed';
          proposal_id?: string; contacted: { resource_id: string; at: UtcMs; outcome: string }[];
          manager_summary: string }
```

- **Tools (allowlist):** `get_session`, `get_substitute_candidates(session_id, requirement_key)` (§8.7, deterministic and ranked), `send_offer(candidate_id, session_id, expires_at)`, `get_offer_status(offer_id)`, `create_proposal(assignment_change)`, `create_task(manager_inbox)`.
- **Behaviour:**
  1. Fetch the candidates.
  2. Offer to the top *k* (default 3) **in rank order**.
  3. When an offer is accepted, create a proposal and stop further offers. Pending offers are withdrawn with a "filled, thanks" message.
  4. On decline or expiry, offer to the next candidate.
  5. Re-fetch candidates before each new wave, because availability changes.
  6. Stop at the deadline: `deadline_passed` → task to manager. The tenant's workflow decides what happens to the session.
  7. When the run ends `exhausted` or `deadline_passed`, the hook emits `custom.substitute_exhausted` (subjects: session, assignment), so tenant workflows can react (§18.2).
- **Guardrails:**
  - May only contact people returned by `get_substitute_candidates` in the current run.
  - Offers go only through `send_offer`, which uses the notification service with fixed templates. The agent writes no free text to candidates beyond a ≤ 280-character note field, which is screened for PII and links.
  - Quiet hours (22:00–07:00 in the candidate's zone) are respected unless the session starts within 12 h.
  - Cannot approve its own proposal.
  - At most 20 offers per slot.
- **Why an LLM at all?** The candidate ranking and the validation are deterministic. The agent adds two things: (a) reading free-text replies across channels ("I can do it if I can leave by 7:45"), which become a structured accept, decline or conditional answer for the manager; and (b) the manager summary. A tenant can switch the hook to **deterministic mode** (`agent.substitute_finder.mode = deterministic`), where replies must be button or keyword answers and no LLM is used.

## 10.5 H4 — `staff_draft`

Drafts a reply to a support-inbox message, or a message to staff, using only facts from the API.

```ts
input:  { thread: { role: 'member' | 'staff'; text: string }[]; customer_id?: string; locale: string }
output: { draft: string; facts_used: { tool: string; ref: string }[]; proposed_actions: ProposalRef[] }
```

- **Tools:** read-only API tools (bookings, sessions, entitlements and policies for the customer in the thread), `search_help_articles` (the shared help-article base), and `create_proposal` (refund, rebook) as **proposals only**.
- **Guardrails:** drafts are never sent automatically. A desk staff member edits and sends them. Refunds or credit adjustments are proposals that need a desk or manager approval within the tenant's limits (`refund ≤ 1 credit` can be approved by desk staff; above that, by a manager).

## 10.6 How the three tenant runtime agents use the hooks

| Agent | Principal | Hooks | Direct API tools (summary) |
|---|---|---|---|
| Member support assistant (web chat, email, SMS) | the member (`on_behalf_of` = member token from the member sign-in service) | H1, H2 | sessions/availability (read), holds, bookings (create within guardrails), cancel (preview + confirmation), waitlist, my entitlements, policy text |
| Staff assistant (desk app, portal) | the staff member (staff token) | H2, H4 | sessions, rosters, assignments (read), "who teaches X", substitutes (read), proposals (create), tasks |
| Substitute finder | `system` (workflow), or a manager when started manually | H3 (it *is* H3) | as in §10.4 |

Details per agent, including channels and example flows, are in §18.3.
