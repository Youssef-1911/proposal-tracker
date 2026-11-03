"""
Proposal Tracker rules (port of frontend tracker.js): scopes, Needs-my-action, deadline
state, tabs, search, filters and the approved three-group sort.

Visibility is always applied first (requests_in_scope), so search, filters, tab counts
and empty results can only ever see requests the viewer may view.
"""

from dataclasses import dataclass, field
from datetime import datetime
from functools import cmp_to_key

from ..config_domain import ACCOUNT_MANAGER, BUSINESS_DEVELOPMENT, COMMERCIAL_HEAD, EXECUTIVE, SEE_ALL_BRANDS
from ..clock import cairo_today_iso
from .access import can_see_brand, has_privilege
from .permissions import ASSIGNED_AM, BD_OWNER, holds_responsibility
from .rules import (
    can_view_request, is_closed, is_deadline_pending, is_deadline_upcoming, is_draft, is_open_request,
    is_request_overdue, is_stale, is_visible_draft_for, stage_of, status_cfg,
)
from .waiting import effective_waiting, matches_waiting_chip
from .views import RequestView
from .workflow import can_edit_draft

MINE, MY_BRAND, COMPANY = "mine", "my_brand", "company"
SCOPES_BY_ROLE = {
    BUSINESS_DEVELOPMENT: [MINE, COMPANY],
    ACCOUNT_MANAGER: [MY_BRAND, COMPANY],
    COMMERCIAL_HEAD: [COMPANY],
    EXECUTIVE: [COMPANY],
}

TAB_ALL, TAB_ACTION, TAB_OVERDUE, TAB_CLOSED = "all", "action", "overdue", "closed"
TABS = [TAB_ALL, TAB_ACTION, TAB_OVERDUE, TAB_CLOSED]

SORT_DEADLINE, SORT_UPDATED, SORT_EVENT = "deadline", "updated", "event"
SORTS = [SORT_DEADLINE, SORT_UPDATED, SORT_EVENT]

OVERDUE, UPCOMING, LATER, NONE = "overdue", "upcoming", "later", "none"
DEADLINE_STATES = [OVERDUE, UPCOMING, LATER, NONE]


def scopes_for(active_role: str, user=None) -> list[str]:
    """An Account Manager gets the other brand (company) only with "See all brands"; Marketing and Operations none."""
    scopes = SCOPES_BY_ROLE.get(active_role, [])
    if active_role == ACCOUNT_MANAGER and not has_privilege(user, SEE_ALL_BRANDS):
        return [s for s in scopes if s != COMPANY]
    return scopes


def default_scope(active_role: str, user=None) -> str | None:
    scopes = scopes_for(active_role, user)
    return scopes[0] if scopes else None


def in_scope(r: RequestView, viewer, user, scope: str) -> bool:
    """
    BD   mine     = requests I own + my own drafts      company  = other owners' non-draft requests
    AM   my_brand = my brand's non-draft requests       company  = the other brand's non-draft requests ("See all brands")
    Head company  = every non-draft request + my own drafts
    Executive company = every non-draft request (view-only)
    user = the viewer's UserView (brand, privileges).
    """
    if scope not in scopes_for(viewer.active_role, user):
        return False
    if not can_view_request(r, viewer.user_id) or not can_see_brand(viewer, user, r.brand):
        return False
    user_brand = user.brand if user is not None else None
    role = viewer.active_role
    if role == BUSINESS_DEVELOPMENT:
        if scope == MINE:
            return is_visible_draft_for(r, viewer.user_id) if is_draft(r) else r.bd_owner == viewer.user_id
        if scope == COMPANY:
            return not is_draft(r) and r.bd_owner != viewer.user_id
    if role == ACCOUNT_MANAGER:
        if scope == MY_BRAND:
            return not is_draft(r) and r.brand == user_brand
        if scope == COMPANY:
            return not is_draft(r) and r.brand != user_brand
    if role in (COMMERCIAL_HEAD, EXECUTIVE) and scope == COMPANY:
        return not is_draft(r) or is_visible_draft_for(r, viewer.user_id)
    return False


