"""
The only code paths that create or change accounts and brand routing. Rules come from
domain/accounts.py (the port of the frontend's accounts.js). Every change checks the row
version and appends its history entry in the SAME transaction; nothing here commits (the
router commits once, so a failure saves nothing). Accounts are never deleted.
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..clock import iso_z
from ..config_domain import BRANDS
from ..database import begin_write
from ..domain import accounts as rules
from ..domain.access import set_privileges
from ..domain.views import request_from_orm, user_from_orm
from ..errors import forbidden, not_found, stale, validation
from ..identity import Actor
from ..models import BrandRouting, Client, ProposalRequest, RequestEvent, RoutingHistory, User, UserHistory, UserRole
from .routing import current_routing

ACCOUNT_STALE = "This account was changed by someone else. Reload it and try again."
ROUTING_STALE = "Routing was changed by someone else. Reload it and try again."
BRAND_NAMES = {b["id"]: b["name"] for b in BRANDS}


def all_users(db: Session) -> dict:
    """Every account, active and deactivated (UserViews)."""
    return {u.id: user_from_orm(u) for u in db.scalars(select(User).options(selectinload(User.roles))).all()}


def _check_manager(db: Session, actor: Actor, users: dict | None = None) -> dict:
    users = users or all_users(db)
    permission = rules.can_manage_accounts(actor, users)
    if not permission["allowed"]:
        raise forbidden(permission["reason"])
    return users


def _require_version(expected: int | None, current: int, message: str):
    if expected is None:
        raise validation("Please fix the highlighted fields.", {
            "expectedRowVersion": "Required. Send the rowVersion you last loaded."})
    if expected != current:
        raise stale(message)


def _history(db: Session, user_id: str, actor: Actor, event: str, now: datetime, details: dict | None = None):
    db.add(UserHistory(user_id=user_id, event=event, changed_by_id=actor.user_id, role=actor.active_role,
                       changed_at=now, details=details))


def load_user_for_write(db: Session, user_id: str) -> User:
    begin_write(db)
    row = db.scalars(select(User).where(User.id == user_id).options(selectinload(User.roles)).with_for_update()).first()
    if row is None:
        raise not_found(f"Account {user_id!r} not found.")
    return row


def _apply(row: User, values: dict) -> None:
    row.name = values["name"]
    row.email = values["email"]
    row.job_title = values["jobTitle"]
    row.brand = values["brand"]
    set_privileges(row, values["privileges"])
    if list(row.role_ids) != values["roles"]:
        row.roles = [UserRole(role=r, position=i) for i, r in enumerate(values["roles"])]


def _fields(data: dict) -> dict:
    return {k: data[k] for k in ("name", "email", "jobTitle", "roles", "brand", "privileges") if k in data}


# ---------- accounts ----------

def create_account(db: Session, actor: Actor, data: dict, now: datetime) -> dict:
    begin_write(db)
    users = _check_manager(db, actor)
    checked = rules.validate_account_fields(_fields(data), users)
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    user_id = rules.new_account_id(v["name"], list(users))
    row = User(id=user_id, name=v["name"], initials=rules.initials_for(v["name"]),
               avatar_tone=rules.avatar_tone_for(len(users)), active=True, email=v["email"], job_title=v["jobTitle"],
               brand=v["brand"], created_at=now, updated_at=now)
    set_privileges(row, v["privileges"])
    row.roles = [UserRole(role=r, position=i) for i, r in enumerate(v["roles"])]
    db.add(row)
    db.flush()
    _history(db, row.id, actor, "created", now, details=v)
    return {"user": row, "message": f"Account created for {row.name}.", "warnings": []}


def update_account(db: Session, actor: Actor, row: User, data: dict, expected: int | None, now: datetime) -> dict:
    users = _check_manager(db, actor)
    _require_version(expected, row.row_version, ACCOUNT_STALE)
    target = users[row.id]
    before = rules.account_fields(target)
    given = _fields(data)
    if isinstance(given.get("privileges"), dict):  # switches not sent keep their value
        given["privileges"] = {**before["privileges"], **given["privileges"]}
    checked = rules.validate_account_fields({**before, **given}, users, row.id)
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    guard = rules.check_account_update(target, v, actor.user_id, users, current_routing(db))
    if guard["errors"]:
        raise validation("Please fix the highlighted fields.", guard["errors"])
    changes = rules.account_changes(before, v)
    if not changes:
        return {"user": row, "message": "Nothing changed.", "warnings": []}
    _apply(row, v)
    if "name" in changes:
        row.initials = rules.initials_for(v["name"])  # the id never changes
    row.updated_at = now
    db.flush()
    _history(db, row.id, actor, "updated", now, details=changes)
    return {"user": row, "message": "Changes saved.", "warnings": []}


def ownership(db: Session, user_id: str) -> dict:
    """What a person still owns (shown as a warning before deactivating; never blocks)."""
    clients = [{"owner": c.owner_id, "archivedAt": c.archived_at}
               for c in db.scalars(select(Client).where(Client.owner_id == user_id)).all()]
    requests = [request_from_orm(r) for r in db.scalars(
        select(ProposalRequest).where(ProposalRequest.bd_owner_id == user_id)
        .options(selectinload(ProposalRequest.history))).all()]
    return rules.deactivation_warnings(user_id, clients, requests)


def _assigned_requests(db: Session, user_id: str) -> list[ProposalRequest]:
    return db.scalars(select(ProposalRequest).where(ProposalRequest.assigned_am_id == user_id)
                      .options(selectinload(ProposalRequest.history), selectinload(ProposalRequest.files))).all()


def deactivation_plan(db: Session, user_id: str) -> dict:
    """An Account Manager's requests that must move to another AM of the brand before deactivating."""
    users = all_users(db)
    return rules.deactivation_move(users[user_id], users, [request_from_orm(r) for r in _assigned_requests(db, user_id)])


