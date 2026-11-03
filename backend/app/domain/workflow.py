"""
The proposal-request lifecycle (port of frontend workflow.js): the TRANSITIONS table,
get_actions(), and apply_action(), which validates one action and returns its outcome
(new status, history entry, opportunity change, warnings) without touching a database.
services/proposal_requests.py writes that outcome in one transaction.

Messages, failure codes and outcomes are identical to the frontend's; the contract
scenarios (actionCases) compare them.
"""

import math
from datetime import datetime

from ..clock import cairo_today_iso, iso_z
from ..config_domain import (
    LOST, LOST_REASON_FORM_IDS, LOST_REASON_OTHER, OPPORTUNITY_STAGES, PROPOSAL_STATUSES, SHARE_CHANNEL_IDS,
)
from .permissions import ASSIGNED_AM, BD_OWNER, CREATOR, HEAD, check_actors
from .request_form import is_real_date, js_number, request_fields, validate_request_fields
from .access import can_see_request
from .rules import has_proposal_file, is_open_request, open_status_ids, stage_of, sub_label
from .lists import DEFAULT_LISTS, LIST_DEFS, OTHER as LIST_OTHER, check_codes
from .views import RequestView

# Opportunity effects carry the approved history reason codes.
LIST_MULTI = {d["id"]: d["multi"] for d in LIST_DEFS}

TRANSITIONS = [
    {"action": "submit", "label": "Submit to Account Manager", "from": ["draft"], "to": "submitted",
     "actors": [CREATOR], "requires": {}, "completeRequest": True,
     "opportunity": {"advanceTo": "proposal_requested", "reasonCode": "proposal_requested"}},
    {"action": "start_work", "label": "Start work on proposal", "from": ["submitted"], "to": "in_progress",
     "actors": [ASSIGNED_AM], "requires": {}},
    {"action": "request_bd_info", "label": "Ask BD for information", "from": ["in_progress"], "to": "awaiting_bd_info",
     # What's missing: chosen from the list, or written in the note (one of the two).
     "actors": [ASSIGNED_AM], "requires": {"reasons": "whatsMissing"}, "notePrompt": "What information is missing?"},
    {"action": "provide_bd_info", "label": "Send information to AM", "from": ["awaiting_bd_info"], "to": "submitted",
     "actors": [BD_OWNER], "requires": {"note": True}, "notePrompt": "Your answer for the Account Manager"},
    {"action": "mark_ready", "label": "Mark Ready for BD", "from": ["in_progress"], "to": "ready_for_bd",
     # A proposal file must already be uploaded for the current version (else 409); from version 2 a
     # "what changed" note is required too.
     "actors": [ASSIGNED_AM], "requires": {"amPrice": True}, "requiresFile": True, "changeNoteFromVersion": 2},
    {"action": "share_with_client", "label": "Record: shared with client", "from": ["ready_for_bd"],
     "to": "shared_with_client", "actors": [BD_OWNER], "requires": {"confirmShared": True, "channel": True},
     "opportunity": {"advanceTo": "negotiation", "reasonCode": "proposal_shared"}},
    {"action": "request_revision", "label": "Record: client wants a revision", "from": ["shared_with_client"],
     "to": "revision_requested", "actors": [BD_OWNER], "requires": {"reasons": "whatShouldChange", "newRequiredBy": True},
     "notePrompt": "What does the client want changed?"},
    # Before the client sees it: back to the AM as an "Internal change" (the next version starts with start_revision).
    {"action": "request_changes", "label": "Request changes", "from": ["ready_for_bd"], "to": "revision_requested",
     "actors": [BD_OWNER], "requires": {"reasons": "whatShouldChange"}, "notePrompt": "What should change?"},
    # The AM reopens a ready proposal before it is shared: a new version, an "Internal change".
    {"action": "take_back", "label": "Take back to edit", "from": ["ready_for_bd"], "to": "in_progress",
     "actors": [ASSIGNED_AM], "requires": {}, "newVersion": True, "notePrompt": "Note (optional)"},
    {"action": "start_revision", "label": "Start revised version", "from": ["revision_requested"], "to": "in_progress",
     "actors": [ASSIGNED_AM], "requires": {}, "newVersion": True},
    {"action": "postpone", "label": "Record: client postponed", "from": ["shared_with_client"], "to": "postponed",
     "actors": [BD_OWNER], "requires": {"followUpOn": True, "reasons": "postponeWhy"}, "notePrompt": "Note (optional)"},
    {"action": "resume", "label": "Record: back to awaiting reply", "from": ["postponed"], "to": "shared_with_client",
     "actors": [BD_OWNER], "requires": {}},
    {"action": "record_accepted", "label": "Mark confirmed", "from": ["shared_with_client", "postponed"], "to": "accepted",
     # Other open requests on the same opportunity are NOT changed; the outcome warns about them.
     "actors": [BD_OWNER], "requires": {"confirmEvent": True}, "confirm": True, "warnOtherOpenRequests": True,
     "opportunity": {"setTo": "won", "reasonCode": "proposal_accepted",
                     "reopenReasonCode": "reopened_after_acceptance"}},
    # History without a result ("Closed · outcome not recorded"): set it once it is known.
    {"action": "set_outcome_confirmed", "label": "Set outcome: Confirmed", "from": ["closed_unrecorded"], "to": "accepted",
     "actors": [BD_OWNER, HEAD], "requires": {"confirmEvent": True}, "confirm": True,
     "opportunity": {"setTo": "won", "reasonCode": "proposal_accepted", "reopenReasonCode": "reopened_after_acceptance"}},
    {"action": "set_outcome_lost", "label": "Set outcome: Lost", "from": ["closed_unrecorded"], "to": "rejected",
     "actors": [BD_OWNER, HEAD], "requires": {"lostReason": True}, "notePrompt": 'Details (required for "Other")',
     "confirm": True,
     "opportunity": {"setTo": "lost", "keepIfWon": True, "unlessOtherOpenRequests": True,
                     "reasonCode": "proposal_rejected"}},
    {"action": "record_rejected", "label": "Mark lost", "from": ["shared_with_client", "postponed"], "to": "rejected",
     # A lost reason from LOST_REASONS is required; the note is optional except for "other".
     # A Won opportunity stays Won (the lost reason is kept on the request's history only).
     "actors": [BD_OWNER], "requires": {"lostReason": True}, "notePrompt": 'Details (required for "Other")',
     "confirm": True,
     "opportunity": {"setTo": "lost", "keepIfWon": True, "unlessOtherOpenRequests": True,
                     "reasonCode": "proposal_rejected"}},
    {"action": "cancel", "label": "Cancel request", "from": open_status_ids(), "to": "cancelled",
     "actors": [BD_OWNER, HEAD], "requires": {"note": True}, "notePrompt": "Reason for cancelling",
     "confirm": True, "tone": "danger"},
]

