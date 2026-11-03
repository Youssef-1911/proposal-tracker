"""
Data fixes (domain/corrections.py has the rules). Nothing here commits: the router commits once.

- correct_status: "Correct status (data fix)". Jumps straight to the right status, recorded in history
  as "Status corrected from X to Y" (by that person, marked corrected: it never notifies anyone), with the
  opportunity moved to match.
- add_past_record: "Add past proposal or event". Creates the request (and the event when confirmed) with
  history steps from the dates entered, marked "Added manually — before IEE". No notifications.
"""

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import cairo_today_iso
from ..domain import corrections as rules
from ..domain.views import client_from_orm, request_from_orm
from ..errors import ApiError, conflict, validation
from ..identity import Actor
from ..models import Client, Opportunity, ProposalRequest, RequestStatusHistory
from .ids import next_request_id
from .opportunities import create_opportunity, set_opportunity_stage
from .proposal_requests import _clear_waiting, _users

CAIRO = ZoneInfo("Africa/Cairo")
UTC = ZoneInfo("UTC")


def _day(v: str | None) -> date | None:
    return date.fromisoformat(v) if v else None


def _at(day: str, hour: int = 12) -> datetime:
    return datetime.combine(date.fromisoformat(day), time(hour, 0), tzinfo=CAIRO).astimezone(UTC)


def _sync_opportunity(db: Session, actor: Actor, row: ProposalRequest, status: str, lost_reason: str | None,
                      note: str, now: datetime) -> None:
    if not row.opportunity_id:
        return
    opp = db.get(Opportunity, row.opportunity_id)
    stage = rules.stage_for_status(status)
    if opp is None or opp.stage == stage:
        return
    set_opportunity_stage(db, opp, stage, actor=actor, note=note if stage == "lost" else None,
                          lost_reason=(lost_reason or "not_recorded") if stage == "lost" else None,
                          reason_code="status_corrected", source_request_id=row.id, now=now)


def correct_status(db: Session, actor: Actor, row: ProposalRequest, data: dict, now: datetime) -> dict:
    users = _users(db)
    view = request_from_orm(row)
    permission = rules.can_correct_status(view, actor, users)
    if not permission["allowed"]:
        raise ApiError(403, "forbidden", permission["reason"])
    checked = rules.validate_correction(data, view)
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    note = rules.correction_note(v)
    status = v["status"]
    row.status = status
    row.follow_up_on = _day(v["followUpOn"]) if status == "postponed" else None
    row.needs_review = False
    _clear_waiting(row)
    if status == "accepted":
        row.event_date_precision = "day"
        row.event_date = _day(v["eventDate"])
        row.event_end_date = _day(v["eventEndDate"])
        row.final_price = v["finalPrice"]
        row.confirmed_participants = v["finalParticipants"]
        row.event_status = v["eventStatus"]
    else:
        row.event_status = None
    row.last_updated = now
    row.updated_at = now
    row.history.append(RequestStatusHistory(
        seq=max((h.seq for h in row.history), default=0) + 1, status=status, changed_by_id=actor.user_id,
        role=actor.active_role, changed_at=now, note=note, version=row.version,
        lost_reason=v["lostReason"] if status == "rejected" else None,
        follow_up_on=row.follow_up_on, corrected=True,
    ))
    db.flush()  # row_version check (StaleDataError -> 409)
    _sync_opportunity(db, actor, row, status, v["lostReason"], note, now)
    return {"row": row, "message": f"{note}.", "warnings": []}


# ---------- "Add past proposal or event" ----------

def _duplicates(db: Session, client_id: str, brand: str, event_date: str | None) -> list[str]:
    if not event_date:
        return []
    rows = db.scalars(select(ProposalRequest).where(ProposalRequest.client_id == client_id, ProposalRequest.brand == brand,
                                                    ProposalRequest.event_date == date.fromisoformat(event_date))).all()
    return [r.id for r in rows]


