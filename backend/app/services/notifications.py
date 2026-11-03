"""
In-app notifications (the bell) and "Remind". Server-side rules:
- a notification only lists requests its recipient may view; drafts and untouched imported rows
  ("Needs review") never notify; inactive accounts get nothing;
- one reminder per recipient every 24 hours, listing everything waiting on them, recorded on each request.
No email, pop-ups or sounds.
"""

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..domain import activity, reminders
from ..domain.access import can_see_request
from ..domain.views import request_from_orm
from ..errors import ApiError
from ..identity import Actor
from ..models import Client, Notification, ProposalRequest, RequestComment, RequestEvent
from .proposal_requests import _users

LIST_LIMIT = 20


def _client_names(db: Session) -> dict:
    return {c.id: c.name for c in db.scalars(select(Client)).all()}


def recipient_can_view(view, user, users: dict) -> bool:
    """May this person see the request in any of their roles?"""
    return any(can_see_request(view, Actor(user.id, role), users) for role in user.roles)


def notify(db: Session, *, user_id: str, kind: str, title: str, body: str | None, link: str | None,
           request_ids: list[str], actor_id: str | None, now: datetime, users: dict, role: str | None = None) -> Notification | None:
    user = users.get(user_id)
    if user is None or user.active is False:
        return None  # inactive accounts get nothing
    note = Notification(user_id=user_id, kind=kind, title=title, body=body, link=link, request_ids=request_ids,
                        actor_id=actor_id, created_at=now, role=role)
    db.add(note)
    return note


def last_reminder_at(db: Session, user_id: str):
    return db.scalar(select(func.max(Notification.created_at))
                     .where(Notification.user_id == user_id, Notification.kind == "reminder"))


def reminder_status(db: Session, now: datetime) -> dict:
    """{userId: nextAt} for every recipient who cannot be reminded again yet."""
    since = now - timedelta(hours=reminders.REMIND_EVERY_HOURS)
    rows = db.execute(select(Notification.user_id, func.max(Notification.created_at))
                      .where(Notification.kind == "reminder", Notification.created_at > since)
                      .group_by(Notification.user_id)).all()
    return {uid: reminders.next_reminder_at(at, now) for uid, at in rows}


def remind(db: Session, actor: Actor, request_id: str, now: datetime) -> dict:
    users = _users(db)
    row = db.scalars(select(ProposalRequest).where(ProposalRequest.id == request_id)
                     .options(selectinload(ProposalRequest.history))).first()
    if row is None or not can_see_request(request_from_orm(row), actor, users):
        raise ApiError(404, "not_found", f"Request {request_id!r} not found.")
    view = request_from_orm(row)
    permission = reminders.can_remind(view, actor, users)
    if not permission["allowed"]:
        raise ApiError(403, "forbidden", permission["reason"])
    target = reminders.remind_target(view)
    nxt = reminders.next_reminder_at(last_reminder_at(db, target), now)
    if nxt is not None:
        raise ApiError(409, "too_soon", f"{users[target].name} was reminded in the last 24 hours. Next possible at {nxt.isoformat()}.")
    everything = db.scalars(select(ProposalRequest).where(ProposalRequest.status != "draft")
                            .options(selectinload(ProposalRequest.history))).all()
    names = _client_names(db)
    waiting = [r for r in everything
               if reminders.remind_target(v := request_from_orm(r)) == target and recipient_can_view(v, users[target], users)]
    n = len(waiting)
    title = f"{n} request{'s are' if n != 1 else ' is'} waiting on you"
    body = "\n".join(f"{r.id} · {names.get(r.client_id) or '—'}{f' · {r.event_name}' if r.event_name else ''}" for r in waiting)
    notify(db, user_id=target, kind="reminder", title=title, body=body, link="/proposals?waiting=me",
           request_ids=[r.id for r in waiting], actor_id=actor.user_id, now=now, users=users)
    for r in waiting:
        db.add(RequestEvent(request_id=r.id, event="reminder_sent", changed_by_id=actor.user_id, role=actor.active_role,
                            changed_at=now, to_user_id=target,
                            note=f"Reminder sent to {users[target].name} by {users[actor.user_id].name}"))
    db.flush()
    return {"message": f"Reminder sent to {users[target].name} ({title.lower()}).", "recipient": target, "count": n,
            "nextAt": (now + timedelta(hours=reminders.REMIND_EVERY_HOURS)).isoformat()}


