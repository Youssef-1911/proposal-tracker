"""
HR staffing: facilitators for confirmed events (domain/staffing.py has the rules; all checked here).

  GET   /api/staffing                          events to staff (HR, Commercial Head, Operations): needed · assigned · missing
  GET   /api/staffing/dashboard                HR numbers
  POST  /api/staffing/ratios/{brand}/{service}  one facilitator per N participants (empty: removed)
  PATCH /api/events/{id}/facilitators-needed   Operations, the assigned AM or Noha (HR is told)
  GET   /api/facilitators · POST /api/facilitators · GET/PATCH /api/facilitators/{id} · POST .../notes
  POST  /api/events/{id}/facilitators          assign (optionally creating the facilitator in the same step)
  POST  /api/events/{id}/facilitators/{fid}/remove
  POST  /api/events/{id}/facilitators/{fid}/rating    one rating per person per facilitator per event (7 days)
  GET   /api/staffing/to-rate                  "Rate facilitators" (HR, Operations): done events still missing ratings
Facilitators never log in. Nothing is deleted (archive; assignments keep removed_at; ratings keep history).
"""

from datetime import date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import cairo_today_iso, get_now, iso_z
from ..config_domain import BRANDS
from ..database import begin_write, get_db
from ..domain import events as event_rules, staffing as rules
from ..domain.views import iso_date, request_from_orm
from ..errors import ApiError, conflict, forbidden, not_found, validation
from ..identity import Actor, get_current_actor
from ..models import (
    Client, Facilitator, FacilitatorAssignment, FacilitatorNote, FacilitatorRating, FacilitatorRatingHistory,
    ProposalRequest, RequestEvent, StaffingRatio,
)
from ..services.lists import load_lists
from .proposal_requests import _users

router = APIRouter(prefix="/api", tags=["staffing"])
SERVICES = {b["id"]: {s["id"]: s["label"] for s in b["services"]} for b in BRANDS}