def add_past_record(db: Session, actor: Actor, data: dict, now: datetime) -> dict:
    users = _users(db)
    today = cairo_today_iso(now)
    checked = rules.validate_past_record(data, today)
    errors = dict(checked["errors"])
    v = checked["values"]
    new_client = data.get("newClient")
    client = db.get(Client, data.get("clientId")) if data.get("clientId") else None
    if not new_client and (client is None or client.archived_at is not None):
        errors["clientId"] = "Choose the client (or add a new one)."
    owner = users.get(v["bdOwner"]) if v["bdOwner"] else None
    if v["bdOwner"] and owner is None:
        errors["bdOwner"] = "Choose the BD owner."
    am = users.get(v["assignedAM"]) if v["assignedAM"] else None
    if v["assignedAM"] and (am is None or "account_manager" not in am.roles):
        errors["assignedAM"] = "Choose an Account Manager."
    if errors:
        raise validation("Please fix the highlighted fields.", errors)
    permission = rules.can_add_past_record(actor, users, client=client_from_orm(client) if client else None, brand=v["brand"])
    if not permission["allowed"]:
        raise ApiError(403, "forbidden", permission["reason"])
    if client is not None:
        dupes = _duplicates(db, client.id, v["brand"], v["eventDate"])
        if dupes and not data.get("confirmDuplicate"):
            raise conflict(f"Possible duplicate: {', '.join(dupes)} has the same client, brand and event date. "
                           "Check it, or confirm to add this one anyway.", code="possible_duplicate")
    warnings = []
    if new_client:
        from .clients import add_client_inline  # here, not at the top: clients imports proposal_requests
        client, warnings = add_client_inline(db, actor, new_client, v["brand"], now)

    steps = rules.past_history(v, today)
    status = steps[-1]["status"]
    submitted = _at(v["briefDate"], 9)
    last = _at(steps[-1]["day"])
    event_date = _day(v["eventDate"])
    opp = create_opportunity(
        db, actor=actor, client_id=client.id, brand=v["brand"], service=v["service"], owner_id=v["bdOwner"],
        stage=rules.stage_for_status(status), event_date=event_date, participants=v["participants"],
        lost_reason=(v["lostReason"] or "not_recorded") if status == "rejected" else None,
        reason_code="imported", note=rules.PAST_NOTE, now=submitted, allow_inactive_owner=True,
    )
    opp.event_name = v["eventName"]
    opp.event_end_date = _day(v["eventEndDate"])
    follow_up = next((_day(s.get("followUpOn")) for s in steps if s["status"] == "postponed"), None)
    row = ProposalRequest(
        id=next_request_id(db, submitted), opportunity_id=opp.id, client_id=client.id, brand=v["brand"],
        service=v["service"], bd_owner_id=v["bdOwner"], created_by_id=actor.user_id, assigned_am_id=v["assignedAM"],
        submitted_by_id=v["bdOwner"], submitted_at=submitted, status=status, required_by=None,
        event_date=event_date, event_date_precision="day" if event_date else "unset", event_end_date=_day(v["eventEndDate"]),
        follow_up_on=follow_up, participants=v["participants"], requirements_summary=v["notes"],
        specific_requirements=None, am_price=v["amPrice"], version=1, price_change=None, last_updated=last,
        imported=False, event_name=v["eventName"], created_at=now, updated_at=now,
        final_price=v["finalPrice"] if status == "accepted" else None,
        event_status="confirmed" if status == "accepted" else None,
    )
    row.history = [RequestStatusHistory(
        seq=i + 1, status=s["status"], changed_by_id=actor.user_id, role=actor.active_role, changed_at=_at(s["day"], 9 + i),
        note=rules.PAST_NOTE, version=1, am_price=s.get("amPrice"), lost_reason=s.get("lostReason"),
        follow_up_on=_day(s.get("followUpOn")), imported=True,  # shown as "Added manually — before IEE"
    ) for i, s in enumerate(steps)]
    db.add(row)
    db.flush()
    return {"row": row, "message": f"Past record {row.id} added.", "warnings": warnings}


def can_add_past_file(row: ProposalRequest, actor: Actor) -> bool:
    """The proposal file of a record just added by hand: its creator, once (version 1, no file yet)."""
    first = min(row.history, key=lambda h: h.seq, default=None)
    return (first is not None and first.note == rules.PAST_NOTE and row.created_by_id == actor.user_id
            and not row.files)
