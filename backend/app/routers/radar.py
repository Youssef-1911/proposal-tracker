"""
The repeat-client radar ("Likely to book soon") and the occasions it uses (domain/radar.py has the rules).

  GET  /api/occasions                         the occasions and their dates (everyone with proposal data)
  POST /api/occasions/{id}/periods            a year's dates (Settings, "Manage accounts")
  POST /api/occasions/periods/{pid}/remove    remove a mistaken period
  GET  /api/radar                             BD: their own clients · Noha and Executives: all (grouped by BD owner)
  POST /api/radar/dismiss                     "Not this time": hidden until the next occurrence (reason recorded)
"""

from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..clock import cairo_today_iso, get_now, iso_z
from ..database import begin_write, get_db
from ..domain import access, radar as rules
from ..domain.request_form import is_real_date
from ..domain.views import iso_date, request_from_orm
from ..errors import forbidden, not_found, validation
from ..identity import Actor, get_current_actor
from ..models import Client, Occasion, OccasionPeriod, ProposalRequest, RadarDismissal
from .proposal_requests import _users

router = APIRouter(prefix="/api", tags=["radar"])


class _In(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


def _occasions(db: Session) -> list[dict]:
    periods = db.scalars(select(OccasionPeriod).order_by(OccasionPeriod.starts_on)).all()
    return [{"id": o.id, "name": o.name,
             "periods": [{"id": p.id, "startsOn": p.starts_on.isoformat(), "endsOn": p.ends_on.isoformat()}
                         for p in periods if p.occasion_id == o.id]}
            for o in db.scalars(select(Occasion).where(Occasion.archived_at.is_(None)).order_by(Occasion.position)).all()]


@router.get("/occasions")
def occasions(actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    return {"items": _occasions(db)}


class PeriodIn(_In):
    starts_on: Any = None
    ends_on: Any = None


def _manage(db: Session, actor: Actor) -> None:
    if not access.has_privilege(_users(db).get(actor.user_id), "manageAccounts"):
        raise forbidden('Occasions are set in Settings by people with "Manage accounts".')


@router.post("/occasions/{occasion_id}/periods", status_code=201)
def add_period(occasion_id: int, body: PeriodIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
               db: Session = Depends(get_db)):
    _manage(db, actor)
    begin_write(db)
    if db.get(Occasion, occasion_id) is None:
        raise not_found("No such occasion.")
    errors = {}
    for key, value in (("startsOn", body.starts_on), ("endsOn", body.ends_on)):
        if not isinstance(value, str) or not is_real_date(value):
            errors[key] = "Enter a valid date."
    if not errors and body.ends_on < body.starts_on:
        errors["endsOn"] = "The end cannot be before the start."
    if errors:
        raise validation("Please fix the highlighted fields.", errors)
    db.add(OccasionPeriod(occasion_id=occasion_id, starts_on=date.fromisoformat(body.starts_on),
                          ends_on=date.fromisoformat(body.ends_on), updated_by_id=actor.user_id, updated_at=now))
    db.commit()
    return {"items": _occasions(db)}


@router.post("/occasions/periods/{period_id}/remove")
def remove_period(period_id: int, actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    _manage(db, actor)
    begin_write(db)
    p = db.get(OccasionPeriod, period_id)
    if p is None:
        raise not_found("No such dates.")
    db.delete(p)  # dates are settings, not history: a typo can be removed
    db.commit()
    return {"items": _occasions(db)}


def request_dict(r: ProposalRequest) -> dict:
    """A request in the radar's (frontend's) shape."""
    v = request_from_orm(r)
    return {"id": r.id, "clientId": r.client_id, "status": r.status, "occasionId": r.occasion_id,
            "submittedAt": iso_z(r.submitted_at), "eventDate": v.event_date, "eventEndDate": v.event_end_date,
            "eventName": r.event_name,
            "statusHistory": [{"status": h.status, "changedAt": iso_z(h.changed_at)} for h in sorted(r.history, key=lambda h: h.seq)]}


def radar_for(db: Session, actor: Actor, today: str) -> list[dict]:
    """The radar this person sees: BD their own clients; the Commercial Head and Executives every client."""
    role = actor.active_role
    if role not in ("business_development", "commercial_head", "executive") and not (
            access.acts_as_business_development(actor, _users(db).get(actor.user_id))):
        return []
    clients = {c.id: {"name": c.name, "owner": c.owner_id} for c in db.scalars(select(Client).where(Client.archived_at.is_(None))).all()}
    if role not in ("commercial_head", "executive"):
        clients = {k: v for k, v in clients.items() if v["owner"] == actor.user_id}
    rows = db.scalars(select(ProposalRequest).options(selectinload(ProposalRequest.history))).all()
    periods = [{"occasionId": p.occasion_id, "name": o.name, "startsOn": p.starts_on.isoformat(), "endsOn": p.ends_on.isoformat()}
               for p, o in db.execute(select(OccasionPeriod, Occasion).join(Occasion, Occasion.id == OccasionPeriod.occasion_id)).all()]
    dismissals = [{"clientId": d.client_id, "signal": d.signal, "until": d.until.isoformat()}
                  for d in db.scalars(select(RadarDismissal)).all()]
    return rules.radar_items([request_dict(r) for r in rows], periods, dismissals, clients, today)


@router.get("/radar")
def radar(actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    today = cairo_today_iso(now)
    items = radar_for(db, actor, today)
    users = _users(db)
    year = today[:4]
    turned = sum(1 for r in db.scalars(select(ProposalRequest).where(ProposalRequest.from_radar.is_(True))).all()
                 if (iso_date(r.created_at.date()) or "")[:4] == year
                 and (actor.active_role in ("commercial_head", "executive") or r.bd_owner_id == actor.user_id))
    return {"items": [{**i, "bdOwnerName": users[i["bdOwner"]].name if i["bdOwner"] in users else None} for i in items],
            "turnedIntoRequests": turned, "clients": len({i["clientId"] for i in items})}


class DismissIn(_In):
    client_id: Any = None
    signal: Any = None
    until: Any = None
    reason: Any = None


@router.post("/radar/dismiss", status_code=201)
def dismiss(body: DismissIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
            db: Session = Depends(get_db)):
    """"Not this time": the item is hidden until its next occurrence; the reason (optional) is kept."""
    begin_write(db)
    today = cairo_today_iso(now)
    item = next((i for i in radar_for(db, actor, today)
                 if i["clientId"] == body.client_id and i["signal"] == body.signal), None)
    if item is None:
        raise not_found("This client is not on your radar.")
    reason = body.reason.strip()[:300] if isinstance(body.reason, str) and body.reason.strip() else None
    db.add(RadarDismissal(client_id=item["clientId"], signal=item["signal"], until=date.fromisoformat(item["until"]),
                          reason=reason, dismissed_by_id=actor.user_id, dismissed_at=now))
    db.commit()
    return {"message": "Hidden until the next time."}