# Fields of each action exposed to clients (same names as the frontend's getActions()).
ACTION_FIELDS = ("action", "label", "from", "to", "actors", "requires", "notePrompt", "confirm", "tone",
                 "completeRequest", "newVersion")


def get_actions(r: RequestView, viewer, users: dict) -> list[dict]:
    """Actions for the request's CURRENT status, each with allowed/reason. Nothing if not viewable."""
    if not can_see_request(r, viewer, users):
        return []
    out = []
    for t in TRANSITIONS:
        if r.status in t["from"]:
            item = {k: t[k] for k in ACTION_FIELDS if k in t}
            if change_note_required(t, r):
                item["requires"] = {**t["requires"], "note": True}
                item["notePrompt"] = CHANGE_NOTE_PROMPT
            permission = check_actors(t["actors"], r, viewer, users)
            blocked = precondition_failure(t, r) if permission["allowed"] else None
            item.update(allowed=permission["allowed"] and not blocked, reason=blocked or permission["reason"])
            out.append(item)
    return out


CHANGE_NOTE_PROMPT = "What changed in this version?"
CHANGE_NOTE_ERROR = 'Describe what changed in this version, e.g. "Removed transport, price down EGP 40,000".'


def change_note_required(t: dict, r: RequestView) -> bool:
    """Mark ready on version 2+ needs a short "what changed" note."""
    return bool(t.get("changeNoteFromVersion")) and r.version >= t["changeNoteFromVersion"]


def precondition_failure(t: dict, r: RequestView) -> str | None:
    """Why an otherwise permitted action cannot happen yet (409), or None."""
    # Imported requests are exempt: the 2026 sheet never had files or prices.
    if t.get("requiresFile") and not r.imported and not has_proposal_file(r, r.version):
        return "Upload the proposal file before marking it ready."
    return None


def can_edit_draft(r: RequestView, viewer, users: dict) -> bool:
    return r.status == "draft" and check_actors([CREATOR], r, viewer, users)["allowed"]


