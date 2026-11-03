"""
The only code paths that create proposal requests or change them.

Each function validates with the pure rules (domain/request_form.py, domain/workflow.py,
the ports of the frontend rules) and then writes the request, its history entry and any
opportunity change in the CALLER's transaction. Nothing here commits: the router commits
once, so an error anywhere (including in the opportunity sync) saves nothing at all.

Server-generated values only: ids, timestamps, createdBy/submittedBy/onBehalfOf, bdOwner
(the client's relationship owner) and assignedAM (brand routing) never come from the caller.
"""

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..clock import cairo_today_iso
from ..database import begin_write
from ..domain import workflow
from ..domain.permissions import CREATOR, check_actors
from ..domain.request_form import check_draft, find_possible_duplicates
from ..domain.access import can_see_request
from .routing import routed_am
from ..domain.views import client_from_orm, opportunity_from_orm, request_from_orm, user_from_orm
from ..errors import ApiError, not_found, stale, validation
from ..identity import Actor
from ..domain import conversation
from ..domain import waiting as waiting_rules
from ..models import Client, Opportunity, ProposalRequest, RequestEvent, RequestStatusHistory, User
from .lists import load_lists
from ..domain.lists import option_label
from .ids import next_request_id
from .opportunities import set_opportunity_stage

# Failure codes from the pure rules -> HTTP status and error code.
FAILURE_HTTP = {
    workflow.UNKNOWN_ACTION: (422, "validation_error"),
    workflow.INVALID_TRANSITION: (409, "invalid_transition"),
    workflow.FORBIDDEN: (403, "forbidden"),
    workflow.PRECONDITION: (409, "precondition_failed"),
    workflow.VALIDATION: (422, "validation_error"),
}


def raise_failure(result: dict):
    if result["code"] == workflow.NOT_FOUND:
        raise not_found(result["error"])
    status, code = FAILURE_HTTP[result["code"]]
    raise ApiError(status, code, result["error"], result["errors"])


# ---------- loading ----------

def _users(db: Session) -> dict:
    return {u.id: user_from_orm(u) for u in db.scalars(select(User).options(selectinload(User.roles))).all()}


def _clients(db: Session) -> dict:
    return {c.id: client_from_orm(c) for c in db.scalars(select(Client).where(Client.archived_at.is_(None))).all()}


def _opportunities(db: Session) -> dict:
    rows = db.scalars(select(Opportunity).where(Opportunity.archived_at.is_(None))).all()
    return {o.id: opportunity_from_orm(o) for o in rows}


def load_for_write(db: Session, request_id: str, actor: Actor, expected_row_version: int | None) -> ProposalRequest:
    """
    Takes the write lock, then loads the request. Someone else's draft gives the same 404 as a
    missing request (checked before the row version, so a hidden draft reveals nothing).
    """
    if expected_row_version is None:
        raise validation("Please fix the highlighted fields.", {
            "expectedRowVersion": "Required. Send the rowVersion of the request as you last loaded it."})
    begin_write(db)
    row = db.scalars(
        select(ProposalRequest).where(ProposalRequest.id == request_id)
        .options(selectinload(ProposalRequest.history)).with_for_update()
    ).first()
    if row is None or not can_see_request(request_from_orm(row), actor, _users(db)):
        raise not_found(f"Request {request_id!r} not found.")  # same text as GET
    if row.row_version != expected_row_version:
        raise stale()
    return row