def activity_sources(db: Session, row: ProposalRequest) -> tuple[list, list]:
    """The request's messages and non-status events, as the activity rules read them (fresh from the database)."""
    messages = [{"id": c.id, "kind": c.kind, "body": c.body, "about": c.about, "parentId": c.parent_id,
                 "reasons": c.reasons, "author": c.author_id, "role": c.role, "createdAt": c.created_at}
                for c in db.scalars(select(RequestComment).where(RequestComment.request_id == row.id)
                                    .order_by(RequestComment.id)).all()]
    events = [{"event": e.event, "changedBy": e.changed_by_id, "role": e.role, "changedAt": e.changed_at,
               "toUser": e.to_user_id, "details": e.details}
              for e in db.scalars(select(RequestEvent).where(RequestEvent.request_id == row.id)
                                  .order_by(RequestEvent.id)).all()]
    return messages, events


def _kind(item: dict) -> str:
    return item.get("kind") or "activity"


def notify_new_activity(db: Session, row: ProposalRequest, now: datetime) -> int:
    """
    The one shared rule: anything this change made "New" for someone also notifies them (bell), for the
    role it is new in (activity.new_recipients). Reminders notify on their own (one list per person).
    """
    if row.status == "draft" or (row.imported and row.needs_review):
        return 0
    db.flush()
    users = _users(db)
    messages, events = activity_sources(db, row)
    view = request_from_orm(row)
    from .lists import load_lists
    lists = load_lists(db)
    by_id = {m["id"]: m for m in messages}
    sent = 0
    for item in activity.activity_items(view, users, messages, events, lists):
        if item.get("source") == "reminder_sent" or activity._t(item["at"]) < activity._t(now):
            continue
        title = item["line"]
        if item.get("messageId") in by_id:  # a message carries its actual words
            m = by_id[item["messageId"]]
            title = activity.message_line(m, users[m["author"]].name if m["author"] in users else "Someone", lists)
        for r in activity.new_recipients(item, users):
            target = users[r["userId"]]
            link = f"/proposals/{row.id}" if recipient_can_view(view, target, users) else "/"
            if notify(db, user_id=target.id, kind=_kind(item), title=title[:200], body=None, link=link,
                      request_ids=[row.id], actor_id=item["by"], now=now, users=users, role=r["role"]):
                sent += 1
    db.flush()
    return sent


def _for_role(q, actor: Actor):
    """The bell shows what is for the role being worked in, plus what is for any role."""
    return q.where(Notification.user_id == actor.user_id,
                   (Notification.role.is_(None)) | (Notification.role == actor.active_role))


def list_for(db: Session, actor: Actor) -> dict:
    items = db.scalars(_for_role(select(Notification), actor)
                       .order_by(Notification.created_at.desc(), Notification.id.desc()).limit(LIST_LIMIT)).all()
    unread = db.scalar(_for_role(select(func.count()).select_from(Notification), actor)
                       .where(Notification.read_at.is_(None))) or 0
    return {"items": items, "unread": unread}


def mark_read(db: Session, actor: Actor, notification_id: int | None, now: datetime) -> None:
    q = _for_role(select(Notification), actor).where(Notification.read_at.is_(None))
    if notification_id is not None:
        q = q.where(Notification.id == notification_id)
    for n in db.scalars(q).all():
        n.read_at = now
    db.flush()


def notify_operations(db: Session, actor: Actor, row: ProposalRequest, label: str, now: datetime, detail: str | None = None) -> None:
    """Every event change goes to all active Operations and HR users (bell; "New" on their pages)."""
    notify_staff(db, actor, row, label, now, detail, roles=("operations", "hr"))


def notify_staff(db: Session, actor: Actor, row: ProposalRequest, label: str, now: datetime, detail: str | None = None,
                 roles=("operations", "hr")) -> None:
    """An event change for the people who staff and run events (never the person who made it)."""
    if row.imported and row.needs_review:
        return
    users = _users(db)
    names = _client_names(db)
    when = row.event_date.strftime("%d %b %Y") if row.event_date else "date not set"
    what = " · ".join(x for x in (names.get(row.client_id), row.event_name) if x)
    for u in users.values():
        if any(r in u.roles for r in roles) and u.active is not False and u.id != actor.user_id:
            notify(db, user_id=u.id, kind="event", title=f"{label}: {what} — {when}"[:200], body=detail,
                   link=f"/events/{row.id}", request_ids=[row.id], actor_id=actor.user_id, now=now, users=users)
