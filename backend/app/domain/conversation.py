"""
The conversation on a request (comments, questions and answers) and "Update details". Port of
frontend conversation.js (same answers and messages; the contract file checks both).
"""

import json

from ..config_domain import ACCOUNT_MANAGER, COMMERCIAL_HEAD
from .access import acts_as_business_development
from .lists import check_codes
from .request_form import normalize_request_fields, request_fields, validate_request_fields
from .rules import status_cfg

MESSAGE_KINDS = ("comment", "question", "answer", "answered", "change", "picked_up")
CHANGE_ORIGINS = ("client", "internal")
PICKED_UP_TEXT = "Picked up"
MESSAGE_MAX_LENGTH = 2000
ANSWERED_TEXT = "Marked as answered"
OK = {"allowed": True, "reason": None}


def _deny(reason):
    return {"allowed": False, "reason": reason}


def _closed(r) -> bool:
    return status_cfg(r.status)["closed"]


def _holds(r, viewer, users) -> bool:
    if viewer.active_role == COMMERCIAL_HEAD:
        return True
    if viewer.user_id == r.bd_owner and acts_as_business_development(viewer, users.get(viewer.user_id)):
        return True
    return viewer.user_id == r.assigned_am and viewer.active_role == ACCOUNT_MANAGER


def can_ask_question(r, viewer, users: dict) -> dict:
    if r.status == "draft":
        return _deny("Questions start once the request is submitted.")
    if _closed(r):
        return _deny("This request is closed.")
    if _holds(r, viewer, users):
        return OK
    return _deny("Only the BD owner, the assigned Account Manager or the Commercial Head can ask or answer questions.")


def open_change_ids(messages) -> list:
    picked = {m.get("parentId") for m in messages if m["kind"] == "picked_up"}
    return [m["id"] for m in messages if m["kind"] == "change" and m["id"] not in picked]


def can_post_message(kind, r, viewer, users: dict) -> dict:
    if kind in (None, "comment"):
        return OK
    if kind == "change":
        return OK if can_update_details(r, viewer, users)["allowed"] else _deny(
            "Only the BD owner or the Commercial Head can ask for a change.")
    if kind == "picked_up":
        if _closed(r):
            return _deny("This request is closed.")
        if (viewer.user_id == r.assigned_am and viewer.active_role == ACCOUNT_MANAGER) or viewer.active_role == COMMERCIAL_HEAD:
            return OK
        return _deny("Only the assigned Account Manager picks up a change.")
    return can_ask_question(r, viewer, users)


def open_question_ids(messages) -> list:
    """messages: dicts with id, kind, parentId."""
    closed = {m.get("parentId") for m in messages if m["kind"] in ("answer", "answered")}
    return [m["id"] for m in messages if m["kind"] == "question" and m["id"] not in closed]


