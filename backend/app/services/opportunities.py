"""
The only code paths that create opportunities or change their stage.
Every stage change appends an opportunity_history entry in the SAME transaction
(the caller commits). Nothing here commits.

Rules:
- An opportunity can only become Lost with a reason (also a database CHECK).
- Changing to the same stage is a no-op and records nothing.
- Leaving a closed stage (Won/Lost) is recorded as a reopening (reason_code).
- A stale expected_row_version is rejected with 409.
"""

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import cairo_today_iso
from ..config_domain import (
    BRAND_IDS, BUSINESS_DEVELOPMENT, CLOSED_STAGES, LOST, OPPORTUNITY_STAGES, SERVICES_BY_BRAND, STAGE_IDS,
)
from ..database import begin_write, utcnow
from ..domain import crm
from ..errors import ApiError, conflict, not_found, validation
from ..identity import Actor
from ..domain.access import can_own_clients
from ..domain.views import user_from_orm
from ..models import Client, Opportunity, OpportunityHistory, User
from .ids import next_opportunity_id


def _clean(text: str | None) -> str | None:
    text = (text or "").strip()
    return text or None


def create_opportunity(
    db: Session,
    *,
    actor: Actor,
    client_id: str,
    brand: str,
    service: str,
    owner_id: str,
    stage: str = "new_lead",
    estimated_value: int | None = None,
    participants: int | None = None,
    event_date: date | None = None,
    event_date_precision: str = "day",
    next_action: str | None = None,
    next_action_date: date | None = None,
    lost_reason: str | None = None,
    reason_code: str = "created",
    note: str | None = None,
    now: datetime | None = None,
    allow_inactive_owner: bool = False,
) -> Opportunity:
    errors = {}
    client = db.get(Client, client_id)
    if client is None or client.archived_at is not None:
        raise not_found(f"Client {client_id!r} not found.")
    if brand not in BRAND_IDS:
        errors["brand"] = "Choose Grasshoppers or Team Up."
    elif service not in SERVICES_BY_BRAND[brand]:
        errors["service"] = "Choose a service of the selected brand."
    owner = db.get(User, owner_id)
    # The BD role or "Brings in clients" (Noha, Doaa). Imported history may name a former, inactive owner.
    if owner is None or not (can_own_clients(user_from_orm(owner)) or (allow_inactive_owner and not owner.active)):
        errors["owner"] = "The owner must be someone who brings in clients."
    if stage not in STAGE_IDS:
        errors["stage"] = "Unknown stage."
    if stage == LOST and not _clean(lost_reason):
        errors["lostReason"] = "An opportunity can only be Lost with a reason."
    if estimated_value is not None and (not isinstance(estimated_value, int) or estimated_value < 0):
        errors["estimatedValue"] = "Use a whole EGP amount of 0 or more."
    if participants is not None and (not isinstance(participants, int) or participants <= 0):
        errors["participants"] = "Use a whole number greater than 0."
    if event_date_precision not in ("day", "month"):
        errors["eventDatePrecision"] = "Use 'day' or 'month'."
    if errors:
        raise validation("Please fix the highlighted fields.", errors)

    if event_date is not None and event_date_precision == "month":
        event_date = event_date.replace(day=1)  # month-only: never invent a day
    when = now or utcnow()
    opp = Opportunity(
        id=next_opportunity_id(db),
        client_id=client.id,
        brand=brand,
        service=service,
        owner_id=owner_id,
        stage=stage,
        estimated_value=estimated_value,
        participants=participants,
        event_date=event_date,
        event_date_precision=event_date_precision,
        next_action=_clean(next_action),
        next_action_date=next_action_date,
        lost_reason=_clean(lost_reason) if stage == LOST else None,
        created_at=when,
        updated_at=when,
    )
    db.add(opp)
    db.add(OpportunityHistory(
        opportunity=opp,
        from_stage=None,
        to_stage=stage,
        changed_by_id=actor.user_id,
        role=actor.active_role,
        changed_at=when,
        # A Lost opportunity always records its reason in history.
        note=(_clean(note) or opp.lost_reason) if stage == LOST else _clean(note),
        reason_code=reason_code,
        lost_reason=opp.lost_reason if stage == LOST else None,
    ))
    db.flush()
    return opp


