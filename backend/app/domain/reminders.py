"""
"Remind": one in-app notification to the person a request waits on, listing everything waiting on them,
at most once per recipient every 24 hours. Port of frontend reminders.js (the contract file checks both).
"""

from datetime import datetime, timedelta

from .access import acts_as_business_development
from .rules import status_cfg
from .waiting import effective_waiting

REMIND_EVERY_HOURS = 24
OK = {"allowed": True, "reason": None}


def _deny(reason):
    return {"allowed": False, "reason": reason}


def remindable(r) -> bool:
    return r.status != "draft" and not status_cfg(r.status)["closed"] and not r.needs_review


def remind_target(r):
    w = effective_waiting(r) if remindable(r) else None
    return w.get("userId") if w else None


def can_remind(r, viewer, users: dict) -> dict:
    if not remindable(r):
        return _deny("Nothing to remind about on this request.")
    target = remind_target(r)
    if not target:
        return _deny("It is not waiting on a person.")
    if target == viewer.user_id:
        return _deny("It is waiting on you.")
    if target in users and users[target].active is False:
        return _deny("That person is no longer active.")
    holds = (viewer.active_role in ("commercial_head", "executive")
             or (viewer.user_id == r.bd_owner and acts_as_business_development(viewer, users.get(viewer.user_id)))
             or (viewer.user_id == r.assigned_am and viewer.active_role == "account_manager"))
    if holds:
        return OK
    return _deny("Only the BD owner, the assigned Account Manager, the Commercial Head or an Executive can send a reminder.")


def waiting_on_person(requests, user_id) -> list:
    return [r for r in requests if remind_target(r) == user_id]


def next_reminder_at(last_sent_at: datetime | None, now: datetime) -> datetime | None:
    if last_sent_at is None:
        return None
    nxt = last_sent_at + timedelta(hours=REMIND_EVERY_HOURS)
    return nxt if nxt > now else None
