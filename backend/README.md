# IEE backend

FastAPI + SQLAlchemy + Alembic. SQLite for development and tests; PostgreSQL is the
target for the real deployment. Accounts (roles, job titles, privileges) and brand routing are
managed by people with "Manage accounts" (accounts phase; login itself comes later with
Microsoft sign-in). Clients (with their contact people) and opportunities can be created and
edited (CRM 1); proposal requests can be created, edited as drafts and moved through their
lifecycle (Phase 3A), with proposal files and a comment thread (Phase 3B).

## Setup (Windows)

```
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt
```

## Configuration (environment variables; no .env loading)

| Variable | Default | Meaning |
|---|---|---|
| `EVENTFLOW_ENV` | `production` | `development`, `test` or `production` |
| `EVENTFLOW_DEV_IDENTITY` | `false` | Temporary development identity (see below) |
| `DATABASE_URL` | `sqlite:///<backend>/eventflow.db` | SQLAlchemy URL |
| `EVENTFLOW_HOST` / `EVENTFLOW_PORT` | `127.0.0.1` / `8000` | Used by `python -m app.serve` |
| `EVENTFLOW_FILES_DIR` | `<backend>/storage/proposal-files` | Proposal file storage (never a publicly served folder; git-ignored) |

Database files and `.env` files are git-ignored and must never be shared.

## Development identity (TEMPORARY, not authentication)

Until login exists, callers name themselves with two headers:

```
X-Dev-User: u-ahmed
X-Dev-Role: business_development
```

- Only active when `EVENTFLOW_ENV=development` **and** `EVENTFLOW_DEV_IDENTITY=true`.
- Fails closed: disabled → 401 everywhere except `/api/health`; missing/unknown user or
  missing role → 401; a role the user does not hold → 403; a request that does not come
  from 127.0.0.1 / ::1 → 403 (checked on every request, however the server was started).
- The server **refuses to start** if it is enabled outside development, or bound to
  anything other than 127.0.0.1.
- Anyone who can reach the API can claim any identity while it is on. It is a development
  aid only. Real authentication will replace `app/identity.py` without changing the
  authorization code (which only receives an `Actor`).

## First run (development)

```
set EVENTFLOW_ENV=development
set EVENTFLOW_DEV_IDENTITY=true
.venv\Scripts\python -m alembic upgrade head
.venv\Scripts\python -m app.seed mark-demo
.venv\Scripts\python -m app.seed demo
.venv\Scripts\python -m app.serve
```

- The server never creates or migrates the schema itself; it refuses to start on an
  unmigrated or unmanaged database.
- Demo data is development-only and only loads into a database that is migrated,
  explicitly marked as demo, and empty. `python -m app.seed reset-demo --yes` rebuilds a
  database that is already marked demo.
- API docs: http://127.0.0.1:8000/docs

## Endpoints