def get_transition(action: str) -> dict | None:
    return next((t for t in TRANSITIONS if t["action"] == action), None)


# ---------------------------------------------------------------------------
# Failure codes (the API maps them to HTTP statuses)
# ---------------------------------------------------------------------------

NOT_FOUND = "not_found"                    # 404
UNKNOWN_ACTION = "unknown_action"          # 422
INVALID_TRANSITION = "invalid_transition"  # 409
FORBIDDEN = "forbidden"                    # 403
PRECONDITION = "precondition"              # 409 (e.g. no proposal file yet)
VALIDATION = "validation"                  # 422


def failure(code: str, error: str, errors: dict | None = None) -> dict:
    return {"ok": False, "code": code, "error": error, "errors": errors or {}}


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

def validate_input(t: dict, data: dict, today: str, r: RequestView, lists=None) -> tuple[dict, str | None]:
    errors: dict[str, str] = {}
    raw_note = data.get("note")
    note = raw_note.strip() if isinstance(raw_note, str) else ""
    req = t["requires"]
    if req.get("note") and not note:
        errors["note"] = f"{t.get('notePrompt') or 'A note'} is required."
    if change_note_required(t, r) and not note:
        errors["note"] = CHANGE_NOTE_ERROR
    raw = data.get("amPrice")
    no_price = raw == "" or raw is None
    if req.get("amPrice") and not (r.imported and no_price):  # imported requests may stay without a price
        price = js_number(raw)
        if no_price or not math.isfinite(price):
            errors["amPrice"] = "Enter the AM price in EGP."
        elif price != int(price) or price <= 0:
            errors["amPrice"] = "The AM price must be a whole number of EGP greater than 0."
    if req.get("newRequiredBy"):
        d = data.get("newRequiredBy")
        if not is_real_date(d):
            errors["newRequiredBy"] = "Choose the new proposal deadline."
        elif d < today:
            errors["newRequiredBy"] = "The new deadline cannot be in the past."
    if req.get("confirmShared") and data.get("confirmShared") is not True:
        errors["confirmShared"] = "Confirm that the proposal has actually been sent to the client."
    if req.get("channel") and data.get("channel") not in SHARE_CHANNEL_IDS:
        errors["channel"] = "Choose how the proposal was sent to the client."
    if req.get("followUpOn"):
        d = data.get("followUpOn")
        if not is_real_date(d):
            errors["followUpOn"] = "Choose when to follow up with the client."
        elif d < today:
            errors["followUpOn"] = "The follow-up date cannot be in the past."
    if req.get("lostReason"):
        if data.get("lostReason") not in LOST_REASON_FORM_IDS:
            errors["lostReason"] = "Choose why the proposal was lost."
        elif data.get("lostReason") == LOST_REASON_OTHER and not note:
            errors["note"] = 'Describe the reason when choosing "Other".'
    if req.get("confirmEvent"):
        errors.update(confirm_event_errors(data))
    list_id = req.get("reasons")
    if list_id:
        codes = data.get("reasons")
        codes = [] if codes is None else codes
        multi = LIST_MULTI[list_id]
        problem = check_codes(lists or DEFAULT_LISTS, list_id, codes, multi=multi) if codes != [] else None
        if problem:
            errors["reasons"] = problem
        elif multi and not codes and not note:  # a multi list or the note: one of the two
            errors["note"] = f"{t.get('notePrompt') or 'A note'} is required."
        elif LIST_OTHER in codes and not note:
            errors["note"] = 'Describe "Other" in the note.'
    return errors, note or None


# ---------------------------------------------------------------------------
# Opportunity effects
# ---------------------------------------------------------------------------

STAGE = {s["id"]: s for s in OPPORTUNITY_STAGES}
STATUS_LABEL = {s["id"]: s["label"] for s in PROPOSAL_STATUSES}


def other_open_requests(r: RequestView, opportunity_id: str, all_requests) -> list:
    return [x for x in all_requests if x.opportunity_id == opportunity_id and x.id != r.id and is_open_request(x)]


