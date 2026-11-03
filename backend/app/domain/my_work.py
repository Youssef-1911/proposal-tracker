"""
My Work's sections: the same rule as frontend/src/domain/myWork.js (myWorkSection, stuckDays).

  'turn'   it waits on me, or my postponed proposal's follow-up date has come
  'team'   Waiting on others · the team (what I sent or own; Noha and Executives: every open request)
  'client' Waiting on others · the client (shared or postponed)
  None     not in My Work
"""

from datetime import datetime, timezone

from .tracker import follow_up_due
from .waiting import effective_waiting

STUCK_DAYS = 3
MANAGEMENT = ("commercial_head", "executive")
CLOSED = {"accepted", "rejected", "cancelled", "closed_unrecorded", "closed_postponed"}


def _is_open(r) -> bool:
    return r.status != "draft" and r.status not in CLOSED and not r.needs_review


def _days_since(since, now: datetime) -> int:
    if not since:
        return 0
    if isinstance(since, str):
        since = datetime.fromisoformat(since.replace("Z", "+00:00"))
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    return max(0, int((now - since).total_seconds() // 86400))


def stuck_days(r, role: str, now: datetime) -> int | None:
    if role not in MANAGEMENT or not _is_open(r):
        return None
    days = _days_since((effective_waiting(r) or {}).get("since"), now)
    return days if days >= STUCK_DAYS else None


def my_work_section(r, user_id: str, role: str, now: datetime) -> str | None:
    if not _is_open(r):
        return None
    w = effective_waiting(r) or {}
    follow_up = r.status == "postponed" and r.bd_owner == user_id and role != "account_manager" and follow_up_due(r, now)
    if w.get("userId") == user_id or follow_up:
        return "turn"
    involved = user_id in (r.bd_owner, r.assigned_am, r.created_by)
    if not involved and role not in MANAGEMENT:
        return None
    return "client" if w.get("team") == "client" else "team"
