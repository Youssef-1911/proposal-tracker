"""
"Where is it / Waiting on". Port of frontend waiting.js (same answers and messages; the contract
file checks both). Automatic from the status unless set by hand; any status change clears it.
"""

import re
from datetime import date

from ..config_domain import (ACCOUNT_MANAGER, BUSINESS_DEVELOPMENT, COMMERCIAL_HEAD, EXECUTIVE, MARKETING,
                             OPERATIONS)
from .access import acts_as_business_development
from .lists import OTHER, check_codes
from .rules import status_cfg
from .views import RequestView

WAITING_TEAMS = [
    {"id": "bd", "label": "Business Development", "reasons": "waitingInternal", "roles": [BUSINESS_DEVELOPMENT]},
    {"id": "am", "label": "Account Manager", "reasons": "waitingInternal", "roles": [ACCOUNT_MANAGER]},
    {"id": "marketing", "label": "Marketing", "reasons": "waitingMarketing", "roles": [MARKETING]},
    {"id": "operations", "label": "Operations", "reasons": "waitingOperations", "roles": [OPERATIONS]},
    {"id": "client", "label": "Client", "reasons": "waitingClient", "roles": []},
    {"id": "management", "label": "Management", "reasons": "waitingInternal", "roles": [COMMERCIAL_HEAD, EXECUTIVE]},
]
TEAMS = {t["id"]: t for t in WAITING_TEAMS}
WAITING_CHIP_IDS = ["me", "bd", "am", "marketing", "operations", "client"]
WAITING_NOTE_MAX = 300
CLIENT_STATUSES = ("shared_with_client", "postponed")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")

OK = {"allowed": True, "reason": None}


def _deny(reason):
    return {"allowed": False, "reason": reason}


def _closed(r) -> bool:
    return status_cfg(r.status)["closed"]


def status_since(r: RequestView):
    return r.history[-1].changed_at if r.history else r.last_updated


def effective_waiting(r: RequestView) -> dict | None:
    if _closed(r):
        return None
    if r.waiting_team and r.status != "draft":
        return {"kind": "manual", "team": r.waiting_team, "userId": r.waiting_user_id, "reason": r.waiting_reason,
                "expectedBy": r.waiting_expected_by, "note": r.waiting_note, "since": r.waiting_set_at or status_since(r)}
    base = {"kind": "auto", "reason": None, "expectedBy": None, "note": None, "since": status_since(r)}
    if r.status == "draft":
        return {**base, "team": "bd", "userId": r.created_by}
    if r.status in CLIENT_STATUSES:
        return {**base, "team": "client", "userId": None}
    if status_cfg(r.status)["waitingOn"] == "am":
        return {**base, "team": "am", "userId": r.assigned_am}
    return {**base, "team": "bd", "userId": r.bd_owner}


def matches_waiting_chip(r: RequestView, chip: str, user_id: str) -> bool:
    if not chip:
        return True
    w = effective_waiting(r)
    if not w:
        return False
    return w["userId"] == user_id if chip == "me" else w["team"] == chip


def can_set_waiting_on(r: RequestView, viewer, users: dict) -> dict:
    if r.status == "draft":
        return _deny("A draft is not waiting on anyone yet.")
    if _closed(r):
        return _deny("This request is closed.")
    if viewer.active_role == COMMERCIAL_HEAD:
        return OK
    if viewer.user_id == r.bd_owner and acts_as_business_development(viewer, users.get(viewer.user_id)):
        return OK
    if viewer.user_id == r.assigned_am and viewer.active_role == ACCOUNT_MANAGER:
        return OK
    return _deny("Only the BD owner, the assigned Account Manager or the Commercial Head can change who it is waiting on.")


def can_clear_waiting_on(r: RequestView, viewer, users: dict) -> dict:
    if not r.waiting_team:
        return _deny("It already follows the status.")
    allowed = can_set_waiting_on(r, viewer, users)
    if allowed["allowed"] or _closed(r) or r.status == "draft":
        return allowed
    if r.waiting_user_id == viewer.user_id:
        return OK
    team = TEAMS.get(r.waiting_team)
    if not r.waiting_user_id and team and viewer.active_role in team["roles"]:
        return OK
    return allowed


def _real_date(value: str) -> bool:
    if not _DATE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def validate_waiting_on(data: dict, *, lists, users: dict, today: str | None = None) -> dict:
    def text(v):
        return v.strip() if isinstance(v, str) and v.strip() else None

    values = {"team": text(data.get("team")), "userId": text(data.get("userId")), "reason": text(data.get("reason")),
              "expectedBy": text(data.get("expectedBy")), "note": text(data.get("note"))}
    errors = {}
    team = TEAMS.get(values["team"])
    if not team:
        errors["team"] = "Choose who it is waiting on."
        return {"errors": errors, "values": values}
    if team["id"] == "client":
        values["userId"] = None
    elif values["userId"]:
        u = users.get(values["userId"])
        if u is None or u.active is False or not any(r in team["roles"] for r in u.roles):
            errors["userId"] = f"Choose someone from {team['label']}."
    elif team["id"] in ("bd", "am"):
        errors["userId"] = "Choose the person."
    if not values["reason"]:
        errors["reason"] = "Choose the reason."
    elif check_codes(lists, team["reasons"], [values["reason"]], multi=False):
        errors["reason"] = "Choose a reason from the list."
    if values["expectedBy"]:
        if not _real_date(values["expectedBy"]):
            errors["expectedBy"] = "Enter a valid date."
        elif today and values["expectedBy"] < today:
            errors["expectedBy"] = "The expected date cannot be in the past."
    if values["reason"] == OTHER and not values["note"]:
        errors["note"] = 'Add a note when choosing "Other".'
    if values["note"] and len(values["note"]) > WAITING_NOTE_MAX:
        errors["note"] = f"Use at most {WAITING_NOTE_MAX} characters."
    return {"errors": errors, "values": values}


def waiting_label(w: dict | None, users: dict) -> str:
    if not w:
        return "—"
    if w["team"] == "client":
        return "Client"
    person = (users[w["userId"]].name if w["userId"] in users else w["userId"]) if w.get("userId") else None
    if w["team"] in ("bd", "am"):
        return person or TEAMS[w["team"]]["label"]
    return f"{TEAMS[w['team']]['label']} — {person}" if person else TEAMS[w["team"]]["label"]
