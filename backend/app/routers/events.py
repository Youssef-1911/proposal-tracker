"""
Confirmed events (a request marked confirmed). Everyone who may see the request, plus Marketing and
Operations, who see confirmed events only, without prices, and may comment (domain/events.py).
The event has its own status: Initially confirmed (planning only) -> Confirmed, or Postponed / Cancelled.
"Confirm event", "Event postponed", "Change date" and "Event cancelled": the BD owner or the Commercial Head;
every change is recorded and goes to all Operations users. The Operations page also lists the pipeline
(proposals being prepared or with the client) with a few awareness fields only: no price, files or conversation.
"""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..clock import cairo_today_iso, get_now, iso_z
from ..database import begin_write, get_db
from ..domain import events as rules
from ..domain.access import can_see_request
from ..domain.corrections import can_correct_status
from ..domain.proposal_files import MIME, download_file_name
from ..domain.request_form import event_start_date
from ..domain.views import iso_date, request_from_orm
from ..errors import ApiError, not_found, stale, validation
from ..identity import Actor, get_current_actor
from ..domain.workflow import confirm_event_errors, confirmed_fields
from ..models import Client, Notification, ProposalRequest, RequestComment, RequestEvent
from ..services import proposal_files as files_service
from ..services.notifications import notify_operations
from .staffing import staffing_detail
from ..services.lists import load_lists
from .proposal_requests import _comment_out, _users

router = APIRouter(prefix="/api/events", tags=["events"])


