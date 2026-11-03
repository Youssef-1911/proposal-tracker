"""The dropdown lists as Settings left them (defaults + list_options rows), and Settings' changes."""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import begin_write
from ..domain import lists as rules
from ..domain.access import has_privilege
from ..errors import forbidden, validation
from ..identity import Actor
from ..models import ListOption


def load_lists(db: Session) -> dict:
    rows = [{"listId": r.list_id, "code": r.code, "label": r.label, "hidden": r.hidden, "position": r.position}
            for r in db.scalars(select(ListOption)).all()]
    return rules.effective_lists(rows)


def lists_out(db: Session) -> dict:
    """GET /api/config "lists": every list with its options (hidden ones flagged) and the list labels."""
    return {"definitions": rules.LIST_DEFS, "options": load_lists(db)}


def change_list(db: Session, actor: Actor, users: dict, list_id: str, data: dict, now: datetime) -> dict:
    """Add, rename, hide or show one option ("Manage accounts"; HR also the facilitators' skills). Never deletes."""
    if not has_privilege(users.get(actor.user_id), "manageAccounts") and not (
            list_id == "facilitatorSkills" and actor.active_role == "hr"):
        raise forbidden('Only people with "Manage accounts" can change the lists.')
    begin_write(db)
    lists = load_lists(db)
    checked = rules.validate_list_change(lists, list_id, data)
    if checked["errors"]:
        raise validation("Please fix the highlighted fields.", checked["errors"])
    row = checked["row"]
    stored = db.get(ListOption, (list_id, row["code"]))
    if stored is None:
        position = len(lists[list_id])
        db.add(ListOption(list_id=list_id, code=row["code"], label=row["label"], hidden=row["hidden"],
                          position=position, updated_at=now, updated_by_id=actor.user_id))
    else:
        stored.label, stored.hidden = row["label"], row["hidden"]
        stored.updated_at, stored.updated_by_id = now, actor.user_id
    db.flush()
    verb = {"add": "added", "rename": "renamed", "hide": "hidden", "show": "shown again"}[data["action"]]
    return {"message": f'"{row["label"]}" {verb}.'}
