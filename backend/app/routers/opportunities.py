from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import config_domain as cfg
from ..clock import get_now
from ..database import begin_write, get_db
from ..domain import access, crm
from ..errors import not_found, validation
from ..identity import Actor, get_current_actor
from ..models import Opportunity
from ..schemas import OpportunityHistoryOut, OpportunityList, OpportunityOut
from ..services import clients as client_service
from ..services import opportunities as service
from .proposal_requests import NewClientIn
from ..services.proposal_requests import _users

router = APIRouter(prefix="/api/opportunities", tags=["opportunities"])

Brand = Literal["grasshoppers", "teamup"]


@router.get("", response_model=OpportunityList)
def list_opportunities(
    client: str | None = Query(default=None, description="Client id, e.g. CL-0001"),
    brand: Brand | None = None,
    owner: str | None = None,
    stage: str | None = Query(default=None, description="Comma-separated stages, e.g. won,lost"),
    open: bool = Query(default=False, description="Only stages that are not closed"),
    include_archived: bool = Query(default=False, alias="includeArchived"),
    actor: Actor = Depends(get_current_actor),
    db: Session = Depends(get_db),
):
    stmt = select(Opportunity).order_by(Opportunity.id)
    if not include_archived:
        stmt = stmt.where(Opportunity.archived_at.is_(None))
    if client:
        stmt = stmt.where(Opportunity.client_id == client)
    if brand:
        stmt = stmt.where(Opportunity.brand == brand)
    if owner:
        stmt = stmt.where(Opportunity.owner_id == owner)
    if stage:
        stages = [s.strip() for s in stage.split(",") if s.strip()]
        unknown = [s for s in stages if s not in cfg.STAGE_IDS]
        if unknown:
            raise validation("Please fix the highlighted fields.", {"stage": f"Unknown stage(s): {', '.join(unknown)}."})
        stmt = stmt.where(Opportunity.stage.in_(stages))
    if open:
        stmt = stmt.where(Opportunity.stage.not_in(cfg.CLOSED_STAGES))
    users = _users(db)
    rows = [o for o in db.scalars(stmt).all() if access.can_see_opportunity(o.brand, actor, users)]  # role and brand
    return OpportunityList(items=[OpportunityOut.of(o) for o in rows], total=len(rows))


@router.get("/{opportunity_id}")
def get_opportunity(opportunity_id: str, actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    opp = db.scalars(
        select(Opportunity).where(Opportunity.id == opportunity_id).options(selectinload(Opportunity.history))
    ).first()
    if opp is None or not access.can_see_opportunity(opp.brand, actor, _users(db)):
        raise not_found(f"Opportunity {opportunity_id!r} not found.")
    return _detail(db, opp, actor)  # with the history and what this viewer may do


# ---------- CRM 1 writes ----------
# One transaction per write (the service changes, this router commits once); expectedRowVersion
# is required on every change. The owner is always the client's relationship owner.


class _WriteIn(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=False)


class OpportunityFieldsIn(_WriteIn):
    brand: Any = None
    service: Any = None
    estimated_value: Any = None
    participants: Any = None
    event_date_precision: Any = None
    event_date: Any = None
    event_end_date: Any = None
    event_name: Any = None
    next_action: Any = None
    next_action_date: Any = None


class OpportunityCreateIn(OpportunityFieldsIn):
    client_id: Any = None
    new_client: NewClientIn | None = None  # "+ Add '<name>' as a new client"; one transaction


class OpportunityUpdateIn(OpportunityFieldsIn):
    expected_row_version: int | None = None


class StageMoveIn(_WriteIn):
    expected_row_version: int | None = None
    stage: Any = None
    lost_reason: Any = None
    note: Any = None


def _detail(db: Session, opp: Opportunity, actor: Actor) -> dict:
    base = OpportunityOut.of(opp).model_dump(by_alias=True, mode="json")
    history = [OpportunityHistoryOut.of(h).model_dump(by_alias=True, mode="json") for h in opp.history]
    d = service.opportunity_dict(opp)
    return {**base, "history": history, "permissions": {
        "edit": crm.can_edit_opportunity(d, actor, _users(db)), "moveTargets": crm.manual_stage_targets(d)}}


def _respond(db: Session, opp_id: str, actor: Actor, message: str, status_code: int = 200) -> dict:
    db.commit()
    db.expire_all()
    opp = db.scalars(select(Opportunity).where(Opportunity.id == opp_id).options(selectinload(Opportunity.history))).first()
    return {"opportunity": _detail(db, opp, actor), "message": message, "warnings": []}


@router.post("", status_code=201)
def create_opportunity(body: OpportunityCreateIn, actor: Actor = Depends(get_current_actor),
                       now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    data = body.model_dump(by_alias=True)
    client_id = data.pop("clientId")
    new_client = data.pop("newClient")
    if new_client:
        begin_write(db)
        added, _ = client_service.add_client_inline(db, actor, new_client, data.get("brand"), now)
        client_id = added.id
    if not client_id:
        raise validation("Please fix the highlighted fields.", {"clientId": "Choose a client."})
    client = client_service.load_client_for_write(db, str(client_id))
    opp = service.create_for_client(db, actor, client, data, _users(db), now)
    return _respond(db, opp.id, actor, f"Opportunity {opp.id} added for {client.name}.")


@router.patch("/{opportunity_id}")
def update_opportunity(opportunity_id: str, body: OpportunityUpdateIn, actor: Actor = Depends(get_current_actor),
                       now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    opp = service.load_opportunity_for_write(db, opportunity_id)
    data = body.model_dump(by_alias=True, exclude_unset=True, exclude={"expected_row_version"})
    result = service.update_fields(db, actor, opp, data, body.expected_row_version, _users(db), now)
    return _respond(db, opportunity_id, actor, result["message"])


@router.post("/{opportunity_id}/stage")
def move_stage(opportunity_id: str, body: StageMoveIn, actor: Actor = Depends(get_current_actor),
               now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    opp = service.load_opportunity_for_write(db, opportunity_id)
    data = body.model_dump(by_alias=True, exclude={"expected_row_version"})
    result = service.move_stage(db, actor, opp, data, body.expected_row_version, _users(db), now)
    return _respond(db, opportunity_id, actor, result["message"])
