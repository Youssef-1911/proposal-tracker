"""
The only code paths that create or change clients and their contacts, and transfer a client
to another relationship owner. Rules come from domain/crm.py (the port of the frontend's
crm.js). Every change appends a client_history entry in the SAME transaction; nothing here
commits (the router commits once, so a failure saves nothing).
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..database import begin_write
from ..domain import crm
from ..domain.views import request_from_orm
from ..errors import ApiError, forbidden, not_found, stale, validation
from ..identity import Actor
from ..models import Client, ClientBrand, ClientContact, ClientHistory, Opportunity, ProposalRequest, RequestEvent
from .ids import next_client_id
from .proposal_requests import _users

CLIENT_STALE = "This client was changed by someone else. Reload it and try again."
CONTACT_STALE = "This contact was changed by someone else. Reload it and try again."


# ---------- views for the shared rules ----------

def client_dict(c: Client) -> dict:
    return {"id": c.id, "name": c.name, "owner": c.owner_id,
            "archivedAt": c.archived_at.isoformat() if c.archived_at else None,
            "contacts": [{"phone": p.phone, "email": p.email} for p in c.active_contacts]}


def _all_client_dicts(db: Session) -> list[dict]:
    rows = db.scalars(select(Client).options(selectinload(Client.contacts))).all()
    return [client_dict(c) for c in rows]


def _check(permission: dict):
    if not permission["allowed"]:
        raise forbidden(permission["reason"])


def _require_version(expected: int | None, current: int, message: str):
    if expected is None:
        raise validation("Please fix the highlighted fields.", {
            "expectedRowVersion": "Required. Send the rowVersion you last loaded."})
    if expected != current:
        raise stale(message)


def load_client_for_write(db: Session, client_id: str) -> Client:
    begin_write(db)
    row = db.scalars(select(Client).where(Client.id == client_id)
                     .options(selectinload(Client.contacts), selectinload(Client.brands)).with_for_update()).first()
    if row is None:
        raise not_found(f"Client {client_id!r} not found.")
    return row


def _history(db: Session, client: Client, actor: Actor, event: str, now: datetime, *, reason=None, details=None):
    db.add(ClientHistory(client_id=client.id, event=event, changed_by_id=actor.user_id, role=actor.active_role,
                         changed_at=now, reason=reason, details=details))


def _duplicates(db: Session, name: str, contacts: list[dict], exclude_id: str | None) -> list[dict]:
    dupes = crm.find_possible_duplicate_clients({"name": name, "contacts": contacts}, _all_client_dicts(db), exclude_id)
    if not dupes:
        return []
    names = ", ".join(d["name"] for d in dupes)
    return [{"code": "possible_duplicate_client",
             "message": f"Possible duplicate: {names}. Check before adding opportunities; you can keep both.",
             "clients": dupes}]


# ---------- clients ----------

def create_client(db: Session, actor: Actor, data: dict, now: datetime) -> dict:
    begin_write(db)
    users = _users(db)
    _check(crm.can_create_client(actor, users))
    checked = crm.validate_client_fields(data)
    owner = crm.new_client_owner(actor, data.get("owner"), users)
    contact = None
    errors = {**checked["errors"], **owner.get("errors", {})}
    if data.get("contact") and any(str(v or "").strip() for v in data["contact"].values()):
        contact = crm.validate_contact_fields({**data["contact"], "isPrimary": True})
        errors.update({f"contact.{k}": v for k, v in contact["errors"].items()})
    if errors:
        raise validation("Please fix the highlighted fields.", errors)

    v = checked["values"]
    client = Client(id=next_client_id(db), name=v["name"], client_type=v["type"], city=v["city"], notes=v["notes"],
                    owner_id=owner["owner"], created_at=now, updated_at=now)
    client.brands = [ClientBrand(brand=b, position=i) for i, b in enumerate(v["brands"])]
    contacts = []
    if contact:
        c = contact["values"]
        contacts = [ClientContact(name=c["name"], title=c["title"], phone=c["phone"], email=c["email"], notes=c["notes"],
                                  is_primary=True, created_at=now, updated_at=now)]
    client.contacts = contacts
    warnings = _duplicates(db, v["name"], [{"phone": x.phone, "email": x.email} for x in contacts], None)
    db.add(client)
    db.flush()
    _history(db, client, actor, "created", now, details={"name": v["name"], "owner": client.owner_id})
    return {"client": client, "message": f"{client.name} added.", "warnings": warnings}



def add_client_inline(db: Session, actor: Actor, new_client: dict, brand, now: datetime) -> tuple[Client, list]:
    """
    "+ Add '<name>' as a new client" from the request or opportunity form. Same rules as Add client
    (only people who bring in clients, or the Head choosing the owner); the brand is the form's.
    Runs inside the caller's transaction: if the request or opportunity fails, no client is created.
    Field errors come back as newClient.<field>.
    """
    contact = {"name": new_client.get("contactName"), "phone": new_client.get("contactPhone")}
    data = {"name": new_client.get("name"), "type": new_client.get("type"), "brands": [brand] if brand else [],
            "city": None, "notes": None, "owner": new_client.get("owner"), "contact": contact}
    try:
        result = create_client(db, actor, data, now)
    except ApiError as e:
        if e.fields:
            raise validation(e.message, {f"newClient.{k}": v for k, v in e.fields.items()}) from None
        raise
    return result["client"], result["warnings"]


FIELD_COLUMNS = {"name": "name", "type": "client_type", "city": "city", "notes": "notes"}


def update_client(db: Session, actor: Actor, client: Client, data: dict, expected: int | None, now: datetime) -> dict:
    _require_version(expected, client.row_version, CLIENT_STALE)
    _check(crm.can_edit_client(client_dict(client), actor, _users(db)))
    current = {"name": client.name, "type": client.client_type, "brands": client.brand_ids, "city": client.city,
               "notes": client.notes}
    checked = crm.validate_client_fields({**current, **data})
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    changes = {k: {"from": current[k], "to": v[k]} for k in current if current[k] != v[k]}
    if changes:
        for field, column in FIELD_COLUMNS.items():
            setattr(client, column, v[field])
        if "brands" in changes:
            client.brands = [ClientBrand(brand=b, position=i) for i, b in enumerate(v["brands"])]
        client.updated_at = now
        db.flush()
        _history(db, client, actor, "updated", now, details=changes)
    warnings = _duplicates(db, v["name"], [], client.id) if "name" in changes else []
    return {"client": client, "message": "Changes saved." if changes else "Nothing changed.", "warnings": warnings}


def archive_client(db: Session, actor: Actor, client: Client, expected: int | None, now: datetime) -> dict:
    _require_version(expected, client.row_version, CLIENT_STALE)
    _check(crm.can_edit_client(client_dict(client), actor, _users(db)))
    client.archived_at = now
    client.updated_at = now
    db.flush()
    _history(db, client, actor, "archived", now)
    return {"client": client, "message": f"{client.name} archived. It no longer appears in lists.", "warnings": []}


def _transfer_targets(db: Session, client: Client, move_requests: bool):
    opps = db.scalars(select(Opportunity).where(Opportunity.client_id == client.id, Opportunity.archived_at.is_(None))).all()
    reqs = db.scalars(select(ProposalRequest).where(ProposalRequest.client_id == client.id)
                      .options(selectinload(ProposalRequest.history))).all()
    plan = crm.transfer_plan(client_dict(client),
                             opportunities=[{"id": o.id, "clientId": o.client_id, "stage": o.stage} for o in opps],
                             requests=[request_from_orm(r) for r in reqs], move_requests=move_requests)
    return opps, reqs, plan


def transfer_preview(db: Session, client: Client) -> dict:
    """What a transfer would move (read only): shown in the transfer panel ("Also move N open requests")."""
    plan = _transfer_targets(db, client, True)[2]
    return {"openOpportunityCount": len(plan["opportunityIds"]), "openRequestCount": plan["openRequestCount"]}


def transfer_client(db: Session, actor: Actor, client: Client, data: dict, expected: int | None, now: datetime) -> dict:
    """Client + its open opportunities (+ its open requests when moveRequests) to a new BD owner, in one go."""
    _require_version(expected, client.row_version, CLIENT_STALE)
    users = _users(db)
    _check(crm.can_transfer_client(client_dict(client), actor))
    checked = crm.validate_transfer(client_dict(client), data, users)
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    move_requests = data.get("moveRequests", True) is not False
    to_owner, from_owner, reason = data["toOwner"], client.owner_id, str(data["reason"]).strip()

    opps, reqs, plan = _transfer_targets(db, client, move_requests)

    client.owner_id = to_owner
    client.updated_at = now
    for o in opps:
        if o.id in plan["opportunityIds"]:
            o.owner_id = to_owner
            o.updated_at = now
    note = crm.request_transfer_note(users[from_owner].name, users[to_owner].name, users[actor.user_id].name, reason)
    for r in reqs:
        if r.id in plan["requestIds"]:
            db.add(RequestEvent(request_id=r.id, event="bd_owner_transferred", changed_by_id=actor.user_id,
                                role=actor.active_role, changed_at=now, from_user_id=r.bd_owner_id, to_user_id=to_owner,
                                note=note))
            r.bd_owner_id = to_owner
            r.last_updated = now
            r.updated_at = now
    db.flush()
    _history(db, client, actor, "owner_transferred", now, reason=reason, details={
        "from": from_owner, "to": to_owner, "opportunities": plan["opportunityIds"], "requests": plan["requestIds"],
        "moveRequests": move_requests})
    moved = len(plan["requestIds"])
    message = (f"{client.name} now belongs to {users[to_owner].name}, with {len(plan['opportunityIds'])} open "
               f"opportunit{'y' if len(plan['opportunityIds']) == 1 else 'ies'}"
               + (f" and {moved} open request{'' if moved == 1 else 's'}." if move_requests else "."))
    return {"client": client, "message": message, "warnings": [], "plan": plan}


# ---------- contacts ----------

def _contact_or_404(client: Client, contact_id: int) -> ClientContact:
    contact = next((c for c in client.contacts if c.id == contact_id and c.archived_at is None), None)
    if contact is None:
        raise not_found(f"Contact {contact_id} not found for client {client.id!r}.")
    return contact


def _make_primary(client: Client, contact: ClientContact, now: datetime):
    for other in client.active_contacts:
        if other.id != contact.id and other.is_primary:
            other.is_primary = False
            other.updated_at = now
    contact.is_primary = True


def add_contact(db: Session, actor: Actor, client: Client, data: dict, expected: int | None, now: datetime) -> dict:
    _require_version(expected, client.row_version, CLIENT_STALE)
    _check(crm.can_edit_client(client_dict(client), actor, _users(db)))
    checked = crm.validate_contact_fields(data)
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    contact = ClientContact(client_id=client.id, name=v["name"], title=v["title"], phone=v["phone"], email=v["email"],
                            notes=v["notes"], is_primary=False, created_at=now, updated_at=now)
    client.contacts.append(contact)
    if v["isPrimary"] or client.primary_contact is None:
        _make_primary(client, contact, now)
    client.updated_at = now  # the client's own version moves too, so other open screens reload
    db.flush()
    _history(db, client, actor, "contact_added", now, details={"contactId": contact.id, "name": contact.name,
                                                              "primary": contact.is_primary})
    warnings = _duplicates(db, "", [{"phone": v["phone"], "email": v["email"]}], client.id)
    return {"client": client, "message": f"{contact.name} added.", "warnings": warnings}


CONTACT_FIELDS = ("name", "title", "phone", "email", "notes")


def update_contact(db: Session, actor: Actor, client: Client, contact_id: int, data: dict, expected: int | None,
                   now: datetime) -> dict:
    contact = _contact_or_404(client, contact_id)
    _require_version(expected, contact.row_version, CONTACT_STALE)
    _check(crm.can_edit_client(client_dict(client), actor, _users(db)))
    current = {k: getattr(contact, k) for k in CONTACT_FIELDS}
    checked = crm.validate_contact_fields({**current, **data, "isPrimary": data.get("isPrimary", contact.is_primary)})
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    v = checked["values"]
    changes = {k: {"from": current[k], "to": v[k]} for k in CONTACT_FIELDS if current[k] != v[k]}
    for k in CONTACT_FIELDS:
        setattr(contact, k, v[k])
    if v["isPrimary"] and not contact.is_primary:
        _make_primary(client, contact, now)
        changes["primary"] = {"from": False, "to": True}
    if changes:
        contact.updated_at = now
        client.updated_at = now
        db.flush()
        _history(db, client, actor, "contact_updated", now, details={"contactId": contact.id, "name": contact.name,
                                                                    "changes": changes})
    message = (f"{contact.name} is now the main contact." if list(changes) == ["primary"]
               else "Contact saved." if changes else "Nothing changed.")
    return {"client": client, "message": message, "warnings": []}


def archive_contact(db: Session, actor: Actor, client: Client, contact_id: int, expected: int | None,
                    now: datetime) -> dict:
    contact = _contact_or_404(client, contact_id)
    _require_version(expected, contact.row_version, CONTACT_STALE)
    _check(crm.can_edit_client(client_dict(client), actor, _users(db)))
    contact.archived_at = now
    was_primary = contact.is_primary
    contact.is_primary = False
    contact.updated_at = now
    client.updated_at = now
    db.flush()
    _history(db, client, actor, "contact_archived", now, details={"contactId": contact.id, "name": contact.name,
                                                                 "wasPrimary": was_primary})
    return {"client": client, "message": f"{contact.name} archived.", "warnings": []}

