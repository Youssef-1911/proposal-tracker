"""
Personal to-dos (My Work). Private: every query is limited to the caller's own to-dos, so anyone
else's answers 404 (Noha's included, and Noha never sees anyone else's). Rules: app/domain/todos.py.

  GET  /api/todos                 mine: open ones, plus those done in the last 30 days
  POST /api/todos                 add { text, dueOn?, linkKind?, linkId? }
  PATCH /api/todos/{id}           edit the same fields
  POST /api/todos/{id}/done       { done: true | false } tick or untick
  POST /api/todos/{id}/delete     soft delete (hidden for good; kept in the database)

No notifications, nothing in Analytics or on /screen.
"""

from datetime import date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..clock import get_now, iso_z
from ..database import begin_write, get_db
from ..domain.todos import COMPLETED_DAYS, validate_todo
from ..errors import ApiError, not_found, validation
from ..identity import Actor, get_current_actor
from ..models import Client, ProposalRequest, Todo
from . import clients as clients_router, events as events_router, proposal_requests as requests_router

router = APIRouter(prefix="/api/todos", tags=["todos"])


class _In(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class TodoIn(_In):
    text: Any = None
    due_on: Any = None
    link_kind: Any = None
    link_id: Any = None


class DoneIn(_In):
    done: bool


def _can_see(db: Session, actor: Actor, kind: str, item_id: str) -> bool:
    """The same visibility as the client, request and event pages (a 404 there is "not available" here)."""
    try:
        if kind == "client":
            clients_router._load_visible(db, item_id, actor)
        elif kind == "request":
            requests_router._load_visible(db, item_id, actor)
        else:
            events_router._load(db, item_id, actor)
        return True
    except ApiError:
        return False


def _labels(db: Session, todos: list[Todo]) -> dict:
    """"Client" or "Client · Event name" for each linked item (names only; nothing else about it)."""
    client_ids = {t.link_id for t in todos if t.link_kind == "client"}
    request_ids = {t.link_id for t in todos if t.link_kind in ("request", "event")}
    requests = {r.id: r for r in db.scalars(select(ProposalRequest).where(ProposalRequest.id.in_(request_ids))).all()} if request_ids else {}
    client_ids |= {r.client_id for r in requests.values()}
    names = dict(db.execute(select(Client.id, Client.name).where(Client.id.in_(client_ids))).all()) if client_ids else {}
    out = {}
    for t in todos:
        if t.link_kind == "client":
            out[t.id] = names.get(t.link_id)
        elif t.link_kind:
            r = requests.get(t.link_id)
            out[t.id] = " · ".join(x for x in (names.get(r.client_id), r.event_name) if x) or t.link_id if r else None
    return out


def _out(t: Todo, label: str | None) -> dict:
    return {"id": t.id, "text": t.text, "dueOn": t.due_on.isoformat() if t.due_on else None,
            "linkKind": t.link_kind, "linkId": t.link_id, "linkLabel": label,
            "doneAt": iso_z(t.done_at), "createdAt": iso_z(t.created_at), "updatedAt": iso_z(t.updated_at)}


def _mine(db: Session, actor: Actor, todo_id: int) -> Todo:
    t = db.scalars(select(Todo).where(Todo.id == todo_id, Todo.owner_id == actor.user_id, Todo.deleted_at.is_(None))).first()
    if t is None:
        raise not_found("No such to-do.")  # the same for someone else's: they are private
    return t


def _checked(db: Session, actor: Actor, body: TodoIn) -> dict:
    errors, values = validate_todo(body.model_dump(by_alias=True))
    if not errors and values["linkKind"] and not _can_see(db, actor, values["linkKind"], values["linkId"]):
        errors["link"] = "That client, request or event is not available to you."
    if errors:
        raise validation("Please fix the highlighted fields.", errors)
    return values


def _one(db: Session, t: Todo) -> dict:
    return _out(t, _labels(db, [t]).get(t.id))


@router.get("")
def list_todos(actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    since = now - timedelta(days=COMPLETED_DAYS + 1)
    todos = db.scalars(select(Todo).where(Todo.owner_id == actor.user_id, Todo.deleted_at.is_(None),
                                          or_(Todo.done_at.is_(None), Todo.done_at >= since))
                       .order_by(Todo.id)).all()
    labels = _labels(db, todos)
    return {"items": [_out(t, labels.get(t.id)) for t in todos]}


@router.post("", status_code=201)
def create_todo(body: TodoIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                db: Session = Depends(get_db)):
    begin_write(db)
    v = _checked(db, actor, body)
    t = Todo(owner_id=actor.user_id, text=v["text"], due_on=date.fromisoformat(v["dueOn"]) if v["dueOn"] else None,
             link_kind=v["linkKind"], link_id=v["linkId"], created_at=now, updated_at=now)
    db.add(t)
    db.commit()
    return _one(db, t)


@router.patch("/{todo_id}")
def update_todo(todo_id: int, body: TodoIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                db: Session = Depends(get_db)):
    begin_write(db)
    t = _mine(db, actor, todo_id)
    v = _checked(db, actor, body)
    t.text, t.link_kind, t.link_id = v["text"], v["linkKind"], v["linkId"]
    t.due_on = date.fromisoformat(v["dueOn"]) if v["dueOn"] else None
    t.updated_at = now
    db.commit()
    return _one(db, t)


@router.post("/{todo_id}/done")
def set_done(todo_id: int, body: DoneIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
             db: Session = Depends(get_db)):
    begin_write(db)
    t = _mine(db, actor, todo_id)
    t.done_at = now if body.done else None
    t.updated_at = now
    db.commit()
    return _one(db, t)


@router.post("/{todo_id}/delete")
def delete_todo(todo_id: int, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                db: Session = Depends(get_db)):
    begin_write(db)
    t = _mine(db, actor, todo_id)
    t.deleted_at = now
    t.updated_at = now
    db.commit()
    return {"id": t.id, "deleted": True}