def opportunity_effect(t: dict, r: RequestView, opp, all_requests) -> dict | None:
    """{stage, reasonCode, message}, or None for no change (stage None = deliberately unchanged)."""
    rule = t.get("opportunity")
    if not rule or opp is None:
        return None
    current = opp.stage
    closed = STAGE[current]["closed"]

    def label(stage):
        return STAGE[stage]["label"]

    if rule.get("advanceTo"):
        if closed or STAGE[current]["order"] >= STAGE[rule["advanceTo"]]["order"]:
            return None
        return {"stage": rule["advanceTo"], "reasonCode": rule["reasonCode"],
                "message": f"Opportunity {opp.id} moved to {label(rule['advanceTo'])}."}
    if rule.get("keepIfWon") and current == "won":
        return {"stage": None, "reasonCode": None, "message": f"Opportunity {opp.id} stays Won."}
    if rule.get("unlessOtherOpenRequests"):
        others = other_open_requests(r, opp.id, all_requests)
        if others:
            ids = ", ".join(x.id for x in others)
            return {"stage": None, "reasonCode": None,
                    "message": f"Opportunity {opp.id} stays {label(current)}: {ids} is still open."}
    if rule.get("setTo"):
        if current == rule["setTo"]:
            return None
        return {"stage": rule["setTo"], "reasonCode": (closed and rule.get("reopenReasonCode")) or rule["reasonCode"],
                "message": f"Opportunity {opp.id} marked {label(rule['setTo'])}."}
    return None


def other_open_warning(opp, others: list) -> dict:
    one = len(others) == 1
    ids = ", ".join(x.id for x in others)
    return {
        "code": "other_open_requests",
        "message": (f"Opportunity {opp.id} is Won, but {ids} {'is' if one else 'are'} still open. "
                    f"Nothing was changed on {'it' if one else 'them'}; cancel {'it' if one else 'them'} "
                    "if no longer needed."),
        "requests": [{"id": x.id, "status": x.status, "bdOwner": x.bd_owner} for x in others],
    }


# ---------------------------------------------------------------------------
# Apply (pure)
# ---------------------------------------------------------------------------

def apply_action(r: RequestView, action: str, data: dict, *, viewer, users: dict, opportunities: dict,
                 all_requests, clients: dict, now: datetime, lists=None) -> dict:
    """
    Validates one action and returns its outcome; never writes anything.

    -> {"ok": True, status, stage, subLabel, version, amPrice, requiredBy, submittedBy, submittedAt,
        lastUpdated, historyLength, entry, opportunityChange, warnings, message}
       (exactly the contract's actionOutcome fields)
    -> {"ok": False, code, error, errors}
    """
    if not can_see_request(r, viewer, users):  # someone else's draft (or a brand not seen) == does not exist
        return failure(NOT_FOUND, f"Request {r.id} not found.")
    t = get_transition(action)
    if t is None:
        return failure(UNKNOWN_ACTION, f'Unknown action "{action}".', {"action": "Unknown action."})
    if r.status not in t["from"]:
        return failure(INVALID_TRANSITION,
                       f'"{t["label"]}" is not possible while the request is {STATUS_LABEL[r.status]}.')
    permission = check_actors(t["actors"], r, viewer, users)
    if not permission["allowed"]:
        return failure(FORBIDDEN, permission["reason"])
    blocked = precondition_failure(t, r)
    if blocked:
        return failure(PRECONDITION, blocked)

    today = cairo_today_iso(now)
    errors, note = validate_input(t, data, today, r, lists)
    if errors:
        return failure(VALIDATION, "Please fix the highlighted fields.", errors)
    if t.get("completeRequest"):
        check, _ = validate_request_fields(request_fields(r), mode="submit", today=today, clients=clients,
                                           opportunities=opportunities, lists=lists)
        if check:
            return failure(VALIDATION, "Complete the request before submitting it.", check)

    changed_at = iso_z(now)
    version = r.version + 1 if t.get("newVersion") else r.version
    entry = {"status": t["to"], "changedBy": viewer.user_id, "role": viewer.active_role, "changedAt": changed_at,
             "note": note, "version": version}
    am_price, required_by = r.am_price, r.required_by
    submitted_by, submitted_at = r.submitted_by, iso_z(r.submitted_at)
    if action == "submit":
        if viewer.user_id != r.bd_owner:
            entry["onBehalfOf"] = r.bd_owner
        submitted_at = submitted_at or changed_at
        submitted_by = submitted_by or viewer.user_id
    if action == "mark_ready":
        raw = data.get("amPrice")
        am_price = None if raw == "" or raw is None else int(js_number(raw))  # None only for imported requests
        entry["amPrice"] = am_price
    if action == "postpone":
        entry["followUpOn"] = data.get("followUpOn")
    if action in ("start_revision", "take_back"):
        am_price = None  # the previous version's price stays in history
    if action == "request_revision":
        entry["previousRequiredBy"] = r.required_by
        entry["requiredBy"] = data.get("newRequiredBy")
        required_by = data.get("newRequiredBy")
    if t["requires"].get("lostReason"):
        entry["lostReason"] = data.get("lostReason")
    if t["requires"].get("channel"):
        entry["channel"] = data.get("channel")
    if t["requires"].get("reasons") and data.get("reasons"):
        entry["reasons"] = list(data["reasons"])

    opp = opportunities.get(r.opportunity_id) if r.opportunity_id else None
    effect = opportunity_effect(t, r, opp, all_requests)
    change = None
    if effect and effect["stage"]:
        change = {"id": opp.id, "from": opp.stage, "to": effect["stage"], "reasonCode": effect["reasonCode"],
                  "lostReason": data.get("lostReason") if effect["stage"] == LOST else None}

    warnings = []
    if t.get("warnOtherOpenRequests") and opp is not None:
        others = other_open_requests(r, opp.id, all_requests)
        if others:
            warnings.append(other_open_warning(opp, others))

    message = f"{r.id} is now {STATUS_LABEL[t['to']]}."
    if effect:
        message = f"{message} {effect['message']}"
    return {
        "ok": True, "status": t["to"], "stage": stage_of(t["to"]), "subLabel": sub_label(t["to"], version),
        "version": version, "amPrice": am_price, "requiredBy": required_by, "submittedBy": submitted_by,
        "submittedAt": submitted_at, "lastUpdated": changed_at, "historyLength": len(r.history) + 1,
        "entry": entry, "opportunityChange": change, "warnings": warnings, "message": message,
        # "Mark confirmed": kept on the request, not in its history entry.
        "confirmed": confirmed_fields(data) if t["requires"].get("confirmEvent") else None,
    }


