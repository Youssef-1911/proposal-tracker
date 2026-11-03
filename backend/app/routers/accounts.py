"""
Accounts (Admin -> Team & Users) and brand routing (Settings). Only people with "Manage
accounts" may read a person's page, change accounts or change routing; the list of people
(GET /api/users) stays open to everyone for names. There are no DELETE routes: accounts are
deactivated, never deleted.
"""

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import get_now, iso_z
from ..database import get_db
from ..domain import accounts as rules
from ..errors import forbidden, not_found
from ..identity import Actor, get_current_actor
from ..models import User, UserHistory
from ..schemas import UserOut
from ..services import accounts as service
from ..services.lists import change_list, lists_out
from ..services.proposal_requests import _users as request_users

router = APIRouter(prefix="/api", tags=["accounts"])


class _WriteIn(BaseModel):
    # Unknown fields are refused: the id, initials and timestamps are never taken from the body.
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=False)


class AccountIn(_WriteIn):
    name: Any = None
    email: Any = None
    job_title: Any = None
    roles: Any = None
    brand: Any = None
    privileges: Any = None


class AccountUpdateIn(AccountIn):
    expected_row_version: int | None = None


class VersionIn(_WriteIn):
    expected_row_version: int | None = None


class DeactivateIn(VersionIn):
    move_requests_to: Any = None  # an Account Manager's open requests go to this AM of the same brand


class RoutingIn(_WriteIn):
    am_user_id: Any = None
    expected_row_version: int | None = None


def _require_manager(db: Session, actor: Actor) -> None:
    permission = rules.can_manage_accounts(actor, service.all_users(db))
    if not permission["allowed"]:
        raise forbidden(permission["reason"])


def _detail(db: Session, user_id: str, actor: Actor) -> dict:
    row = db.get(User, user_id)
    if row is None:
        raise not_found(f"Account {user_id!r} not found.")
    history = db.scalars(select(UserHistory).where(UserHistory.user_id == user_id).order_by(UserHistory.id.desc())).all()
    return {
        **UserOut.of(row).model_dump(by_alias=True, mode="json"),
        "owns": service.ownership(db, user_id),
        # An Account Manager's open requests and who may take them over (shown in the deactivate panel).
        "deactivation": service.deactivation_plan(db, user_id),
        "permissions": service.account_detail_permissions(db, actor, user_id),
        "history": [{"id": h.id, "event": h.event, "changedBy": h.changed_by_id, "role": h.role,
                     "changedAt": iso_z(h.changed_at), "details": h.details} for h in history],
    }


def _respond(db: Session, result: dict, actor: Actor) -> dict:
    db.commit()
    db.expire_all()
    return {"user": _detail(db, result["user"].id, actor), "message": result["message"], "warnings": result["warnings"]}


@router.get("/users/{user_id}")
def get_account(user_id: str, actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    """A person's page: details, what they own, their history, and what THIS viewer may do."""
    _require_manager(db, actor)
    return _detail(db, user_id, actor)


@router.post("/users", status_code=201)
def create_account(body: AccountIn, actor: Actor = Depends(get_current_actor),
                   now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    return _respond(db, service.create_account(db, actor, body.model_dump(by_alias=True), now), actor)


@router.patch("/users/{user_id}")
def update_account(user_id: str, body: AccountUpdateIn, actor: Actor = Depends(get_current_actor),
                   now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    row = service.load_user_for_write(db, user_id)
    data = body.model_dump(by_alias=True, exclude_unset=True, exclude={"expected_row_version"})
    return _respond(db, service.update_account(db, actor, row, data, body.expected_row_version, now), actor)


@router.post("/users/{user_id}/deactivate")
def deactivate_account(user_id: str, body: DeactivateIn, actor: Actor = Depends(get_current_actor),
                       now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    row = service.load_user_for_write(db, user_id)
    result = service.deactivate_account(db, actor, row, body.expected_row_version, now, body.move_requests_to)
    return _respond(db, result, actor)


@router.post("/users/{user_id}/reactivate")
def reactivate_account(user_id: str, body: VersionIn, actor: Actor = Depends(get_current_actor),
                       now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    row = service.load_user_for_write(db, user_id)
    return _respond(db, service.reactivate_account(db, actor, row, body.expected_row_version, now), actor)


# ---------- routing ----------

@router.get("/routing")
def get_routing(actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    """Each brand's Account Manager, who it may be changed to, and every change so far."""
    _require_manager(db, actor)
    return service.routing_out(db)


@router.patch("/routing/{brand}")
def set_routing(brand: str, body: RoutingIn, actor: Actor = Depends(get_current_actor),
                now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    result = service.set_routing(db, actor, brand, body.am_user_id, body.expected_row_version, now)
    db.commit()
    return {**service.routing_out(db), "message": result["message"], "warnings": []}


# ---------- dropdown lists (Settings) ----------

class ListChangeIn(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")
    action: Literal["add", "rename", "hide", "show"]
    code: Any = None
    label: Any = None


@router.post("/settings/lists/{list_id}")
def change_list_option(list_id: str, body: ListChangeIn, actor: Actor = Depends(get_current_actor),
                       now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """Add, rename, hide or show one option of a dropdown list ("Manage accounts"). Nothing is deleted."""
    result = change_list(db, actor, request_users(db), list_id, body.model_dump(), now)
    db.commit()
    return {"lists": lists_out(db), "message": result["message"], "warnings": []}