def set_opportunity_stage(
    db: Session,
    opp: Opportunity,
    to_stage: str,
    *,
    actor: Actor,
    note: str | None = None,
    lost_reason: str | None = None,
    reason_code: str | None = None,
    source_request_id: str | None = None,
    expected_row_version: int | None = None,
    now: datetime | None = None,
) -> OpportunityHistory | None:
    """
    Changes the stage and appends history together. Returns the entry, or None for a no-op.
    Lost needs a reason: lost_reason (e.g. a LOST_REASONS code from Mark lost), or else the note.
    The note goes into history; the reason is stored on the opportunity while it stays Lost.
    """
    if expected_row_version is not None and expected_row_version != opp.row_version:
        raise conflict(f"Opportunity {opp.id} was changed by someone else. Reload and try again.", code="stale")
    if to_stage not in STAGE_IDS:
        raise validation("Please fix the highlighted fields.", {"stage": "Unknown stage."})
    if to_stage == opp.stage:
        return None
    reason = _clean(note)
    lost = (_clean(lost_reason) or reason) if to_stage == LOST else None
    if to_stage == LOST and not lost:
        raise ApiError(422, "validation_error", "An opportunity can only be Lost with a reason.",
                       {"note": "A reason is required to mark the opportunity Lost."})

    from_stage = opp.stage
    if from_stage in CLOSED_STAGES and reason_code is None:
        reason_code = "reopened"
    when = now or utcnow()
    opp.stage = to_stage
    opp.lost_reason = lost  # cleared when leaving Lost; the request history keeps the reason
    entry = OpportunityHistory(
        opportunity=opp,
        from_stage=from_stage,
        to_stage=to_stage,
        changed_by_id=actor.user_id,
        role=actor.active_role,
        changed_at=when,
        note=reason,
        reason_code=reason_code,
        source_request_id=source_request_id,
        lost_reason=lost,  # the opportunity's own history keeps why it was lost, even after a reopen
    )
    db.add(entry)
    db.flush()
    return entry


# ---------------------------------------------------------------------------
# CRM 1: create from a client, edit fields, move stage by hand
# ---------------------------------------------------------------------------

OPPORTUNITY_STALE = "This opportunity was changed by someone else. Reload it and try again."
OPP_FIELDS = ("brand", "service", "estimatedValue", "participants", "eventDatePrecision", "eventDate", "eventEndDate", "eventName",
              "nextAction", "nextActionDate")


def opportunity_dict(o: Opportunity) -> dict:
    return {"id": o.id, "clientId": o.client_id, "owner": o.owner_id, "stage": o.stage,
            "archivedAt": o.archived_at.isoformat() if o.archived_at else None}


def _fields_of(o: Opportunity) -> dict:
    event = None
    if o.event_date is not None:
        event = o.event_date.strftime("%Y-%m") if o.event_date_precision == "month" else o.event_date.isoformat()
    return {"brand": o.brand, "service": o.service, "estimatedValue": o.estimated_value, "participants": o.participants,
            "eventDatePrecision": o.event_date_precision, "eventDate": event,
            "eventEndDate": o.event_end_date.isoformat() if o.event_end_date else None, "eventName": o.event_name,
            "nextAction": o.next_action,
            "nextActionDate": o.next_action_date.isoformat() if o.next_action_date else None}


def _event_date(value: str | None, precision: str) -> date | None:
    if not value:
        return None
    return date.fromisoformat(f"{value}-01" if precision == "month" else value)


def _apply_fields(o: Opportunity, v: dict) -> None:
    o.brand, o.service = v["brand"], v["service"]
    o.estimated_value, o.participants = v["estimatedValue"], v["participants"]
    o.event_date_precision = v["eventDatePrecision"]
    o.event_date = _event_date(v["eventDate"], v["eventDatePrecision"])
    o.event_end_date = date.fromisoformat(v["eventEndDate"]) if v["eventEndDate"] else None
    o.event_name = v["eventName"]
    o.next_action = v["nextAction"]
    o.next_action_date = date.fromisoformat(v["nextActionDate"]) if v["nextActionDate"] else None


def _today(now: datetime) -> str:
    return cairo_today_iso(now)


