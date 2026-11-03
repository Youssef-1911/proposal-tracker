"""
Status, deadline, visibility and derived-view rules.
Port of frontend metrics.js (request parts) and proposals.js.
"""

import math
from datetime import date, datetime, timedelta

from ..config_domain import ACCOUNT_MANAGER, BUSINESS_DEVELOPMENT, PROPOSAL_STAGES, PROPOSAL_STATUSES
from ..clock import cairo_today_iso
from .views import RequestView

STATUS = {s["id"]: s for s in PROPOSAL_STATUSES}
STATUS_ORDER = [s["id"] for s in sorted(PROPOSAL_STATUSES, key=lambda s: s["order"])]
STAGES = {s["id"]: s for s in PROPOSAL_STAGES}
DRAFT = "draft"
READY_FOR_BD = "ready_for_bd"
IN_PROGRESS = "in_progress"
STALE_AFTER_DAYS = 3
UPCOMING_WINDOW_DAYS = 7


def status_cfg(status: str) -> dict:
    return STATUS.get(status, {"id": status, "closed": False, "waitingOn": "none", "deadlinePending": False})


def open_status_ids() -> list[str]:
    return [s for s in STATUS_ORDER if s != DRAFT and not STATUS[s]["closed"]]


# ---------- dates (ISO strings, like the frontend) ----------

def add_days_iso(today: str, days: int) -> str:
    return (date.fromisoformat(today) + timedelta(days=days)).isoformat()


def is_before_today(date_iso: str | None, today: str) -> bool:
    return bool(date_iso) and date_iso < today


def is_within_next_days(date_iso: str | None, today: str, days: int = UPCOMING_WINDOW_DAYS) -> bool:
    return bool(date_iso) and today <= date_iso <= add_days_iso(today, days)


# ---------- status rules ----------

def is_draft(r: RequestView) -> bool:
    return r.status == DRAFT


def is_open_request(r: RequestView) -> bool:
    """THE definition of open: anything except Draft, Accepted, Rejected, Cancelled."""
    return not is_draft(r) and not status_cfg(r.status)["closed"]


def is_closed(r: RequestView) -> bool:
    return bool(status_cfg(r.status)["closed"])


def stage_of(status: str) -> str | None:
    """Display stage of a status (presentation only; the 10 statuses stay the source of truth)."""
    return STATUS.get(status, {}).get("stage")


def sub_label(status: str, version: int = 1) -> str | None:
    """Short sub-label beside the stage. Revision names the version being prepared (version + 1)."""
    template = STATUS.get(status, {}).get("subLabel")
    return template.replace("{nextVersion}", str(version + 1)) if template else None


def statuses_in_stage(stage: str) -> list[str]:
    return [s for s in STATUS_ORDER if STATUS[s]["stage"] == stage]


def waiting_on(r: RequestView) -> str:
    return status_cfg(r.status)["waitingOn"]


def is_deadline_pending(r: RequestView) -> bool:
    """An imported request flagged "Needs review" has no deadline that counts until someone acts on it."""
    return status_cfg(r.status)["deadlinePending"] is True and not r.needs_review


def is_request_overdue(r: RequestView, today: str) -> bool:
    return is_open_request(r) and is_deadline_pending(r) and is_before_today(r.required_by, today)


def is_deadline_upcoming(r: RequestView, today: str, days: int = UPCOMING_WINDOW_DAYS) -> bool:
    return is_open_request(r) and is_deadline_pending(r) and is_within_next_days(r.required_by, today, days)


def last_status_change_at(r: RequestView) -> datetime | None:
    return r.history[-1].changed_at if r.history else None


def days_since_last_change(r: RequestView, now: datetime) -> float | None:
    last = last_status_change_at(r)
    return (now - last).total_seconds() / 86400 if last else None


def is_stale(r: RequestView, now: datetime) -> bool:
    if r.needs_review:
        return False  # imported, to be checked: not "stuck"
    # A postponed proposal is waiting on purpose until its follow-up date.
    if r.status == "postponed" and r.follow_up_on and r.follow_up_on > cairo_today_iso(now):
        return False
    days = days_since_last_change(r, now)
    return is_open_request(r) and days is not None and days > STALE_AFTER_DAYS


# ---------- visibility ----------

def is_visible_draft_for(r: RequestView, user_id: str) -> bool:
    return is_draft(r) and r.created_by == user_id


def can_view_request(r: RequestView, user_id: str) -> bool:
    """Every team member may view non-draft requests; a draft only its creator (even the Head)."""
    return not is_draft(r) or is_visible_draft_for(r, user_id)


# ---------- derived views (proposals.js) ----------

def responsible_for(r: RequestView) -> dict | None:
    who = waiting_on(r)
    if who == "am":
        return {"userId": r.assigned_am, "role": ACCOUNT_MANAGER}
    if who == "bd":
        return {"userId": r.created_by, "role": None} if is_draft(r) else {"userId": r.bd_owner, "role": BUSINESS_DEVELOPMENT}
    return None


def has_proposal_file(r: RequestView, version: int) -> bool:
    return version in r.file_versions


def price_per_participant(price: int | None, participants: int | None) -> int | None:
    """Rounded to whole EGP like JavaScript's Math.round; None when either number is missing."""
    if price is None or not participants:
        return None
    return math.floor(price / participants + 0.5)


def proposal_versions(r: RequestView) -> list[dict]:
    """Versions from history, newest first. Prices are never invented (null = not recorded)."""
    by_version: dict[int, dict] = {}
    for e in r.history:
        if e.status == READY_FOR_BD:
            by_version[e.version] = {"version": e.version, "amPrice": e.am_price, "changeNote": e.note,
                                     "readyAt": e.changed_at, "readyBy": e.changed_by}
    versions = list(by_version.values())
    reached_work = any(e.status == IN_PROGRESS for e in r.history)
    if r.version not in by_version and reached_work and not is_closed(r):
        versions.append({"version": r.version, "amPrice": None, "changeNote": None, "readyAt": None, "readyBy": None,
                         "isPending": True})
    versions.sort(key=lambda v: -v["version"])
    return [{**v, "pricePerParticipant": price_per_participant(v["amPrice"], r.participants),
             "hasFile": has_proposal_file(r, v["version"]), "isCurrent": v["version"] == r.version,
             "isPending": bool(v.get("isPending"))} for v in versions]


def stage_timing(r: RequestView, now: datetime) -> dict:
    """Counters: since entering the current display stage, and since last shared (whole days, rounded down)."""
    h = r.history
    stage = stage_of(r.status)
    i = len(h) - 1
    while i > 0 and stage_of(h[i - 1].status) == stage:
        i -= 1

    def days(ts: datetime) -> int:
        return max(0, (now - ts) // timedelta(days=1))

    since = h[i].changed_at if h else None
    shared = next((e for e in reversed(h) if e.status == "shared_with_client"), None)
    return {
        "stageSince": since, "daysInStage": days(since) if since else None,
        "sharedAt": shared.changed_at if shared else None,
        "daysSinceShared": days(shared.changed_at) if shared and r.status == "shared_with_client" else None,
    }