def validate_message(data: dict, *, lists, messages=()) -> dict:
    errors = {}
    raw_kind = data.get("kind")
    kind = raw_kind if raw_kind in MESSAGE_KINDS else ("comment" if raw_kind is None else None)
    body = data.get("body").strip() if isinstance(data.get("body"), str) else ""
    values = {"kind": kind, "body": ANSWERED_TEXT if kind == "answered" else PICKED_UP_TEXT if kind == "picked_up" else body,
              "about": None, "parentId": None, "reasons": None}
    if not kind:
        errors["kind"] = "Choose comment, question or answer."
        return {"errors": errors, "values": values}
    if kind == "change":
        codes = data.get("reasons") if isinstance(data.get("reasons"), list) else []
        if not codes:
            errors["reasons"] = "Choose what should change."
        elif check_codes(lists, "whatShouldChange", codes, multi=True):
            errors["reasons"] = "Choose from the list."
        else:
            values["reasons"] = list(codes)
        if data.get("about") not in CHANGE_ORIGINS:
            errors["about"] = "Choose who asked for it."
        else:
            values["about"] = data.get("about")
        if "other" in codes and not body:
            errors["body"] = 'Describe "Other".'
        elif len(body) > MESSAGE_MAX_LENGTH:
            errors["body"] = f"Use at most {MESSAGE_MAX_LENGTH} characters."
        values["body"] = body or "Change needed"
        return {"errors": errors, "values": values}
    if kind == "picked_up":
        parent = next((m for m in messages if m["id"] == data.get("parentId")), None)
        if parent is None or parent["kind"] != "change":
            errors["parentId"] = "Choose the change you are picking up."
        elif parent["id"] not in open_change_ids(messages):
            errors["parentId"] = "This change is already picked up."
        else:
            values["parentId"] = parent["id"]
        return {"errors": errors, "values": values}
    if kind != "answered":
        if not body:
            errors["body"] = ("Write your question." if kind == "question"
                              else "Write your answer." if kind == "answer" else "Write a message.")
        elif len(body) > MESSAGE_MAX_LENGTH:
            errors["body"] = f"Use at most {MESSAGE_MAX_LENGTH} characters."
    about = data.get("about")
    if kind == "question" and about not in (None, ""):
        if check_codes(lists, "questionAbout", [about], multi=False):
            errors["about"] = "Choose from the list."
        else:
            values["about"] = about
    if kind in ("answer", "answered"):
        parent = next((m for m in messages if m["id"] == data.get("parentId")), None)
        if parent is None or parent["kind"] != "question":
            errors["parentId"] = "Choose the question you are answering."
        elif parent["id"] not in open_question_ids(messages):
            errors["parentId"] = "This question is already answered."
        else:
            values["parentId"] = parent["id"]
    return {"errors": errors, "values": values}


# ---------- "Update details" ----------

DETAIL_FIELDS = [
    {"id": "eventName", "label": "Event name"},
    {"id": "eventDatePrecision", "label": "Event date type"},
    {"id": "eventDate", "label": "Event date"},
    {"id": "eventEndDate", "label": "End date"},
    {"id": "participants", "label": "Participants"},
    {"id": "requirementsSummary", "label": "Brief"},
    {"id": "specificRequirements", "label": "Specific requirements"},
    {"id": "requiredBy", "label": "Proposal deadline"},
]
DETAIL_IDS = [f["id"] for f in DETAIL_FIELDS]


def can_update_details(r, viewer, users: dict) -> dict:
    if r.status == "draft":
        return _deny("Edit the draft instead.")
    if _closed(r):
        return _deny("This request is closed.")
    if viewer.active_role == COMMERCIAL_HEAD:
        return OK
    if viewer.user_id == r.bd_owner and acts_as_business_development(viewer, users.get(viewer.user_id)):
        return OK
    return _deny("Only the BD owner or the Commercial Head can update the details.")


def validate_details_update(r, data: dict, *, today: str, lists=None) -> dict:
    before = request_fields(r)
    picked = {k: v for k, v in data.items() if k in DETAIL_IDS}
    errors, values = validate_request_fields({**before, **picked}, mode="submit", today=today, lists=lists)
    was = normalize_request_fields(before)
    same = lambda a, b: json.dumps(a) == json.dumps(b)  # noqa: E731
    changes = [{"field": f["id"], "label": f["label"], "from": was.get(f["id"]), "to": values.get(f["id"])}
               for f in DETAIL_FIELDS if not same(was.get(f["id"]), values.get(f["id"]))]
    changed = {c["field"] for c in changes}
    return {"errors": {k: v for k, v in errors.items() if k in changed}, "changes": changes, "values": values}


# ---------- why a version exists ----------

def change_kind(r, version: int):
    """'internal' (before the client saw it) | 'client' | None."""
    h = r.history
    if version <= 1:
        return None
    i = next((n for n, e in enumerate(h) if e.version == version), -1)
    if i <= 0:
        return None
    prev = h[i - 1]
    if prev.status == "ready_for_bd":
        return "internal"
    if prev.status == "revision_requested":
        return "internal" if i >= 2 and h[i - 2].status == "ready_for_bd" else "client"
    return "client"
