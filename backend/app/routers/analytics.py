"""
The data behind Analytics, scoped on the SERVER (domain/access.analytics_scope):
- Business Development (acting so): only the requests they own; an Account Manager (acting so):
  only the requests assigned to them. Whatever they ask for.
- Management (Commercial Head, Executives with "See analytics"): the company, or one person's
  scorecard (?person=<id>&as=bd|am), plus the list of people they may open (inactive ones too).
- Anyone else with "See analytics": the company (an AM's own brand rule still applies).
Someone else's draft is never included. The numbers themselves are computed by the shared
frontend module (domain/scorecard.js), the same one Home uses.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..clock import cairo_today_iso, get_now
from ..database import get_db
from ..domain import access
from ..domain.views import request_from_orm
from ..errors import forbidden, validation
from ..identity import Actor, get_current_actor
from ..models import Opportunity, ProposalRequest
from ..schemas import OpportunityOut
from .proposal_requests import _client_names, _history_out, _summary, _users

router = APIRouter(prefix="/api", tags=["analytics"])


@router.get("/analytics")
def analytics(person: str | None = None, as_: str | None = Query(default=None, alias="as"),
              actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
              db: Session = Depends(get_db)):
    users = _users(db)
    me = users[actor.user_id]
    scope = access.analytics_scope(actor, me, users, person=person, as_=as_)
    if scope is None:
        raise forbidden(access.can_see_analytics(me, actor)["reason"])
    if scope.get("error"):
        raise validation("Please fix the highlighted fields.", {"person": scope["error"]})

    rows = db.scalars(select(ProposalRequest).options(selectinload(ProposalRequest.history),
                                                      selectinload(ProposalRequest.files))).all()
    ctx = {"today": cairo_today_iso(now), "now": now, "actor": actor, "users": users, "client_names": _client_names(db)}
    requests = []
    for row in rows:
        view = request_from_orm(row)
        if access.in_analytics_scope(view, scope, actor):
            requests.append({**_summary(view, ctx), "history": _history_out(row), "participants": row.participants,
                             "lostReason": next((h.lost_reason for h in reversed(row.history) if h.lost_reason), None)})

    brands = scope["brands"]
    opps = db.scalars(select(Opportunity).where(Opportunity.archived_at.is_(None)).order_by(Opportunity.id)).all()
    if scope["kind"] == "bd":
        opps = [o for o in opps if o.owner_id == scope["userId"]]
    elif scope["kind"] == "am":
        opps = []
    opportunities = [OpportunityOut.of(o).model_dump(by_alias=True, mode="json")
                     for o in opps if brands is None or o.brand in brands]
    people = []
    if access.is_management_view(actor, me):
        people = [{"id": u.id, "name": u.name, "as": kind, "active": u.active is not False}
                  for u in sorted(users.values(), key=lambda u: u.name) for kind in access.scorecard_kinds(u)]
    return {"brands": brands, "scope": {"kind": scope["kind"], "userId": scope["userId"]}, "people": people,
            "requests": requests, "opportunities": opportunities}