def _date(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def _event_date(value: str | None, precision: str) -> date | None:
    if not value:
        return None
    return date.fromisoformat(f"{value}-01" if precision == "month" else value)  # month-only: the 1st


# ---------- lifecycle actions ----------

def perform_action(db: Session, actor: Actor, row: ProposalRequest, action: str, data: dict,
                   now: datetime) -> dict:
    """Validates and applies one lifecycle action to a loaded (and locked) request. Returns the outcome."""
    view = request_from_orm(row)
    siblings = [view]
    opportunities = _opportunities(db)
    opp_row = None
    if row.opportunity_id:
        opp_row = db.scalars(select(Opportunity).where(Opportunity.id == row.opportunity_id).with_for_update()).first()
        opportunities[opp_row.id] = opportunity_from_orm(opp_row)  # even if archived: it is this request's
        others = db.scalars(
            select(ProposalRequest).where(ProposalRequest.opportunity_id == row.opportunity_id,
                                          ProposalRequest.id != row.id)
            .options(selectinload(ProposalRequest.history))
        ).all()
        siblings += [request_from_orm(o) for o in others]

    outcome = workflow.apply_action(view, action, data, viewer=actor, users=_users(db), opportunities=opportunities,
                                    all_requests=siblings, clients=_clients(db), now=now, lists=load_lists(db))
    if not outcome["ok"]:
        raise_failure(outcome)

    row.status = outcome["status"]
    row.version = outcome["version"]
    row.am_price = outcome["amPrice"]
    row.required_by = _date(outcome["requiredBy"])
    row.submitted_by_id = outcome["submittedBy"]
    # Postponed carries its follow-up date; leaving Postponed clears it.
    row.follow_up_on = _date(outcome["entry"].get("followUpOn")) if outcome["status"] == "postponed" else None
    if outcome["submittedAt"] and row.submitted_at is None:
        row.submitted_at = now
    row.last_updated = now
    row.updated_at = now
    row.needs_review = False  # any workflow action clears "Needs review"
    confirmed = outcome.get("confirmed")
    if confirmed:  # "Mark confirmed": the event date(s) and the final details
        row.event_date_precision = "day"
        row.event_date = _date(confirmed["eventDate"])
        row.event_end_date = _date(confirmed["eventEndDate"])
        row.confirmed_participants = confirmed["confirmedParticipants"]
        row.final_price = confirmed["finalPrice"]
        row.venue = confirmed["venue"]
        row.team_notes = confirmed["teamNotes"]
        row.event_status = confirmed["eventStatus"]  # Initially confirmed or Confirmed
        db.add(RequestEvent(request_id=row.id, event="event_status_set", changed_by_id=actor.user_id,
                            role=actor.active_role, changed_at=now, note=None, details={"status": confirmed["eventStatus"]}))
        if not row.imported:
            from .notifications import notify_operations  # here: notifications imports this module
            label = "New initially confirmed event" if confirmed["eventStatus"] == "initial" else "Event confirmed"
            notify_operations(db, actor, row, label, now)
    _clear_waiting(row)  # and returns "Waiting on" to automatic (the status moved on)

    e = outcome["entry"]
    row.history.append(RequestStatusHistory(
        seq=max((h.seq for h in row.history), default=0) + 1, status=e["status"], changed_by_id=actor.user_id,
        role=actor.active_role, changed_at=now, note=e["note"], version=e["version"], am_price=e.get("amPrice"),
        on_behalf_of_id=e.get("onBehalfOf"), previous_required_by=_date(e.get("previousRequiredBy")),
        required_by=_date(e.get("requiredBy")), lost_reason=e.get("lostReason"), channel=e.get("channel"),
        follow_up_on=_date(e.get("followUpOn")), reasons=e.get("reasons"),
    ))
    db.flush()  # row_version check happens here (StaleDataError -> 409)

    change = outcome["opportunityChange"]
    if change:
        set_opportunity_stage(
            db, opp_row, change["to"], actor=actor, note=e["note"] if change["to"] == "lost" else None,
            lost_reason=change["lostReason"], reason_code=change["reasonCode"], source_request_id=row.id, now=now,
        )
    return outcome


# ---------- create / edit drafts ----------

def _duplicate_warnings(db: Session, values: dict, exclude_id: str | None) -> list[dict]:
    candidates = db.scalars(
        select(ProposalRequest).where(ProposalRequest.client_id == values["clientId"],
                                      ProposalRequest.status != "draft")
        .options(selectinload(ProposalRequest.history))
    ).all()
    dupes = find_possible_duplicates(values, [request_from_orm(r) for r in candidates], exclude_id)
    if not dupes:
        return []
    return [{
        "code": "possible_duplicate",
        "message": ("Possible duplicate. An open request already exists for this client, brand, service and "
                    f"event date: {', '.join(d.id for d in dupes)}. You can still save this one."),
        "requests": [{"id": d.id, "status": d.status, "bdOwner": d.bd_owner} for d in dupes],
    }]


def _check(db: Session, actor: Actor, data: dict, now: datetime, submit: bool) -> dict:
    checked = check_draft(data, viewer=actor, users=_users(db), clients=_clients(db),
                          opportunities=_opportunities(db), today=cairo_today_iso(now), submit=submit,
                          lists=load_lists(db))
    if not checked["ok"]:
        raise_failure(checked)
    return checked


def _apply_fields(db: Session, row: ProposalRequest, values: dict, client) -> None:
    row.client_id = values["clientId"]
    row.brand = values["brand"]
    row.service = values["service"]
    row.opportunity_id = values["opportunityId"]
    row.event_date_precision = values["eventDatePrecision"]
    row.event_date = _event_date(values["eventDate"], values["eventDatePrecision"])
    row.event_end_date = _date(values.get("eventEndDate"))
    row.event_name = values.get("eventName")
    row.brief_tags = list(values.get("briefTags") or []) or None
    row.required_by = _date(values["requiredBy"])
    row.participants = values["participants"]
    row.requirements_summary = values["requirementsSummary"]
    row.specific_requirements = values["specificRequirements"]
    row.bd_owner_id = client.owner  # always the client's relationship owner
    row.assigned_am_id = routed_am(db, values["brand"])  # always the brand's current routing


def _with_new_client(db: Session, actor: Actor, data: dict, now: datetime) -> tuple[dict, list]:
    """A "newClient" in the form: create it first (same transaction) and use it as the request's client."""
    new_client = data.get("newClient")
    data = {k: v for k, v in data.items() if k != "newClient"}
    if not new_client:
        return data, []
    from .clients import add_client_inline  # here, not at the top: clients imports this module
    client, warnings = add_client_inline(db, actor, new_client, data.get("brand"), now)
    return {**data, "clientId": client.id}, warnings


def create_request(db: Session, actor: Actor, data: dict, *, submit: bool, now: datetime) -> dict:
    """Creates a Draft (private to its creator); with submit=True also submits it, all or nothing."""
    begin_write(db)
    data, client_warnings = _with_new_client(db, actor, data, now)
    checked = _check(db, actor, data, now, submit)
    values, client = checked["values"], checked["client"]
    row = ProposalRequest(id=next_request_id(db, now), created_by_id=actor.user_id, status="draft", version=1,
                          am_price=None, submitted_at=None, submitted_by_id=None, last_updated=now,
                          created_at=now, updated_at=now)
    _apply_fields(db, row, values, client)
    row.history = [RequestStatusHistory(
        seq=1, status="draft", changed_by_id=actor.user_id, role=actor.active_role, changed_at=now, note=None,
        version=1, on_behalf_of_id=client.owner if actor.user_id != client.owner else None,
    )]
    db.add(row)
    db.flush()
    warnings = client_warnings + _duplicate_warnings(db, values, row.id)
    if submit:
        outcome = perform_action(db, actor, row, "submit", {}, now)
        return {"row": row, "message": outcome["message"], "warnings": warnings + outcome["warnings"]}
    return {"row": row, "message": f"{row.id} saved as a draft. Only you can see it until it is submitted.",
            "warnings": warnings}


def update_draft(db: Session, actor: Actor, row: ProposalRequest, data: dict, *, submit: bool,
                 now: datetime) -> dict:
    """Edits a Draft in place (same id; no history entry); with submit=True also submits it."""
    view = request_from_orm(row)
    if row.status != "draft":
        raise ApiError(409, "invalid_transition", "Only drafts can be edited.")
    permission = check_actors([CREATOR], view, actor, _users(db))
    if not permission["allowed"]:
        raise ApiError(403, "forbidden", permission["reason"])
    data, client_warnings = _with_new_client(db, actor, data, now)
    checked = _check(db, actor, data, now, submit)
    _apply_fields(db, row, checked["values"], checked["client"])
    row.last_updated = now
    row.updated_at = now
    db.flush()
    warnings = client_warnings + _duplicate_warnings(db, checked["values"], row.id)
    if submit:
        outcome = perform_action(db, actor, row, "submit", {}, now)
        return {"row": row, "message": outcome["message"], "warnings": warnings + outcome["warnings"]}
    return {"row": row, "message": f"{row.id} draft saved. Only you can see it until it is submitted.",
            "warnings": warnings}


# ---------- "Set waiting on" ----------

WAITING_FIELDS = ("waiting_team", "waiting_user_id", "waiting_reason", "waiting_expected_by", "waiting_note",
                  "waiting_set_at", "waiting_set_by_id")


def _clear_waiting(row: ProposalRequest) -> None:
    for name in WAITING_FIELDS:
        setattr(row, name, None)


def waiting_summary(team, user_id, reason, expected_by, users: dict, lists: dict) -> str:
    """ "Waiting on: Marketing — Nada · Design / creative · expected 2026-10-25" (stored in history)."""
    w = {"team": team, "userId": user_id}
    label = waiting_rules.waiting_label(w, users)
    reason_label = option_label(lists, waiting_rules.TEAMS[team]["reasons"], reason)
    parts = [f"Waiting on: {label}", reason_label] + ([f"expected {expected_by}"] if expected_by else [])
    return " · ".join(p for p in parts if p)


def load_for_waiting(db: Session, request_id: str, actor: Actor, expected_row_version: int | None) -> ProposalRequest:
    """
    Like load_for_write, but the person or team a request waits on may also load it to clear it
    ("Done — back to …"), even when their role does not see proposal data.
    """
    if expected_row_version is None:
        raise validation("Please fix the highlighted fields.", {
            "expectedRowVersion": "Required. Send the rowVersion of the request as you last loaded it."})
    begin_write(db)
    row = db.scalars(select(ProposalRequest).where(ProposalRequest.id == request_id)
                     .options(selectinload(ProposalRequest.history)).with_for_update()).first()
    users = _users(db)
    if row is None:
        raise not_found(f"Request {request_id!r} not found.")
    view = request_from_orm(row)
    if not can_see_request(view, actor, users) and not waiting_rules.can_clear_waiting_on(view, actor, users)["allowed"]:
        raise not_found(f"Request {request_id!r} not found.")
    if row.row_version != expected_row_version:
        raise stale()
    return row


def set_waiting_on(db: Session, actor: Actor, row: ProposalRequest, data: dict, now: datetime) -> dict:
    users = _users(db)
    view = request_from_orm(row)
    permission = waiting_rules.can_set_waiting_on(view, actor, users)
    if not permission["allowed"]:
        raise ApiError(403, "forbidden", permission["reason"])
    lists = load_lists(db)
    checked = waiting_rules.validate_waiting_on(data, lists=lists, users=users, today=cairo_today_iso(now))
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    row.waiting_team, row.waiting_user_id, row.waiting_reason = v["team"], v["userId"], v["reason"]
    row.waiting_expected_by, row.waiting_note = _date(v["expectedBy"]), v["note"]
    row.waiting_set_at, row.waiting_set_by_id = now, actor.user_id
    row.updated_at = now
    summary = waiting_summary(v["team"], v["userId"], v["reason"], v["expectedBy"], users, lists)
    db.add(RequestEvent(request_id=row.id, event="waiting_on_set", changed_by_id=actor.user_id, role=actor.active_role,
                        changed_at=now, to_user_id=v["userId"], details={"team": v["team"]},
                        note=summary + (f" — {v['note']}" if v["note"] else "")))
    db.flush()
    return {"row": row, "message": summary + ".", "warnings": []}


def clear_waiting_on(db: Session, actor: Actor, row: ProposalRequest, now: datetime) -> dict:
    users = _users(db)
    view = request_from_orm(row)
    permission = waiting_rules.can_clear_waiting_on(view, actor, users)
    if not permission["allowed"]:
        raise ApiError(403 if row.waiting_team else 409, "forbidden" if row.waiting_team else "invalid_transition",
                       permission["reason"])
    was = waiting_summary(row.waiting_team, row.waiting_user_id, row.waiting_reason,
                          row.waiting_expected_by.isoformat() if row.waiting_expected_by else None, users, load_lists(db))
    _clear_waiting(row)
    row.updated_at = now
    back = waiting_rules.waiting_label(waiting_rules.effective_waiting(request_from_orm(row)), users)
    db.add(RequestEvent(request_id=row.id, event="waiting_on_cleared", changed_by_id=actor.user_id,
                        role=actor.active_role, changed_at=now, note=f"{was} — done; back to {back}"))
    db.flush()
    return {"row": row, "message": f"Back to {back}.", "warnings": []}


def waiting_on_me(db: Session, actor: Actor) -> list[ProposalRequest]:
    """Open requests waiting by hand on this person, or on their team with no one named (Marketing / Operations)."""
    rows = db.scalars(select(ProposalRequest).where(ProposalRequest.waiting_team.is_not(None))
                      .options(selectinload(ProposalRequest.history))).all()
    out = []
    for row in rows:
        view = request_from_orm(row)
        team = waiting_rules.TEAMS.get(row.waiting_team)
        mine = row.waiting_user_id == actor.user_id or (
            not row.waiting_user_id and team is not None and actor.active_role in team["roles"])
        if mine and waiting_rules.effective_waiting(view):
            out.append(row)
    return sorted(out, key=lambda r: r.waiting_set_at or r.updated_at)


# ---------- "Update details" (BD owner, Commercial Head) ----------

def update_details(db: Session, actor: Actor, row: ProposalRequest, data: dict, now: datetime) -> dict:
    """Changes event name, dates, participants, brief or deadline of a submitted, open request. Every change is
    recorded before -> after; the assigned AM sees "Details changed" until they open the request."""
    view = request_from_orm(row)
    permission = conversation.can_update_details(view, actor, _users(db))
    if not permission["allowed"]:
        raise ApiError(403, "forbidden", permission["reason"])
    checked = conversation.validate_details_update(view, data, today=cairo_today_iso(now), lists=load_lists(db))
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    if not checked["changes"]:
        raise validation("Nothing changed.", {})
    v = checked["values"]
    for c in checked["changes"]:
        f = c["field"]
        if f in ("eventDate", "eventDatePrecision"):
            row.event_date_precision = v["eventDatePrecision"]
            row.event_date = _event_date(v["eventDate"], v["eventDatePrecision"])
            row.event_end_date = _date(v.get("eventEndDate"))
        elif f == "eventEndDate":
            row.event_end_date = _date(v.get("eventEndDate"))
        elif f == "requiredBy":
            row.required_by = _date(v["requiredBy"])
        elif f == "participants":
            row.participants = v["participants"]
        elif f == "eventName":
            row.event_name = v["eventName"]
        elif f == "requirementsSummary":
            row.requirements_summary = v["requirementsSummary"]
        elif f == "specificRequirements":
            row.specific_requirements = v["specificRequirements"]
    raw_note = data.get("note")
    note = raw_note.strip()[:300] if isinstance(raw_note, str) and raw_note.strip() else None
    row.details_changed_at = now
    row.updated_at = now
    summary = "; ".join(f"{c['label']}: {c['from'] if c['from'] not in (None, '') else '—'} → "
                        f"{c['to'] if c['to'] not in (None, '') else '—'}" for c in checked["changes"])
    db.add(RequestEvent(request_id=row.id, event="details_updated", changed_by_id=actor.user_id, role=actor.active_role,
                        changed_at=now, note=note, details={"changes": checked["changes"], "summary": summary}))
    db.flush()
    return {"row": row, "message": f"Details updated: {summary}.", "warnings": []}


def mark_details_seen(db: Session, actor: Actor, row: ProposalRequest, now: datetime) -> dict:
    """The assigned AM has seen the changed details ("No change needed", or opening the request)."""
    if not (actor.user_id == row.assigned_am_id and actor.active_role == "account_manager"):
        raise ApiError(403, "forbidden", "Only the assigned Account Manager confirms they have seen the changes.")
    if row.details_changed_at is None or (row.details_seen_at and row.details_seen_at >= row.details_changed_at):
        return {"row": row, "message": "Nothing new.", "warnings": []}
    row.details_seen_at = now
    db.add(RequestEvent(request_id=row.id, event="details_seen", changed_by_id=actor.user_id, role=actor.active_role,
                        changed_at=now, note=None))
    db.flush()
    return {"row": row, "message": "Noted: no change needed.", "warnings": []}