Reads (GET):
`/api/health` (no identity) · `/api/me` (also `privileges`, `pages` and tracker `scopes` for this person in this
role) · `/api/users` (active people; `includeInactive=true` adds deactivated ones) · `/api/config` (with the live
`routing`) · `/api/users/{id}` and `/api/routing` ("Manage accounts" only) · `/api/analytics` ("See analytics" only) ·
`/api/clients` (`q`, `type`, `owner`, `brand`, `creatable`, `includeArchived`) · `/api/clients/{id}` (with active
`contacts`, this viewer's `permissions`, and for the Commercial Head a `transferPreview`) · `/api/clients/{id}/history` ·
`/api/opportunities` (`client`, `brand`, `owner`, `stage=a,b`, `open`, `includeArchived`) ·
`/api/opportunities/{id}` (with history, and `permissions: {edit, moveTargets}`) ·
`/api/proposal-requests` (`scope`, `tab`, `q`, `brand`, `status=a,b`, `stage=a,b`, `assignedAM`, `bdOwner`,
`deadline`, `waitingOn`, `open`, `sort`, `page`, `pageSize` (max 100), optional `include=history` (adds each item's status
history and participants, for dashboards and analytics) → `{items, counts, total, page, pageSize, scope, scopeSize}`) ·
`/api/proposal-requests/{id}` (history, versions, linked opportunity, `allowedActions` with reasons, `rowVersion`)

Writes (there are no PUT or DELETE routes anywhere):

| Endpoint | Body | Notes |
|---|---|---|
| `POST /api/proposal-requests` | request fields, `submit` | 201. Creates a Draft; `submit: true` creates and submits in one transaction |
| `PATCH /api/proposal-requests/{id}` | `expectedRowVersion`, changed fields, `submit` | Edits a Draft (fields not sent keep their value) |
| `POST /api/proposal-requests/{id}/actions` | `action`, `expectedRowVersion`, `note`, `amPrice`, `newRequiredBy`, `confirmShared`, `channel`, `lostReason` | Any lifecycle action listed in `allowedActions` |
| `POST /api/proposal-requests/{id}/files?expectedRowVersion=N` | the file itself as the raw body; its name in `X-File-Name` (URL-encoded) | 201. Assigned AM only, while Submitted, In Progress or Revision Requested. PDF or PPTX, checked by content; max 25 MB |
| `POST /api/proposal-requests/{id}/comments` | `body` | 201. Anyone who can view the request; plain text, up to 2,000 characters |
| `POST /api/clients` | `name`, `type`, `brands`, `city`, `notes`, `owner` (Commercial Head only), optional `contact` | 201. Any BD (who becomes the owner) or the Commercial Head. Id `CL-NNNN` from the server |
| `PATCH /api/clients/{id}` | `expectedRowVersion`, changed fields | The owner (as BD) or the Commercial Head |
| `POST /api/clients/{id}/archive` | `expectedRowVersion` | Owner or Head. Hidden from lists and the request form; nothing is deleted |
| `POST /api/clients/{id}/transfer` | `expectedRowVersion`, `toOwner`, `reason`, `moveRequests` (default true) | Commercial Head only. Moves the client and its open opportunities; with `moveRequests`, its open (not draft, not closed) requests too, each with a `bd_owner_transferred` event |
| `POST /api/clients/{id}/contacts` | `expectedRowVersion` (the client's), contact fields, `isPrimary` | 201. Owner or Head |
| `PATCH /api/clients/{id}/contacts/{contactId}` | `expectedRowVersion` (the contact's), changed fields, `isPrimary` | Owner or Head |
| `POST /api/clients/{id}/contacts/{contactId}/archive` | `expectedRowVersion` (the contact's) | Owner or Head |
| `POST /api/opportunities` | `clientId`, `brand`, `service`, `estimatedValue`, `participants`, `eventDatePrecision`, `eventDate`, `nextAction`, `nextActionDate` | 201. The client's owner or the Head; the owner is always the client's owner; starts as New Lead |
| `PATCH /api/opportunities/{id}` | `expectedRowVersion`, changed fields | Owner or Head; recorded as `details_updated` with the changes |
| `POST /api/opportunities/{id}/stage` | `expectedRowVersion`, `stage`, `lostReason`, `note` | Owner or Head; recorded as `manual_change`. Never Won (only an accepted proposal sets it); Won is final; Lost needs a listed reason; reopening a Lost one needs a note |
| `POST /api/users` | `name`, `email`, `jobTitle`, `roles`, `brand` (Account Managers), `privileges` | 201. "Manage accounts" only. Id from the name (`u-sara-mostafa`, `-2` when taken; never changes). Email unique, ignoring case |
| `PATCH /api/users/{id}` | `expectedRowVersion`, changed fields (switches not sent keep their value) | "Manage accounts" only; the safeguards below |
| `POST /api/users/{id}/deactivate` | `expectedRowVersion` | "Manage accounts" only. Never deleted; gone from the switcher, pickers and routing choices; history stays |
| `POST /api/users/{id}/reactivate` | `expectedRowVersion` | "Manage accounts" only |
| `PATCH /api/routing/{brand}` | `amUserId`, `expectedRowVersion` | "Manage accounts" only. An active Account Manager of that brand. New requests use it; existing ones keep their AM |

Proposal files:
- **Download:** `GET /api/proposal-requests/{id}/files/{fileId}`. Allowed for anyone who can view the request; someone else's draft gives 404. Files are always sent as an attachment named like `PR-2026-0042_Client_Name_v2.pdf`.
- **Storage:** files are kept under random server-generated names behind `app/storage.py` (`FileStorage`), so storage can move to the cloud later.
- **Clean-up:** `reset-demo` removes files that no database row refers to.

Comments are listed by `GET /api/proposal-requests/{id}/comments`.

The request detail also returns:
- `files`, with a `current` flag per version;
- `comments`, kept separate from `history`;
- `upload`: whether you may upload now, and for which version.

Every request also returns:
- `amPricePerParticipant`;
- the counters `stageSince`, `daysInStage`, `sharedAt` and `daysSinceShared`.

Files and comments are append-only: no route edits or deletes them.

Accounts, roles and privileges:
- Roles: Business Development, Account Manager (one brand), Commercial Head, Executive (sees everything except
  private drafts; every write is 403 except comments), Marketing and Operations (Home only; no proposal data yet).
- Privileges belong to the person (the same in every active role): "Manage accounts", "See analytics", "Send
  reminders" (later), "See all brands". They only widen what a person sees; they never allow a workflow action.
  Defaults: Commercial Head all four; Executive all but "Manage accounts"; everyone else none.
- Visibility follows the active role: an Account Manager sees their own brand only (requests, clients,
  opportunities; no Company scope) unless they have "See all brands"; Marketing and Operations see none.
  Requests, clients and opportunities they do not see are 404, exactly like ones that do not exist.
- Safeguards: nobody deactivates themselves or removes their own "Manage accounts"; at least one active person
  keeps "Manage accounts"; the Account Manager a brand is routed to cannot be deactivated, lose the role or change
  brand ("Change routing for Team Up first."). What a person still owns only warns (`owns` on their page).
- `user_history` and `routing_history` are append-only (ORM guard and database triggers), written in the same
  transaction as the change. The rules are `app/domain/access.py` and `app/domain/accounts.py` (ports of the
  frontend's `access.js` and `accounts.js`), checked by the contract file's `accountCases`.

Clients and opportunities (CRM 1):
- The rules are in `app/domain/crm.py`, the port of `frontend/src/domain/crm.js`; the contract file's `crmCases` checks both.
- Every change writes an append-only history entry in the same transaction: `client_history` (created, updated, archived, owner_transferred, contact_added/updated/archived, opportunity_added), `opportunity_history` (stage changes and `details_updated`), and `request_events` for a request whose BD owner moved with a transfer (shown as `events` in the request detail).
- New or changed event and next-action dates cannot be in the past.
- A possible duplicate client (similar name, or the same phone or email after normalising Egyptian formats and case) comes back as a `possible_duplicate_client` warning; it never blocks.
- Each write returns `{client | opportunity, message, warnings}` (`moved` too, for a transfer).
- A draft keeps its creator as BD owner when its client is transferred; submitting it is then refused (403), because only the client's owner may submit requests for it.

- Each write returns `{request, message, warnings}`. `request` is the updated request in the GET shape, with fresh `allowedActions`.
- `expectedRowVersion` is required on PATCH and actions. If it's missing you get 422. If someone else changed the request first you get 409 with code `stale`.
- Each write is **one transaction**: the status, the history entry, the version and price, and the opportunity sync all go together, so a failure saves nothing.
- IDs (`PR-YYYY-NNNN`, numbered per Africa/Cairo year), timestamps, `createdBy`, `submittedBy`, `onBehalfOf`, `bdOwner` and `assignedAM` are always set by the server. Sending any of them gives 422.
- Errors map as follows:
  - another person's draft: 404, the same as a missing request;
  - not allowed for your responsibility or active role: 403, with the same reason text as the UI;
  - not possible at the current status: 409 `invalid_transition`;
  - invalid input: 422 with `fields`.

Visibility is applied in the SQL query before search, filters, counts and pagination.
Another person's draft returns 404, exactly like a request that does not exist.

Errors always look like `{"error": {"code", "message", "fields"?}}`.

## Test

```
.venv\Scripts\python -m pytest
```

Tests run against Alembic-migrated SQLite copies (real schema and triggers). The parity
tests run the frontend's domain modules with Node.js and compare them with `/api/config`
and the seeded data. `../contracts/proposal-scenarios.json` (shared with the frontend tests)
keeps the Python and JavaScript rules identical; see `tests/PORTING.md` for the 1:1 test map.
