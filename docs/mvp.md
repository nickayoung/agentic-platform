# MVP on preview

A first slice of Phase 1 (§15), running on Cloudflare in the **preview** environment with demo data. Nothing here talks to the tenant's real systems.

| What | Where |
|---|---|
| API | `https://kairos-api-preview.lucky-shadow-edb4.workers.dev` (OpenAPI at `/v1/openapi.json`) |
| Tenant | `lotus-line`, environment `preview`; config v2 active (`lotus_line.yaml`) |
| Demo sign-in | `https://kairos-dev-idp.lucky-shadow-edb4.workers.dev` (preview only; password-protected) |
| Demo gateway | `https://kairos-dev-gateway.lucky-shadow-edb4.workers.dev` (a stand-in BookingVendor) |
| CI | `https://kairos-ci.lucky-shadow-edb4.workers.dev` |

## What works

- **Sign-in and roles.** Demo staff sign in through the preview sign-in service. Their directory groups map to platform roles (owner, manager, desk, instructor, staff) and to config staff roles (`teacher`, `desk_staff`). Managers act only on their own studios.
- **Config.** `lotus_line.yaml` is published through the manual pipeline (draft → validate L1–L4 → submit → approve). Publishing creates the studios' rooms and two-lane front desks.
- **Desk shifts, owned by Kairos.**
  - The roster shows each week's slots from the shift templates' start times, with coverage gaps measured against the coverage rules.
  - Assigning someone runs the person-rule validator inside the same transaction: role, time off, overlap with any claim (including mirrored classes), travel time between studios, 10 h rest after closing, 40 h per week and the daily maximum.
  - A sick call vacates the person's shifts, voids their hours and opens a manager task.
- **Classes, mirrored from BookingVendor.**
  - kairos-sync polls the gateway and writes the classes into TenantCore through RPC.
  - Teachers are matched to directory people by email; an unknown teacher becomes `needs_mapping` and a drift item.
  - A teacher's class blocks desk shifts over it (A.5), and a mirrored class that collides with an owned shift is stored `conflicted`.
- **Hours.** Each confirmed desk shift has an hours record. Records become `worked` at shift end, then managers approve them, and the export writes Gusto's employee CSV (workweek rows, overtime past 40 h).

## Not yet

- **Booking engine:** booking, waitlist and payments are Phases 2–4.
- **Rostering:** there is no solver yet. Assignments are made one at a time, applied directly as one-operation proposals.
- **Staff requests:** time-off requests and swaps that need approval are not built.
- **Pushes to ShiftTool:** shifts are not pushed back yet.
- **Mats:** mat spots are not generated.
- **Workflow engine:** the desk-vacated manager task is written directly.