def load_opportunity_for_write(db: Session, opportunity_id: str) -> Opportunity:
    begin_write(db)
    opp = db.scalars(select(Opportunity).where(Opportunity.id == opportunity_id).with_for_update()).first()
    if opp is None:
        raise not_found(f"Opportunity {opportunity_id!r} not found.")
    return opp


def _require_version(expected: int | None, current: int):
    if expected is None:
        raise validation("Please fix the highlighted fields.", {
            "expectedRowVersion": "Required. Send the rowVersion you last loaded."})
    if expected != current:
        raise conflict(OPPORTUNITY_STALE, code="stale")


def create_for_client(db: Session, actor: Actor, client: Client, data: dict, users: dict, now: datetime) -> Opportunity:
    """New opportunity for a client: its relationship owner or the Head; the owner is always the client's owner."""
    from .clients import _history, client_dict  # here, not at the top: clients -> proposal_requests -> this module
    permission = crm.can_edit_client(client_dict(client), actor, users)
    if not permission["allowed"]:
        raise ApiError(403, "forbidden", permission["reason"])
    checked = crm.validate_opportunity_fields(data, today=_today(now))
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    opp = create_opportunity(
        db, actor=actor, client_id=client.id, brand=v["brand"], service=v["service"], owner_id=client.owner_id,
        stage="new_lead", estimated_value=v["estimatedValue"], participants=v["participants"],
        event_date=_event_date(v["eventDate"], v["eventDatePrecision"]), event_date_precision=v["eventDatePrecision"],
        next_action=v["nextAction"], next_action_date=date.fromisoformat(v["nextActionDate"]) if v["nextActionDate"] else None,
        reason_code="created", now=now,
    )
    opp.event_end_date = date.fromisoformat(v["eventEndDate"]) if v["eventEndDate"] else None
    opp.event_name = v["eventName"]
    _history(db, client, actor, "opportunity_added", now, details={"opportunityId": opp.id, "service": v["service"]})
    return opp


def update_fields(db: Session, actor: Actor, opp: Opportunity, data: dict, expected: int | None, users: dict,
                  now: datetime) -> dict:
    _require_version(expected, opp.row_version)
    permission = crm.can_edit_opportunity(opportunity_dict(opp), actor, users)
    if not permission["allowed"]:
        raise ApiError(403, "forbidden", permission["reason"])
    current = _fields_of(opp)
    checked = crm.validate_opportunity_fields({**current, **{k: v for k, v in data.items() if k in OPP_FIELDS}},
                                              today=_today(now), current=current)
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    changes = {k: {"from": current[k], "to": v[k]} for k in OPP_FIELDS if current[k] != v[k]}
    if changes:
        _apply_fields(opp, v)
        opp.updated_at = now
        db.add(OpportunityHistory(opportunity=opp, from_stage=opp.stage, to_stage=opp.stage,
                                  changed_by_id=actor.user_id, role=actor.active_role, changed_at=now,
                                  reason_code="details_updated", details=changes))
        db.flush()
    return {"message": "Changes saved." if changes else "Nothing changed."}


def move_stage(db: Session, actor: Actor, opp: Opportunity, data: dict, expected: int | None, users: dict,
               now: datetime) -> dict:
    """Manual stage move (manual_change). Won is never manual; Lost needs a listed reason; reopening needs a note."""
    _require_version(expected, opp.row_version)
    permission = crm.can_edit_opportunity(opportunity_dict(opp), actor, users)
    if not permission["allowed"]:
        raise ApiError(403, "forbidden", permission["reason"])
    checked = crm.validate_stage_move(opportunity_dict(opp), data)
    if not checked["ok"]:
        if checked["code"] == "invalid_transition":
            raise ApiError(409, "invalid_transition", checked["error"])
        raise validation(checked["error"], checked["errors"])
    set_opportunity_stage(db, opp, checked["stage"], actor=actor, note=checked["note"],
                          lost_reason=checked["lostReason"], reason_code=checked["reasonCode"], now=now)
    opp.updated_at = now
    db.flush()
    label = next(s["label"] for s in OPPORTUNITY_STAGES if s["id"] == checked["stage"])
    return {"message": f"{opp.id} moved to {label}."}