def needs_my_action(r: RequestView, viewer, users: dict, now: datetime) -> bool:
    if is_draft(r):
        return can_edit_draft(r, viewer, users)
    if not is_open_request(r):
        return False
    if r.needs_review:
        return False  # shown as "Review N imported requests" instead, never in queues
    who = status_cfg(r.status)["waitingOn"]
    # Waiting on someone set by hand: that is the one source of truth (e.g. Marketing — Nada, not the AM).
    manual = effective_waiting(r) if r.waiting_team else None
    # A postponed proposal needs BD again only once its follow-up date has come.
    if manual:
        mine = manual["userId"] == viewer.user_id
    elif who == "bd":
        mine = holds_responsibility(BD_OWNER, r, viewer, users) and (r.status != "postponed" or follow_up_due(r, now))
    else:
        mine = who == "am" and holds_responsibility(ASSIGNED_AM, r, viewer, users)
    # The Commercial Head watches stuck requests, plus the BD steps on requests she owns herself.
    if viewer.active_role == COMMERCIAL_HEAD:
        return is_stale(r, now) or mine
    return mine


def follow_up_due(r: RequestView, now: datetime) -> bool:
    """A postponed proposal whose follow-up date is today or past."""
    return r.status == "postponed" and bool(r.follow_up_on) and r.follow_up_on <= cairo_today_iso(now)


def deadline_state(r: RequestView, today: str) -> str:
    if is_request_overdue(r, today):
        return OVERDUE
    if is_deadline_upcoming(r, today):
        return UPCOMING
    if is_open_request(r) and is_deadline_pending(r) and r.required_by:
        return LATER
    return NONE


# ---------- filters ----------

@dataclass
class Filters:
    q: str = ""
    brand: str = ""
    status: list[str] = field(default_factory=list)
    stage: list[str] = field(default_factory=list)
    assigned_am: str = ""
    bd_owner: str = ""
    deadline: str = ""
    waiting_on: str = ""
    open: bool = False
    needs_review: bool = False
    waiting: str = ""  # "Waiting on" chip: me · bd · am · marketing · operations · client (domain/waiting.py)
    hide_events: bool = False  # the Proposals page: confirmed proposals are Events, listed there instead
    bucket: str = ""  # the Proposals page's tab: open · with_am · waiting · ready · with_client · postponed · closed


def matches(r: RequestView, f: Filters, client_names: dict, today: str, user_id: str = "") -> bool:
    needle = f.q.strip().lower()
    if needle and needle not in r.id.lower() and needle not in (client_names.get(r.client_id) or "").lower():
        return False
    if f.brand and r.brand != f.brand:
        return False
    if f.stage and stage_of(r.status) not in f.stage:
        return False
    if f.status and r.status not in f.status:
        return False
    if f.assigned_am and r.assigned_am != f.assigned_am:
        return False
    if f.bd_owner and r.bd_owner != f.bd_owner:
        return False
    if f.deadline and deadline_state(r, today) != f.deadline:
        return False
    if f.waiting_on and not matches_waiting_chip(r, f.waiting_on, user_id):
        return False
    if f.open and not is_open_request(r):
        return False
    if f.waiting and not matches_waiting_chip(r, f.waiting, user_id):
        return False
    if f.needs_review and not r.needs_review:
        return False
    if f.hide_events and r.status == "accepted":
        return False
    if f.bucket and not in_bucket(r, f.bucket):
        return False
    return True


def in_tab(tab: str, r: RequestView, viewer, users: dict, today: str, now: datetime) -> bool:
    if tab == TAB_ACTION:
        return needs_my_action(r, viewer, users, now)
    if tab == TAB_OVERDUE:
        return is_request_overdue(r, today)
    if tab == TAB_CLOSED:
        return is_closed(r)
    return True


# ---------- sorting (identical to the frontend comparator) ----------

def _cmp(a, b) -> int:
    return (a > b) - (a < b)


def _with_date(a: str | None, b: str | None) -> int:
    if not a and not b:
        return 0
    if not a:
        return 1
    if not b:
        return -1
    return _cmp(a, b)