# ---------- "Mark confirmed" ----------

def _blank(v) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def _whole(v):
    n = js_number(v)
    return int(n) if math.isfinite(n) and n == int(n) else None


def confirm_event_errors(data: dict) -> dict:
    """The checks on the event details (same messages as the frontend's confirmEventErrors)."""
    errors = {}
    start = data.get("eventDate")
    end = None if _blank(data.get("eventEndDate")) else data.get("eventEndDate")
    if not isinstance(start, str) or not is_real_date(start):
        errors["eventDate"] = "Enter the event date."
    if end is not None:
        if not isinstance(end, str) or not is_real_date(end):
            errors["eventEndDate"] = "Enter a valid end date."
        elif "eventDate" not in errors and end < start:
            errors["eventEndDate"] = "The end date cannot be before the start date."
    if not _blank(data.get("finalParticipants")):
        n = _whole(data.get("finalParticipants"))
        if n is None or n <= 0:
            errors["finalParticipants"] = "Enter a whole number of participants greater than 0."
    if not _blank(data.get("finalPrice")):
        n = _whole(data.get("finalPrice"))
        if n is None or n < 0:
            errors["finalPrice"] = "Enter the final price as a whole number of EGP."
    if isinstance(data.get("venue"), str) and len(data["venue"].strip()) > 200:
        errors["venue"] = "Use at most 200 characters."
    if isinstance(data.get("teamNotes"), str) and len(data["teamNotes"].strip()) > 1000:
        errors["teamNotes"] = "Use at most 1000 characters."
    if not _blank(data.get("eventStatus")) and data.get("eventStatus") not in ("initial", "confirmed"):
        errors["eventStatus"] = "Choose initially confirmed or confirmed."
    return errors


def confirmed_fields(data: dict) -> dict:
    def trimmed(v, n):
        return v.strip()[:n] if isinstance(v, str) and v.strip() else None
    return {
        "eventDate": data.get("eventDate"),
        "eventEndDate": None if _blank(data.get("eventEndDate")) else data.get("eventEndDate"),
        "confirmedParticipants": None if _blank(data.get("finalParticipants")) else _whole(data.get("finalParticipants")),
        "finalPrice": None if _blank(data.get("finalPrice")) else _whole(data.get("finalPrice")),
        "venue": trimmed(data.get("venue"), 200), "teamNotes": trimmed(data.get("teamNotes"), 1000),
        "eventStatus": "initial" if data.get("eventStatus") == "initial" else "confirmed",
    }
