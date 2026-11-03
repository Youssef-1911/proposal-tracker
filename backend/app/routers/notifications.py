"""The bell (in-app notifications) and "Remind"."""

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from sqlalchemy.orm import Session

from ..clock import get_now, iso_z
from ..database import begin_write, get_db
from ..identity import Actor, get_current_actor
from ..services import notifications as service

router = APIRouter(prefix="/api", tags=["notifications"])


class RemindIn(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")
    request_id: str


def _out(n) -> dict:
    return {"id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "link": n.link, "requestIds": n.request_ids or [],
            "actor": n.actor_id, "createdAt": iso_z(n.created_at), "readAt": iso_z(n.read_at)}


@router.get("/notifications")
def list_notifications(actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    """The latest 20, newest first, and how many are unread."""
    got = service.list_for(db, actor)
    return {"items": [_out(n) for n in got["items"]], "unread": got["unread"]}


@router.post("/notifications/{notification_id}/read")
def read_one(notification_id: int, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
             db: Session = Depends(get_db)):
    begin_write(db)
    service.mark_read(db, actor, notification_id, now)
    db.commit()
    return list_notifications(actor, db)


@router.post("/notifications/read-all")
def read_all(actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    begin_write(db)
    service.mark_read(db, actor, None, now)
    db.commit()
    return list_notifications(actor, db)


@router.get("/reminders")
def reminder_status(actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                    db: Session = Depends(get_db)):
    """{userId: nextAt} for everyone who was reminded in the last 24 hours (the button shows when the next is possible)."""
    return {"nextAt": {uid: iso_z(at) for uid, at in service.reminder_status(db, now).items() if at}}


@router.post("/reminders")
def remind(body: RemindIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
           db: Session = Depends(get_db)):
    """Remind the person this request waits on: ONE notification listing everything waiting on them."""
    begin_write(db)
    result = service.remind(db, actor, body.request_id, now)
    db.commit()
    return {**result, "warnings": []}
