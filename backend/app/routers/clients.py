"""
Clients: list and detail (with the viewer's allowed actions), and CRM 1 writes: create, edit,
archive, transfer to another owner, and contact people. Every write is one transaction
(the service changes, the router commits once) and needs the expectedRowVersion it last read.
"""

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .. import config_domain as cfg
from ..clock import get_now, iso_z
from ..database import get_db
from ..domain import access, crm
from ..errors import not_found
from ..identity import Actor, get_current_actor
from ..models import Client, ClientBrand
from ..schemas import ClientList, ClientOut
from ..services import clients as service
from ..services.proposal_requests import _users

router = APIRouter(prefix="/api/clients", tags=["clients"])

ClientType = Literal["school", "corporate", "agency", "other"]
Brand = Literal["grasshoppers", "teamup"]


def clients_for_creator_filter(actor: Actor):
    """Mirrors the frontend's clientsForCreator: a BD only their own, the Commercial Head all, others none."""
    if actor.active_role == cfg.COMMERCIAL_HEAD:
        return None
    if actor.active_role == cfg.BUSINESS_DEVELOPMENT:
        return Client.owner_id == actor.user_id
    return False


@router.get("", response_model=ClientList)
def list_clients(
    q: str | None = Query(default=None, max_length=100, description="Search by name"),
    type: ClientType | None = None,
    owner: str | None = None,
    brand: Brand | None = None,
    creatable: bool = Query(default=False, description="Only clients you may create a proposal request for"),
    include_archived: bool = Query(default=False, alias="includeArchived"),
    actor: Actor = Depends(get_current_actor),
    db: Session = Depends(get_db),
):
    stmt = select(Client).options(selectinload(Client.brands), selectinload(Client.contacts)).order_by(Client.updated_at.desc(), Client.created_at.desc(), Client.name)  # newest activity first
    if not include_archived:
        stmt = stmt.where(Client.archived_at.is_(None))
    if q and q.strip():
        stmt = stmt.where(func.lower(Client.name).contains(q.strip().lower()))
    if type:
        stmt = stmt.where(Client.client_type == type)
    if owner:
        stmt = stmt.where(Client.owner_id == owner)
    if brand:
        stmt = stmt.where(Client.brands.any(ClientBrand.brand == brand))
    if creatable:
        rule = clients_for_creator_filter(actor)
        if rule is False:
            return ClientList(items=[], total=0)
        if rule is not None:
            stmt = stmt.where(rule)
    users = _users(db)
    rows = [c for c in db.scalars(stmt).all() if access.can_see_client(c.brand_ids, actor, users)]  # role and brand
    return ClientList(items=[ClientOut.of(c) for c in rows], total=len(rows))


def _detail(db: Session, client: Client, actor: Actor) -> dict:
    """The client as in the list, plus what THIS viewer may do with it (the UI shows only these)."""
    permissions = crm.client_permissions(service.client_dict(client), actor, _users(db))
    out = {**ClientOut.of(client).model_dump(by_alias=True, mode="json"), "permissions": permissions}
    if permissions["transfer"]["allowed"]:
        out["transferPreview"] = service.transfer_preview(db, client)
    return out


def _load(db: Session, client_id: str) -> Client:
    client = db.scalars(select(Client).where(Client.id == client_id)
                        .options(selectinload(Client.brands), selectinload(Client.contacts))).first()
    if client is None:
        raise not_found(f"Client {client_id!r} not found.")
    return client


def _load_visible(db: Session, client_id: str, actor: Actor) -> Client:
    """A client of a brand the viewer does not see is reported like one that does not exist."""
    client = _load(db, client_id)
    if not access.can_see_client(client.brand_ids, actor, _users(db)):
        raise not_found(f"Client {client_id!r} not found.")
    return client