def deactivate_account(db: Session, actor: Actor, row: User, expected: int | None, now: datetime,
                       move_to: str | None = None) -> dict:
    """
    Deactivates (never deletes). An Account Manager's requests that are not closed must move to another
    active AM of the same brand (move_to) in the same transaction; each moved request records
    "Assigned AM changed from X to Y by <name> — deactivation".
    """
    users = _check_manager(db, actor)
    _require_version(expected, row.row_version, ACCOUNT_STALE)
    permission = rules.can_deactivate(users[row.id], actor.user_id, users, current_routing(db))
    if not permission["allowed"]:
        raise forbidden(permission["reason"])
    assigned = _assigned_requests(db, row.id)
    views = [request_from_orm(r) for r in assigned]
    checked = rules.validate_deactivation_move(users[row.id], {"moveTo": move_to}, users, views)
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    plan = rules.deactivation_move(users[row.id], users, views)
    if plan["count"]:
        note = rules.assigned_am_change_note(row.name, users[move_to].name, users[actor.user_id].name)
        for r in assigned:
            if r.id in plan["requestIds"]:
                db.add(RequestEvent(request_id=r.id, event="assigned_am_changed", changed_by_id=actor.user_id,
                                    role=actor.active_role, changed_at=now, from_user_id=row.id, to_user_id=move_to,
                                    note=note))
                r.assigned_am_id = move_to
                r.updated_at = now
    owned = ownership(db, row.id)
    row.active = False
    row.updated_at = now
    db.flush()
    details = {"owned": owned}
    if plan["count"]:
        details["moved"] = {"to": move_to, "requests": plan["requestIds"]}
    _history(db, row.id, actor, "deactivated", now, details=details)
    moved = (f" {plan['count']} open {'request' if plan['count'] == 1 else 'requests'} moved to {users[move_to].name}."
             if plan["count"] else "")
    return {"user": row, "message": f"{row.name} is deactivated. Their history stays.{moved}", "warnings": []}


def reactivate_account(db: Session, actor: Actor, row: User, expected: int | None, now: datetime) -> dict:
    users = _check_manager(db, actor)
    _require_version(expected, row.row_version, ACCOUNT_STALE)
    permission = rules.can_reactivate(users[row.id])
    if not permission["allowed"]:
        raise forbidden(permission["reason"])
    row.active = True
    row.updated_at = now
    db.flush()
    _history(db, row.id, actor, "reactivated", now)
    return {"user": row, "message": f"{row.name} is active again.", "warnings": []}


def account_detail_permissions(db: Session, actor: Actor, target_id: str) -> dict:
    users = all_users(db)
    manage = rules.can_manage_accounts(actor, users)
    target = users[target_id]
    routing = current_routing(db)
    deny = lambda p: p if manage["allowed"] else manage  # noqa: E731
    return {
        "edit": manage,
        "deactivate": deny(rules.can_deactivate(target, actor.user_id, users, routing)),
        "reactivate": deny(rules.can_reactivate(target)),
    }


# ---------- routing ----------

def set_routing(db: Session, actor: Actor, brand: str, am_id, expected: int | None, now: datetime) -> dict:
    begin_write(db)
    users = _check_manager(db, actor)
    if brand not in BRAND_NAMES:
        raise not_found(f"Brand {brand!r} not found.")
    row = db.scalars(select(BrandRouting).where(BrandRouting.brand == brand).with_for_update()).first()
    if row is not None:
        _require_version(expected, row.row_version, ROUTING_STALE)
    checked = rules.validate_routing(brand, am_id, users, current_routing(db))
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    before = row.am_user_id if row is not None else None
    if row is None:
        row = BrandRouting(brand=brand, am_user_id=am_id, updated_at=now)
        db.add(row)
    else:
        row.am_user_id = am_id
        row.updated_at = now
    db.flush()
    db.add(RoutingHistory(brand=brand, from_user_id=before, to_user_id=am_id, changed_by_id=actor.user_id,
                          role=actor.active_role, changed_at=now))
    return {"routing": row, "message": f"New {BRAND_NAMES[brand]} requests now go to {users[am_id].name}. "
                                       "Existing requests keep their Account Manager.", "warnings": []}


def routing_out(db: Session) -> dict:
    users = all_users(db)
    rows = {r.brand: r for r in db.scalars(select(BrandRouting)).all()}
    history = db.scalars(select(RoutingHistory).order_by(RoutingHistory.id.desc())).all()
    return {
        "items": [{
            "brand": b["id"],
            "amUserId": rows[b["id"]].am_user_id if b["id"] in rows else None,
            "rowVersion": rows[b["id"]].row_version if b["id"] in rows else None,
            "choices": [u.id for u in rules.routing_choices(b["id"], users)],
        } for b in BRANDS],
        "history": [{"id": h.id, "brand": h.brand, "fromUser": h.from_user_id, "toUser": h.to_user_id,
                     "changedBy": h.changed_by_id, "role": h.role, "changedAt": iso_z(h.changed_at)} for h in history],
    }