class _In(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class DateIn(_In):
    expected_row_version: int | None = None
    event_date: Any = None
    event_end_date: Any = None
    note: Any = None


class CancelIn(_In):
    expected_row_version: int | None = None
    reason: Any = None
    note: Any = None


class ConfirmIn(_In):
    expected_row_version: int | None = None
    event_date: Any = None
    event_end_date: Any = None
    final_participants: Any = None
    final_price: Any = None
    venue: Any = None
    team_notes: Any = None


class EventCommentIn(_In):
    body: Any = None


def _timing(view, today: str) -> str | None:
    return rules.event_timing({"status": view.status, "imported": view.imported, "originalStatus": view.original_status,
                               "eventDate": view.event_date, "eventEndDate": view.event_end_date,
                               "eventDatePrecision": view.event_date_precision,
                               "eventCancelledAt": iso_z(view.event_cancelled_at), "eventStatus": view.event_status}, today)



def _summary(row, view, actor, users, names) -> dict:
    out = {
        "id": row.id, "clientId": row.client_id, "clientName": names.get(row.client_id), "eventName": row.event_name,
        "brand": row.brand, "service": row.service, "eventDate": view.event_date, "eventEndDate": view.event_end_date,
        "eventDatePrecision": view.event_date_precision,
        "participants": row.confirmed_participants if row.confirmed_participants is not None else row.participants,
        "bdOwner": row.bd_owner_id, "assignedAM": row.assigned_am_id, "status": row.status, "imported": row.imported,
        "originalStatus": row.original_status, "venue": row.venue, "submittedAt": iso_z(row.submitted_at),
        "eventCancelledAt": iso_z(row.event_cancelled_at), "eventCancelReason": row.event_cancel_reason,
        "eventCancelNote": row.event_cancel_note, "rowVersion": row.row_version,
        "eventStatus": rules.view_event_status(view), "eventPostponeReason": row.event_postpone_reason,
        "eventPostponeNote": row.event_postpone_note,
        "eventActions": rules.event_actions(view, actor, users),
        "canOpenRequest": can_see_request(view, actor, users),
        "canManage": rules.can_manage_event(view, actor, users),
        "correctStatus": can_correct_status(view, actor, users),
    }
    if rules.can_see_event_price(actor):  # never for Marketing or Operations
        out["finalPrice"] = row.final_price if row.final_price is not None else row.am_price
    return out


def _load(db: Session, event_id: str, actor: Actor):
    row = db.scalars(select(ProposalRequest).where(ProposalRequest.id == event_id)
                     .options(selectinload(ProposalRequest.history), selectinload(ProposalRequest.files))).first()
    users = _users(db)
    if row is None or not rules.can_see_event(request_from_orm(row), actor, users):
        raise not_found(f"Event {event_id!r} not found.")  # unconfirmed proposals are never events
    return row, users


def _names(db: Session) -> dict:
    return {c.id: c.name for c in db.scalars(select(Client)).all()}


@router.get("")
def list_events(actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    today = cairo_today_iso(now)
    users = _users(db)
    names = _names(db)
    rows = db.scalars(select(ProposalRequest).where(ProposalRequest.status.in_(("accepted",) + rules.PIPELINE))
                      .options(selectinload(ProposalRequest.history))).all()
    items, pipeline = [], []
    for row in rows:
        view = request_from_orm(row)
        if row.status == "accepted":
            if rules.can_see_event(view, actor, users):
                items.append({**_summary(row, view, actor, users, names), "timing": _timing(view, today)})
        elif rules.can_see_pipeline_item(view, actor, users):
            pipeline.append(_pipeline_item(row, view, names))
    return {"items": items, "total": len(items), "pipeline": pipeline, "today": today,
            "seePrices": rules.can_see_event_price(actor), "newIds": _new_ids(db, actor)}


def _pipeline_item(row, view, names) -> dict:
    """Awareness only: exactly PIPELINE_FIELDS (no price, files or conversation)."""
    values = {"id": row.id, "clientId": row.client_id, "clientName": names.get(row.client_id), "eventName": row.event_name,
              "eventDate": view.event_date, "eventEndDate": view.event_end_date,
              "eventDatePrecision": view.event_date_precision, "participants": row.participants, "brand": row.brand,
              "status": row.status}
    return {k: values[k] for k in rules.PIPELINE_FIELDS}


def _new_ids(db: Session, actor: Actor) -> list[str]:
    """Events with an unread event notification for this person (the "New" mark)."""
    ids = set()
    for n in db.scalars(select(Notification).where(Notification.user_id == actor.user_id, Notification.kind == "event",
                                                   Notification.read_at.is_(None))).all():
        ids.update(n.request_ids or [])
    return sorted(ids)


def _detail(db: Session, row, users, actor, today: str) -> dict:
    view = request_from_orm(row)
    client = db.get(Client, row.client_id)
    contact = next((c for c in (client.contacts if client else []) if c.is_primary and not c.archived_at), None)
    current = files_service.visible_files(row.files, False)
    latest = max(current, key=lambda f: (f.version, f.id), default=None)
    out = {
        **_summary(row, view, actor, users, _names(db)), "timing": _timing(view, today),
        "brief": row.requirements_summary, "specificRequirements": row.specific_requirements,
        "briefTags": row.brief_tags or [], "teamNotes": row.team_notes,
        "contact": None if contact is None else {"name": contact.name, "phone": contact.phone, "email": contact.email},
        "file": None if latest is None else {"id": latest.id, "version": latest.version, "type": latest.file_type,
                                             "name": latest.original_name},
        "comments": [_comment_out(c) for c in row.comments if c.kind == "comment"],
        "changes": [{"event": e.event, "changedBy": e.changed_by_id, "changedAt": iso_z(e.changed_at), "note": e.note,
                     "details": e.details}
                    for e in db.scalars(select(RequestEvent).where(RequestEvent.request_id == row.id,
                                                                   RequestEvent.event.in_(EVENT_CHANGES))
                                        .order_by(RequestEvent.id)).all()],
        "confirmedBy": next((h.changed_by_id for h in reversed(row.history) if h.status == "accepted" and not h.imported), None),
        **staffing_detail(db, row, actor, today),
    }
    if actor.active_role == "hr":  # staffing only: never files, conversations or the client's contact
        out.update({"file": None, "comments": [], "contact": None, "canOpenRequest": False})
    return out


@router.get("/{event_id}")
def get_event(event_id: str, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
              db: Session = Depends(get_db)):
    today = cairo_today_iso(now)
    row, users = _load(db, event_id, actor)
    return _detail(db, row, users, actor, today)


EVENT_CHANGES = ("event_status_set", "event_confirmed", "event_postponed", "event_date_changed", "event_cancelled")


@router.post("/{event_id}/read", status_code=204)
def mark_event_read(event_id: str, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                    db: Session = Depends(get_db)):
    """Opening an event clears its "New" mark (this person's event notifications for it)."""
    begin_write(db)
    _load(db, event_id, actor)
    for n in db.scalars(select(Notification).where(Notification.user_id == actor.user_id, Notification.kind == "event",
                                                   Notification.read_at.is_(None))).all():
        if event_id in (n.request_ids or []):
            n.read_at = now
    db.commit()
    return Response(status_code=204)


def _for_write(db: Session, event_id: str, actor: Actor, expected: int | None, action: str | None = None):
    if expected is None:
        raise validation("Please fix the highlighted fields.", {
            "expectedRowVersion": "Required. Send the rowVersion of the event as you last loaded it."})
    begin_write(db)
    row, users = _load(db, event_id, actor)
    if row.row_version != expected:
        raise stale()
    view = request_from_orm(row)
    permission = rules.can_manage_event(view, actor, users)
    if not permission["allowed"]:
        raise ApiError(403, "forbidden", permission["reason"])
    if action is not None and action not in rules.event_actions(view, actor, users):
        raise ApiError(409, "invalid_transition", f"This event is {rules.view_event_status(view)}; it cannot be {action}ed now.")
    return row, users


def _saved(db: Session, event_id: str, actor: Actor, today: str, message: str) -> dict:
    db.commit()
    db.expire_all()
    row, users = _load(db, event_id, actor)
    return {"event": _detail(db, row, users, actor, today), "message": message, "warnings": []}


def _record(db: Session, actor: Actor, row, event: str, now: datetime, note=None, details=None) -> None:
    row.updated_at = now
    db.add(RequestEvent(request_id=row.id, event=event, changed_by_id=actor.user_id, role=actor.active_role,
                        changed_at=now, note=note, details=details))


@router.post("/{event_id}/confirm")
def confirm_event(event_id: str, body: ConfirmIn, actor: Actor = Depends(get_current_actor),
                  now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """Initially confirmed (or Postponed) -> Confirmed, with the same fields as "Mark confirmed"."""
    today = cairo_today_iso(now)
    row, _ = _for_write(db, event_id, actor, body.expected_row_version, "confirm")
    data = {**body.model_dump(by_alias=True), "eventStatus": "confirmed"}
    errors = confirm_event_errors(data)
    if errors:
        raise validation("Please fix the highlighted fields.", errors)
    v = confirmed_fields(data)
    before = row.event_status or "confirmed"
    row.event_date_precision = "day"
    row.event_date = datetime.fromisoformat(v["eventDate"]).date()
    row.event_end_date = datetime.fromisoformat(v["eventEndDate"]).date() if v["eventEndDate"] else None
    row.confirmed_participants = v["confirmedParticipants"]
    if rules.can_see_event_price(actor):
        row.final_price = v["finalPrice"]
    row.venue, row.team_notes = v["venue"], v["teamNotes"]
    row.event_status, row.event_postpone_reason, row.event_postpone_note = "confirmed", None, None
    _record(db, actor, row, "event_confirmed", now, details={"from": before})
    notify_operations(db, actor, row, "Event confirmed", now)
    return _saved(db, event_id, actor, today, "Event confirmed.")


@router.post("/{event_id}/postpone")
def postpone_event(event_id: str, body: CancelIn, actor: Actor = Depends(get_current_actor),
                   now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """The event is on hold (Initially confirmed or Confirmed -> Postponed); "Confirm event" brings it back."""
    today = cairo_today_iso(now)
    row, _ = _for_write(db, event_id, actor, body.expected_row_version, "postpone")
    checked = rules.validate_event_postpone(body.model_dump(by_alias=True), load_lists(db))
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    before = row.event_status or "confirmed"
    row.event_status, row.event_postpone_reason, row.event_postpone_note = "postponed", v["reason"], v["note"]
    _record(db, actor, row, "event_postponed", now, note=v["note"], details={"from": before, "reason": v["reason"]})
    notify_operations(db, actor, row, "Event postponed", now, v["note"])
    return _saved(db, event_id, actor, today, "Event marked as postponed.")


@router.patch("/{event_id}/date")
def change_date(event_id: str, body: DateIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                db: Session = Depends(get_db)):
    """A new date for a confirmed event (it stays Upcoming); recorded before -> after."""
    today = cairo_today_iso(now)
    row, users = _for_write(db, event_id, actor, body.expected_row_version)
    checked = rules.validate_event_date_change(request_from_orm(row), body.model_dump(by_alias=True))
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    before = {"eventDate": iso_date(row.event_date) if row.event_date_precision == "day" else None,
              "eventEndDate": iso_date(row.event_end_date)}
    row.event_date_precision = "day"
    row.event_date = datetime.fromisoformat(event_start_date(v["eventDate"], "day")).date()
    row.event_end_date = datetime.fromisoformat(v["eventEndDate"]).date() if v["eventEndDate"] else None
    _record(db, actor, row, "event_date_changed", now, note=v["note"],
            details={"from": before, "to": {"eventDate": v["eventDate"], "eventEndDate": v["eventEndDate"]}})
    notify_operations(db, actor, row, "Date changed", now, v["note"])
    return _saved(db, event_id, actor, today, "Date changed.")


@router.post("/{event_id}/cancel")
def cancel_event(event_id: str, body: CancelIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                 db: Session = Depends(get_db)):
    """The confirmed event will not happen: it leaves Upcoming and Done ("Cancelled after confirmation")."""
    today = cairo_today_iso(now)
    row, users = _for_write(db, event_id, actor, body.expected_row_version)
    checked = rules.validate_event_cancel(body.model_dump(by_alias=True), load_lists(db))
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    before = row.event_status or "confirmed"
    row.event_cancelled_at, row.event_cancel_reason, row.event_cancel_note = now, v["reason"], v["note"]
    row.event_status = "cancelled"
    _record(db, actor, row, "event_cancelled", now, note=v["note"], details={"from": before, "reason": v["reason"]})
    notify_operations(db, actor, row, "Event cancelled", now, v["note"])
    return _saved(db, event_id, actor, today, "Event marked as cancelled.")


@router.post("/{event_id}/comments", status_code=201)
def comment(event_id: str, body: EventCommentIn, actor: Actor = Depends(get_current_actor),
            now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """Anyone who sees the event may comment (Marketing and Operations included; not HR: no conversations)."""
    if actor.active_role == "hr":
        raise ApiError(403, "forbidden", "HR does not take part in event conversations.")
    begin_write(db)
    row, _ = _load(db, event_id, actor)
    c = files_service.add_comment(db, actor, row, body.body, now)
    db.commit()
    return {"comment": _comment_out(c)}


@router.get("/{event_id}/file")
def final_file(event_id: str, request: Request, actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    """The final proposal file of a confirmed event (always as a download)."""
    row, _ = _load(db, event_id, actor)
    current = files_service.visible_files(row.files, False)
    f = max(current, key=lambda x: (x.version, x.id), default=None)
    if f is None:
        raise not_found("This event has no proposal file.")
    try:
        data = request.app.state.storage.read(f.storage_key)
    except FileNotFoundError:
        raise not_found("The file's content is missing from storage.") from None
    name = download_file_name(row.id, row.client.name if row.client else None, f.version, f.file_type)
    return Response(content=data, media_type=MIME[f.file_type], headers={
        "Content-Disposition": f'attachment; filename="{name}"', "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, no-store",
    })