@router.get("/{client_id}")
def get_client(client_id: str, actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    return _detail(db, _load_visible(db, client_id, actor), actor)


@router.get("/{client_id}/history")
def client_history(client_id: str, actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    client = _load_visible(db, client_id, actor)
    items = [{"id": h.id, "event": h.event, "changedBy": h.changed_by_id, "role": h.role,
              "changedAt": iso_z(h.changed_at), "reason": h.reason, "details": h.details}
             for h in sorted(client.history, key=lambda h: h.id, reverse=True)]
    return {"items": items, "total": len(items)}


# ---------- writes ----------

class _WriteIn(BaseModel):
    # Unknown fields are refused: ids, timestamps and (for BD) the owner are never taken from the body.
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=False)


class ContactFieldsIn(_WriteIn):
    name: Any = None
    title: Any = None
    phone: Any = None
    email: Any = None
    notes: Any = None


class ClientCreateIn(_WriteIn):
    name: Any = None
    type: Any = None
    brands: Any = None
    city: Any = None
    notes: Any = None
    owner: Any = None  # used only when the Commercial Head creates the client
    contact: ContactFieldsIn | None = None  # optional first (primary) contact


class ClientUpdateIn(_WriteIn):
    expected_row_version: int | None = None
    name: Any = None
    type: Any = None
    brands: Any = None
    city: Any = None
    notes: Any = None


class VersionIn(_WriteIn):
    expected_row_version: int | None = None


class TransferIn(_WriteIn):
    expected_row_version: int | None = None
    to_owner: Any = None
    reason: Any = None
    move_requests: bool = True


class ContactIn(ContactFieldsIn):
    expected_row_version: int | None = None
    is_primary: Any = None


def _respond(db: Session, result: dict, actor: Actor) -> dict:
    db.commit()
    db.expire_all()
    out = {"client": _detail(db, _load(db, result["client"].id), actor), "message": result["message"],
           "warnings": result["warnings"]}
    if "plan" in result:
        out["moved"] = result["plan"]
    return out


@router.post("", status_code=201)
def create_client(body: ClientCreateIn, actor: Actor = Depends(get_current_actor),
                  now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    data = body.model_dump(by_alias=True)
    data["contact"] = body.contact.model_dump(by_alias=True) if body.contact else None
    return _respond(db, service.create_client(db, actor, data, now), actor)


@router.patch("/{client_id}")
def update_client(client_id: str, body: ClientUpdateIn, actor: Actor = Depends(get_current_actor),
                  now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    client = service.load_client_for_write(db, client_id)
    data = body.model_dump(by_alias=True, exclude_unset=True, exclude={"expected_row_version"})
    return _respond(db, service.update_client(db, actor, client, data, body.expected_row_version, now), actor)


@router.post("/{client_id}/archive")
def archive_client(client_id: str, body: VersionIn, actor: Actor = Depends(get_current_actor),
                   now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    client = service.load_client_for_write(db, client_id)
    return _respond(db, service.archive_client(db, actor, client, body.expected_row_version, now), actor)


@router.post("/{client_id}/transfer")
def transfer_client(client_id: str, body: TransferIn, actor: Actor = Depends(get_current_actor),
                    now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    client = service.load_client_for_write(db, client_id)
    data = body.model_dump(by_alias=True, exclude={"expected_row_version"})
    return _respond(db, service.transfer_client(db, actor, client, data, body.expected_row_version, now), actor)


@router.post("/{client_id}/contacts", status_code=201)
def add_contact(client_id: str, body: ContactIn, actor: Actor = Depends(get_current_actor),
                now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    client = service.load_client_for_write(db, client_id)
    data = body.model_dump(by_alias=True, exclude={"expected_row_version"})
    return _respond(db, service.add_contact(db, actor, client, data, body.expected_row_version, now), actor)


@router.patch("/{client_id}/contacts/{contact_id}")
def update_contact(client_id: str, contact_id: int, body: ContactIn, actor: Actor = Depends(get_current_actor),
                   now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    client = service.load_client_for_write(db, client_id)
    data = body.model_dump(by_alias=True, exclude_unset=True, exclude={"expected_row_version"})
    return _respond(db, service.update_contact(db, actor, client, contact_id, data, body.expected_row_version, now), actor)


@router.post("/{client_id}/contacts/{contact_id}/archive")
def archive_contact(client_id: str, contact_id: int, body: VersionIn, actor: Actor = Depends(get_current_actor),
                    now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    client = service.load_client_for_write(db, client_id)
    return _respond(db, service.archive_contact(db, actor, client, contact_id, body.expected_row_version, now), actor)