def _event_start(r: RequestView) -> str | None:
    if not r.event_date:
        return None
    return f"{r.event_date}-01" if r.event_date_precision == "month" else r.event_date


def _sort_group(r: RequestView) -> int:
    if is_closed(r):
        return 2
    return 0 if is_open_request(r) and is_deadline_pending(r) else 1


def sort_requests(rows: list[RequestView], sort: str = SORT_DEADLINE) -> list[RequestView]:
    """
    deadline (default): 1) open with a pending deadline, soonest first (overdue on top);
                        2) other open requests and drafts; 3) closed, most recently updated first.
    Missing dates sort after dated items in their group; nothing is invented.
    """
    def compare(a: RequestView, b: RequestView) -> int:
        updated_desc = _cmp(b.last_updated, a.last_updated)
        if sort == SORT_UPDATED:
            return updated_desc or _cmp(a.id, b.id)
        if is_closed(a) != is_closed(b):
            return 1 if is_closed(a) else -1
        if is_closed(a):
            return updated_desc or _cmp(a.id, b.id)
        if sort == SORT_EVENT:
            return _with_date(_event_start(a), _event_start(b)) or _cmp(a.id, b.id)
        return _cmp(_sort_group(a), _sort_group(b)) or _with_date(a.required_by, b.required_by) or _cmp(a.id, b.id)

    return sorted(rows, key=cmp_to_key(compare))


# ---------- whole query ----------

@dataclass
class TrackerQuery:
    scope: str
    tab: str = TAB_ALL
    sort: str = SORT_UPDATED  # most recent activity first
    filters: Filters = field(default_factory=Filters)


def query_tracker(visible_in_scope: list[RequestView], q: TrackerQuery, *, viewer, users: dict,
                  client_names: dict, today: str, now: datetime) -> dict:
    """
    visible_in_scope must already be limited to what the viewer may see in q.scope
    (the API does that in SQL, then re-checks with in_scope). -> {rows, counts}
    """
    scoped = [r for r in visible_in_scope if in_scope(r, viewer, users.get(viewer.user_id), q.scope)]
    filtered = [r for r in scoped if matches(r, q.filters, client_names, today, viewer.user_id)]
    counts = {t: sum(1 for r in filtered if in_tab(t, r, viewer, users, today, now)) for t in TABS}
    rows = sort_requests([r for r in filtered if in_tab(q.tab, r, viewer, users, today, now)], q.sort)
    # The Proposals tabs' counts: every other filter applied, not the tab itself.
    unbucketed = filtered
    if q.filters.bucket:
        from dataclasses import replace as _replace
        f2 = _replace(q.filters, bucket="")
        unbucketed = [r for r in scoped if matches(r, f2, client_names, today, viewer.user_id)]
    bucket_counts = {t: sum(1 for r in unbucketed if in_bucket(r, t)) for t in PROPOSAL_TAB_IDS}
    return {"scoped": scoped, "rows": rows, "counts": counts, "bucketCounts": bucket_counts}


# ---------- the Proposals page's tabs (port of frontend proposalBucket) ----------

PROPOSAL_TAB_IDS = ["open", "with_am", "waiting", "ready", "with_client", "postponed", "closed"]
_WAITING_TEAMS = ("bd", "marketing", "operations", "management")


def proposal_bucket(r: RequestView) -> str | None:
    s = r.status
    if s == "accepted":
        return None
    if s == "draft":
        return "draft"
    if s in ("rejected", "cancelled", "closed_unrecorded", "closed_postponed"):
        return "closed"
    if s == "postponed":
        return "postponed"
    if s == "shared_with_client":
        return "with_client"
    if s == "ready_for_bd":
        return "ready"
    if s == "awaiting_bd_info":
        return "waiting"
    w = effective_waiting(r) if r.waiting_team else None
    if w and w["team"] in _WAITING_TEAMS:
        return "waiting"
    return "with_am"


def in_bucket(r: RequestView, tab: str) -> bool:
    b = proposal_bucket(r)
    if b is None:
        return False
    return b != "closed" if tab == "open" else b == tab