class _In(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


def _require(allowed: bool, message: str) -> None:
    if not allowed:
        raise forbidden(message)


def _sees_staffing(actor: Actor) -> bool:
    return actor.active_role in ("hr", "operations")  # Staffing and Facilitators: HR and Operations only


def _events(db: Session, actor: Actor, users: dict):
    """Initially confirmed or confirmed events this person may see (HR: those only)."""
    rows = db.scalars(select(ProposalRequest).where(ProposalRequest.status == "accepted")).all()
    return [r for r in rows if event_rules.view_event_status(request_from_orm(r)) in ("initial", "confirmed")
            and event_rules.can_see_event(request_from_orm(r), actor, users)]


def _assigned(db: Session, request_ids) -> dict:
    out: dict = {}
    for a in db.scalars(select(FacilitatorAssignment).where(FacilitatorAssignment.request_id.in_(list(request_ids)),
                                                            FacilitatorAssignment.removed_at.is_(None))).all():
        out.setdefault(a.request_id, []).append(a)
    return out


def _event_out(r: ProposalRequest, names: dict, assigned: list, today: str) -> dict:
    view = request_from_orm(r)
    return {
        "id": r.id, "clientName": names.get(r.client_id), "eventName": r.event_name, "brand": r.brand,
        "service": r.service, "serviceLabel": SERVICES.get(r.brand, {}).get(r.service),
        "eventDate": view.event_date, "eventEndDate": view.event_end_date, "eventDatePrecision": view.event_date_precision,
        "participants": r.confirmed_participants if r.confirmed_participants is not None else r.participants,
        "venue": r.venue, "eventStatus": event_rules.view_event_status(view),
        "timing": event_rules.event_timing({"status": r.status, "eventDate": view.event_date, "eventEndDate": view.event_end_date,
                                            "eventDatePrecision": view.event_date_precision, "eventStatus": r.event_status,
                                            "eventCancelledAt": iso_z(r.event_cancelled_at)}, today),
        "facilitatorsNeeded": r.facilitators_needed, "assignedCount": len(assigned),
    }


@router.get("/staffing")
def staffing(actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    _require(_sees_staffing(actor), "Staffing is for HR and Operations.")
    users = _users(db)
    today = cairo_today_iso(now)
    names = {c.id: c.name for c in db.scalars(select(Client)).all()}
    rows = _events(db, actor, users)
    assigned = _assigned(db, [r.id for r in rows])
    items = [_event_out(r, names, assigned.get(r.id, []), today) for r in rows]
    return {"items": [i for i in items if i["timing"] != "done"], "today": today, "ratios": _ratios(db)}


def _ratios(db: Session) -> dict:
    return {x.service_key: x.per_facilitator for x in db.scalars(select(StaffingRatio)).all()}


class RatioIn(_In):
    per_facilitator: Any = None


@router.post("/staffing/ratios/{brand}/{service}")
def set_ratio(brand: str, service: str, body: RatioIn, actor: Actor = Depends(get_current_actor),
              now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """Settings → Staffing ratios (HR and the Commercial Head): one facilitator per N participants."""
    _require(rules.can_manage_facilitators(actor), "Staffing ratios are set by HR or the Commercial Head.")
    if service not in SERVICES.get(brand, {}):
        raise not_found("No such brand and service.")
    begin_write(db)
    key = f"{brand}:{service}"
    row = db.get(StaffingRatio, key)
    value = body.per_facilitator
    if value in (None, ""):
        if row is not None:
            db.delete(row)
    else:
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise validation("Please fix the highlighted fields.", {"perFacilitator": "Enter a whole number greater than 0."})
        if row is None:
            db.add(StaffingRatio(service_key=key, per_facilitator=value, updated_by_id=actor.user_id, updated_at=now))
        else:
            row.per_facilitator, row.updated_by_id, row.updated_at = value, actor.user_id, now
    db.commit()
    return {"ratios": _ratios(db)}


class NeededIn(_In):
    value: Any = None
    expected_row_version: int | None = None


@router.patch("/events/{event_id}/facilitators-needed")
def set_needed(event_id: str, body: NeededIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
               db: Session = Depends(get_db)):
    """How many facilitators an event needs: Operations, the assigned AM or Noha. HR is told."""
    begin_write(db)
    users = _users(db)
    row = db.get(ProposalRequest, event_id)
    if row is None or not event_rules.can_see_event(request_from_orm(row), actor, users):
        raise not_found(f"Event {event_id!r} not found.")
    _require(rules.can_set_facilitators_needed(request_from_orm(row), actor),
             "Operations, the assigned Account Manager or the Commercial Head set how many facilitators are needed.")
    if body.expected_row_version is not None and body.expected_row_version != row.row_version:
        raise conflict("This event was changed by someone else. Reload and try again.", code="stale")
    value = body.value
    if value not in (None, "") and (not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 500):
        raise validation("Please fix the highlighted fields.", {"value": "Enter a whole number from 0 to 500."})
    before = row.facilitators_needed
    row.facilitators_needed = None if value in (None, "") else value
    row.updated_at = now
    db.add(RequestEvent(request_id=row.id, event="facilitators_needed_set", changed_by_id=actor.user_id,
                        role=actor.active_role, changed_at=now, note=None,
                        details={"from": before, "to": row.facilitators_needed}))
    from ..services.notifications import notify_staff
    notify_staff(db, actor, row, f"Facilitators needed: {row.facilitators_needed if row.facilitators_needed is not None else '—'}",
                 now, roles=("hr",))
    db.commit()
    return {"facilitatorsNeeded": row.facilitators_needed, "rowVersion": row.row_version}


# ---------- the facilitator list ----------

def _ratings(db: Session, facilitator_ids=None, request_ids=None):
    q = select(FacilitatorRating)
    if facilitator_ids is not None:
        q = q.where(FacilitatorRating.facilitator_id.in_(list(facilitator_ids)))
    if request_ids is not None:
        q = q.where(FacilitatorRating.request_id.in_(list(request_ids)))
    return db.scalars(q).all()


def _rating_dicts(ratings):
    return [{"requestId": x.request_id, "raterId": x.rater_id, "stars": x.stars, "attended": x.attended,
             "updatedAt": iso_z(x.updated_at)} for x in ratings]


def _done_ids(db: Session, today: str) -> set:
    out = set()
    for r in db.scalars(select(ProposalRequest).where(ProposalRequest.status == "accepted")).all():
        view = request_from_orm(r)
        if event_rules.event_timing({"status": r.status, "eventDate": view.event_date, "eventEndDate": view.event_end_date,
                                     "eventDatePrecision": view.event_date_precision, "eventStatus": r.event_status,
                                     "eventCancelledAt": iso_z(r.event_cancelled_at)}, today) == "done":
            out.add(r.id)
    return out


def _summary(f: Facilitator, assignments, ratings, done: set, event_days: dict, see_ratings: bool) -> dict:
    mine = [a for a in assignments if a.facilitator_id == f.id and a.removed_at is None]
    record = rules.facilitator_record(_rating_dicts([x for x in ratings if x.facilitator_id == f.id]),
                                      [a.request_id for a in mine if a.request_id in done])
    days = sorted(event_days[a.request_id] for a in mine if a.request_id in done and event_days.get(a.request_id))
    out = {"id": f.id, "name": f.name, "phone": f.phone, "reference": f.reference, "skills": f.skills or [],
           "brands": f.brands or [], "status": f.status, "archived": f.archived_at is not None,
           "eventsAttended": record["attended"], "assignedDone": record["assignedDone"],
           "firstEvent": days[0] if days else None, "lastEvent": days[-1] if days else None}
    if see_ratings:
        out.update({"average": record["average"], "ratingCount": record["ratings"]})
    return out


def _list_context(db: Session, today: str):
    assignments = db.scalars(select(FacilitatorAssignment)).all()
    ratings = _ratings(db)
    done = _done_ids(db, today)
    days = {r.id: iso_date(r.event_end_date or r.event_date) for r in db.scalars(select(ProposalRequest)
                                                                                  .where(ProposalRequest.status == "accepted")).all()}
    return assignments, ratings, done, days


def _can_see_list(actor: Actor) -> bool:
    return _sees_staffing(actor)


@router.get("/facilitators")
def list_facilitators(actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                      db: Session = Depends(get_db)):
    _require(_can_see_list(actor), "The facilitator list is for HR and Operations.")
    today = cairo_today_iso(now)
    assignments, ratings, done, days = _list_context(db, today)
    items = [_summary(f, assignments, ratings, done, days, rules.can_see_ratings(actor))
             for f in db.scalars(select(Facilitator).where(Facilitator.archived_at.is_(None))).all()]
    items.sort(key=lambda x: (-x["eventsAttended"], x["name"].lower()))  # most attended first (the default sort)
    return {"items": items, "canManage": rules.can_manage_facilitators(actor), "seeRatings": rules.can_see_ratings(actor)}


class FacilitatorIn(_In):
    name: Any = None
    phone: Any = None
    reference: Any = None
    skills: Any = None
    brands: Any = None
    notes: Any = None
    status: Any = None
    confirm_duplicate: bool = False


def _clean_facilitator(db: Session, body: FacilitatorIn, partial: bool = False) -> dict:
    errors, out = {}, {}
    text = lambda v: v.strip() if isinstance(v, str) and v.strip() else None  # noqa: E731
    if not partial or body.name is not None:
        out["name"] = text(body.name)
        if not out["name"]:
            errors["name"] = "Enter the name."
        elif len(out["name"]) > 120:
            errors["name"] = "Use at most 120 characters."
    if not partial or body.phone is not None:
        out["phone"] = text(body.phone)
        if not out["phone"]:
            errors["phone"] = "Enter the phone number."
        elif len(out["phone"]) > 40:
            errors["phone"] = "Use at most 40 characters."
    if body.reference is not None:
        out["reference"] = (text(body.reference) or None)
    if body.skills is not None:
        codes = {o["code"] for o in load_lists(db).get("facilitatorSkills", [])}
        skills = body.skills if isinstance(body.skills, list) else []
        if any(s not in codes for s in skills):
            errors["skills"] = "Choose skills from the list."
        out["skills"] = sorted(set(skills))
    if body.brands is not None:
        brands = body.brands if isinstance(body.brands, list) else []
        if any(b not in SERVICES for b in brands):
            errors["brands"] = "Choose Grasshoppers and/or Team Up."
        out["brands"] = [b for b in SERVICES if b in brands]
    if body.status is not None:
        if body.status not in ("active", "inactive"):
            errors["status"] = "Active or inactive."
        out["status"] = body.status
    if errors:
        raise validation("Please fix the highlighted fields.", errors)
    return out


def _create_facilitator(db: Session, actor: Actor, body: FacilitatorIn, now: datetime) -> Facilitator:
    values = _clean_facilitator(db, body)
    existing = [{"id": f.id, "name": f.name, "phone": f.phone} for f in db.scalars(select(Facilitator)).all()]
    dupes = rules.possible_duplicates(values, existing)
    if dupes and not body.confirm_duplicate:
        raise ApiError(409, "possible_duplicate", "This person may already be in the list.", {"duplicates": dupes})
    f = Facilitator(name=values["name"], phone=values["phone"], reference=values.get("reference"),
                    skills=values.get("skills") or [], brands=values.get("brands") or [], status="active",
                    created_by_id=actor.user_id, created_at=now, updated_at=now)
    db.add(f)
    db.flush()
    note = body.notes.strip() if isinstance(body.notes, str) and body.notes.strip() else None
    if note:
        db.add(FacilitatorNote(facilitator_id=f.id, body=note[:2000], author_id=actor.user_id, created_at=now))
    return f


@router.post("/facilitators", status_code=201)
def create_facilitator(body: FacilitatorIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                       db: Session = Depends(get_db)):
    _require(rules.can_manage_facilitators(actor), "HR or the Commercial Head add facilitators.")
    begin_write(db)
    f = _create_facilitator(db, actor, body, now)
    db.commit()
    return {"facilitator": {"id": f.id, "name": f.name}, "message": f"{f.name} added."}


@router.get("/facilitators/{facilitator_id}")
def get_facilitator(facilitator_id: int, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                    db: Session = Depends(get_db)):
    """The profile: details, upcoming assignments, events history, feedback, ratings over time, notes (HR)."""
    _require(_can_see_list(actor), "The facilitator list is for HR and Operations.")
    f = db.get(Facilitator, facilitator_id)
    if f is None:
        raise not_found("No such facilitator.")
    today = cairo_today_iso(now)
    assignments, ratings, done, days = _list_context(db, today)
    see = rules.can_see_ratings(actor)
    out = _summary(f, assignments, ratings, done, days, see)
    users = _users(db)
    names = {c.id: c.name for c in db.scalars(select(Client)).all()}
    mine = [a for a in assignments if a.facilitator_id == f.id and a.removed_at is None]
    rows = {r.id: r for r in db.scalars(select(ProposalRequest).where(ProposalRequest.id.in_([a.request_id for a in mine]))).all()}
    mine_ratings = [x for x in ratings if x.facilitator_id == f.id]

    def line(a):
        r = rows[a.request_id]
        view = request_from_orm(r)
        given = [x for x in mine_ratings if x.request_id == r.id]
        return {"requestId": r.id, "eventDate": view.event_date, "eventEndDate": view.event_end_date,
                "clientName": names.get(r.client_id), "eventName": r.event_name, "brand": r.brand,
                **({"ratings": [{"stars": x.stars, "attended": x.attended, "rater": users[x.rater_id].name
                                 if x.rater_id in users else x.rater_id} for x in given]} if see else {})}
    out["upcoming"] = sorted((line(a) for a in mine if a.request_id not in done), key=lambda x: x["eventDate"] or "")
    out["history"] = sorted((line(a) for a in mine if a.request_id in done), key=lambda x: x["eventDate"] or "", reverse=True)
    if see:
        out["feedback"] = sorted(({"stars": x.stars, "feedback": x.feedback, "requestId": x.request_id,
                                   "eventName": rows[x.request_id].event_name if x.request_id in rows else None,
                                   "rater": users[x.rater_id].name if x.rater_id in users else x.rater_id,
                                   "at": iso_z(x.updated_at)} for x in mine_ratings if x.feedback),
                                 key=lambda x: x["at"], reverse=True)
    if actor.active_role == "hr":  # notes: HR only
        out["notes"] = [{"body": n.body, "author": users[n.author_id].name if n.author_id in users else n.author_id,
                         "at": iso_z(n.created_at)}
                        for n in db.scalars(select(FacilitatorNote).where(FacilitatorNote.facilitator_id == f.id)
                                            .order_by(FacilitatorNote.id.desc())).all()]
    out["canManage"] = rules.can_manage_facilitators(actor)
    return out


@router.patch("/facilitators/{facilitator_id}")
def update_facilitator(facilitator_id: int, body: FacilitatorIn, actor: Actor = Depends(get_current_actor),
                       now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """Edit details, or mark active / inactive (HR, Noha)."""
    _require(rules.can_manage_facilitators(actor), "HR or the Commercial Head edit facilitators.")
    begin_write(db)
    f = db.get(Facilitator, facilitator_id)
    if f is None:
        raise not_found("No such facilitator.")
    values = _clean_facilitator(db, body, partial=True)
    for k, v in values.items():
        setattr(f, k, v)
    f.updated_at = now
    db.commit()
    return {"message": f"{f.name} saved."}


class NoteIn(_In):
    body: Any = None


@router.post("/facilitators/{facilitator_id}/notes", status_code=201)
def add_note(facilitator_id: int, body: NoteIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
             db: Session = Depends(get_db)):
    _require(rules.can_manage_facilitators(actor), "HR or the Commercial Head add notes.")
    begin_write(db)
    if db.get(Facilitator, facilitator_id) is None:
        raise not_found("No such facilitator.")
    text = body.body.strip() if isinstance(body.body, str) else ""
    if not text or len(text) > 2000:
        raise validation("Please fix the highlighted fields.", {"body": "Write a note (at most 2000 characters)."})
    db.add(FacilitatorNote(facilitator_id=facilitator_id, body=text, author_id=actor.user_id, created_at=now))
    db.commit()
    return {"message": "Note added."}


# ---------- assigning ----------

class AssignIn(_In):
    facilitator_id: int | None = None
    new_facilitator: FacilitatorIn | None = None


def _event_for_staffing(db: Session, actor: Actor, event_id: str) -> ProposalRequest:
    users = _users(db)
    row = db.get(ProposalRequest, event_id)
    if row is None or not event_rules.can_see_event(request_from_orm(row), actor, users) \
            or event_rules.view_event_status(request_from_orm(row)) not in ("initial", "confirmed"):
        raise not_found(f"Event {event_id!r} not found.")
    return row


def _same_day(db: Session, row: ProposalRequest, facilitator_id: int) -> list[str]:
    others = db.scalars(select(FacilitatorAssignment).where(FacilitatorAssignment.facilitator_id == facilitator_id,
                                                            FacilitatorAssignment.removed_at.is_(None),
                                                            FacilitatorAssignment.request_id != row.id)).all()
    rows = db.scalars(select(ProposalRequest).where(ProposalRequest.id.in_([a.request_id for a in others]))).all()

    def shape(r):
        v = request_from_orm(r)
        return {"id": r.id, "eventDate": v.event_date, "eventEndDate": v.event_end_date, "eventDatePrecision": v.event_date_precision}
    return rules.clashes(shape(row), [shape(r) for r in rows if r.status == "accepted"])


@router.post("/events/{event_id}/facilitators", status_code=201)
def assign(event_id: str, body: AssignIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
           db: Session = Depends(get_db)):
    """Assign a facilitator (HR, Noha); typing a new name creates them and assigns them in one step.
    A same-day booking elsewhere is a warning, never a block."""
    _require(rules.can_manage_facilitators(actor), "HR or the Commercial Head assign facilitators.")
    begin_write(db)
    row = _event_for_staffing(db, actor, event_id)
    if body.new_facilitator is not None:
        f = _create_facilitator(db, actor, body.new_facilitator, now)
    else:
        f = db.get(Facilitator, body.facilitator_id) if body.facilitator_id else None
        if f is None or f.archived_at is not None:
            raise validation("Please fix the highlighted fields.", {"facilitatorId": "Choose a facilitator."})
        if f.status != "active":
            raise validation("Please fix the highlighted fields.", {"facilitatorId": f"{f.name} is inactive."})
    already = db.scalars(select(FacilitatorAssignment).where(FacilitatorAssignment.request_id == row.id,
                                                             FacilitatorAssignment.facilitator_id == f.id,
                                                             FacilitatorAssignment.removed_at.is_(None))).first()
    if already is not None:
        raise conflict(f"{f.name} is already assigned to this event.")
    clash = _same_day(db, row, f.id)
    db.add(FacilitatorAssignment(request_id=row.id, facilitator_id=f.id, assigned_by_id=actor.user_id, assigned_at=now))
    db.commit()
    warnings = [{"code": "same_day", "message": f"{f.name} is also on {', '.join(clash)} that day.", "events": clash}] if clash else []
    return {"facilitator": {"id": f.id, "name": f.name}, "message": f"{f.name} assigned.", "warnings": warnings}


@router.post("/events/{event_id}/facilitators/{facilitator_id}/remove")
def unassign(event_id: str, facilitator_id: int, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
             db: Session = Depends(get_db)):
    _require(rules.can_manage_facilitators(actor), "HR or the Commercial Head assign facilitators.")
    begin_write(db)
    row = _event_for_staffing(db, actor, event_id)
    a = db.scalars(select(FacilitatorAssignment).where(FacilitatorAssignment.request_id == row.id,
                                                       FacilitatorAssignment.facilitator_id == facilitator_id,
                                                       FacilitatorAssignment.removed_at.is_(None))).first()
    if a is None:
        raise not_found("Not assigned to this event.")
    a.removed_at, a.removed_by_id = now, actor.user_id
    db.commit()
    return {"message": "Removed from the event."}


def staffing_detail(db: Session, row: ProposalRequest, actor: Actor, today: str) -> dict:
    """The staffing part of an event page (HR, Operations, Noha; ratings only for those who see them)."""
    if not _sees_staffing(actor):
        return {}
    assigned = _assigned(db, [row.id]).get(row.id, [])
    facilitators = {f.id: f for f in db.scalars(select(Facilitator).where(
        Facilitator.id.in_([a.facilitator_id for a in assigned]))).all()}
    ratings = _ratings(db, request_ids=[row.id]) if rules.can_see_ratings(actor) else []
    ratio = _ratios(db).get(f"{row.brand}:{row.service}")
    participants = row.confirmed_participants if row.confirmed_participants is not None else row.participants
    users = _users(db)
    view = request_from_orm(row)
    done = event_rules.event_timing({"status": row.status, "eventDate": view.event_date, "eventEndDate": view.event_end_date,
                                     "eventDatePrecision": view.event_date_precision, "eventStatus": row.event_status}, today) == "done"
    return {"staffing": {
        **rules.staffing_of(row.facilitators_needed, len(assigned)),
        "suggestion": rules.suggested_needed(participants, ratio), "ratio": ratio,
        "canSetNeeded": rules.can_set_facilitators_needed(view, actor),
        "canAssign": rules.can_manage_facilitators(actor) and not done,
        "canRate": rules.can_rate(actor) and done,
        "facilitators": [{"id": f.id, "name": f.name, "phone": f.phone,
                      **({"ratings": [{"rater": users[x.rater_id].name if x.rater_id in users else x.rater_id,
                                       "raterId": x.rater_id, "stars": x.stars, "attended": x.attended, "feedback": x.feedback,
                                       "createdAt": iso_z(x.created_at),
                                       "editable": rules.rating_editable(x.created_at, datetime.now(x.created_at.tzinfo))}
                                      for x in ratings if x.facilitator_id == f.id]} if rules.can_see_ratings(actor) else {})}
                     for f in (facilitators[a.facilitator_id] for a in assigned)],
    }}


# ---------- ratings ----------

class RatingIn(_In):
    stars: Any = None
    attended: Any = None
    feedback: Any = None


@router.post("/events/{event_id}/facilitators/{facilitator_id}/rating")
def rate(event_id: str, facilitator_id: int, body: RatingIn, actor: Actor = Depends(get_current_actor),
         now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """One rating per person per facilitator per event, after the event is done; editable for 7 days, then locked."""
    _require(rules.can_rate(actor), "HR and Operations rate facilitators.")
    begin_write(db)
    users = _users(db)
    row = db.get(ProposalRequest, event_id)
    if row is None or not event_rules.can_see_event(request_from_orm(row), actor, users):
        raise not_found(f"Event {event_id!r} not found.")
    today = cairo_today_iso(now)
    if row.id not in _done_ids(db, today):
        raise conflict("Facilitators are rated once the event is done.")
    if not any(a.facilitator_id == facilitator_id for a in _assigned(db, [row.id]).get(row.id, [])):
        raise not_found("This facilitator is not assigned to this event.")
    checked = rules.validate_rating(body.model_dump(by_alias=True))
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    rating = db.scalars(select(FacilitatorRating).where(FacilitatorRating.request_id == row.id,
                                                        FacilitatorRating.facilitator_id == facilitator_id,
                                                        FacilitatorRating.rater_id == actor.user_id)).first()
    if rating is not None and not rules.rating_editable(rating.created_at, now):
        raise conflict(f"Your rating was given more than {rules.RATING_EDIT_DAYS} days ago and is locked.", code="locked")
    if rating is None:
        rating = FacilitatorRating(request_id=row.id, facilitator_id=facilitator_id, rater_id=actor.user_id,
                                   created_at=now, updated_at=now, **v)
        db.add(rating)
    else:
        rating.stars, rating.attended, rating.feedback, rating.updated_at = v["stars"], v["attended"], v["feedback"], now
    db.flush()
    db.add(FacilitatorRatingHistory(rating_id=rating.id, changed_by_id=actor.user_id, changed_at=now, **v))
    db.commit()
    return {"message": "Rating saved."}


@router.get("/staffing/to-rate")
def to_rate(actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """"Rate facilitators" in My Work: done events where an assigned facilitator has no rating yet (from anyone)."""
    if not rules.can_rate(actor):
        return {"items": []}
    today = cairo_today_iso(now)
    done = _done_ids(db, today)
    assigned = _assigned(db, done)
    rated = {(x.request_id, x.facilitator_id) for x in _ratings(db, request_ids=done)}
    names = {c.id: c.name for c in db.scalars(select(Client)).all()}
    items = []
    for rid, lst in assigned.items():
        missing = [a.facilitator_id for a in lst if (rid, a.facilitator_id) not in rated]
        if missing:
            r = db.get(ProposalRequest, rid)
            items.append({"id": rid, "clientName": names.get(r.client_id), "eventName": r.event_name,
                          "eventDate": iso_date(r.event_end_date or r.event_date), "missing": len(missing)})
    return {"items": sorted(items, key=lambda x: x["eventDate"] or "", reverse=True)}


@router.get("/staffing/dashboard")
def dashboard(actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """HR numbers: facilitators active · events staffed this month · shortage this month · top 5 by events attended ·
    top 5 by average rating (at least 3 ratings)."""
    _require(_sees_staffing(actor), "Staffing numbers are for HR and Operations.")
    today = cairo_today_iso(now)
    users = _users(db)
    rows = [r for r in _events(db, actor, users)]
    assigned = _assigned(db, [r.id for r in rows])
    month = [r for r in rows if (iso_date(r.event_date) or "")[:7] == today[:7] and r.event_date_precision == "day"]
    staffed = sum(1 for r in month if (r.facilitators_needed or 0) > 0
                  and len(assigned.get(r.id, [])) >= r.facilitators_needed)
    shortage = sum(rules.staffing_of(r.facilitators_needed, len(assigned.get(r.id, [])))["missing"] for r in month)
    assignments, ratings, done, days = _list_context(db, today)
    people = [_summary(f, assignments, ratings, done, days, True)
              for f in db.scalars(select(Facilitator).where(Facilitator.archived_at.is_(None))).all()]
    top_attended = sorted((p for p in people if p["eventsAttended"]), key=lambda p: (-p["eventsAttended"], p["name"]))[:5]
    top_rated = sorted((p for p in people if (p.get("ratingCount") or 0) >= rules.MIN_RATINGS_FOR_TOP),
                       key=lambda p: (-(p["average"] or 0), p["name"]))[:5]
    see = rules.can_see_ratings(actor)
    return {"active": sum(1 for p in people if p["status"] == "active"), "staffedThisMonth": staffed,
            "eventsThisMonth": len(month), "shortageThisMonth": shortage,
            "topAttended": [{"id": p["id"], "name": p["name"], "eventsAttended": p["eventsAttended"]} for p in top_attended],
            "topRated": [{"id": p["id"], "name": p["name"], "average": p["average"], "ratingCount": p["ratingCount"]}
                         for p in top_rated] if see else []}
