"""
Data fixes, outside the normal step-by-step workflow. Port of frontend corrections.js (same answers;
the contract file's correctionCases check both).

"Correct status (data fix)": jump straight to the right status (Noha always; the BD owner and the
assigned AM on their own requests). "Add past proposal or event": a record from before IEE, with its
history built from the dates entered.
"""

import math
from datetime import date, timedelta

from ..config_domain import BRANDS, COMMERCIAL_HEAD, ACCOUNT_MANAGER, LOST_REASONS
from .access import acts_as_business_development
from .request_form import is_real_date
from .workflow import confirm_event_errors

CORRECTED_NOTE = "Status corrected"
PAST_NOTE = "Added manually — before IEE"
NOTE_MAX = 300

CORRECTION_TARGETS = [
    {"id": "with_am", "label": "With AM", "status": "in_progress"},
    {"id": "waiting_bd", "label": "Waiting for BD", "status": "awaiting_bd_info"},
    {"id": "ready", "label": "Ready for BD", "status": "ready_for_bd"},
    {"id": "with_client", "label": "With client", "status": "shared_with_client"},
    {"id": "postponed", "label": "Postponed", "status": "postponed"},
    {"id": "initial", "label": "Initially confirmed", "status": "accepted", "eventStatus": "initial"},
    {"id": "confirmed", "label": "Confirmed", "status": "accepted", "eventStatus": "confirmed"},
    {"id": "lost", "label": "Lost", "status": "rejected"},
    {"id": "cancelled", "label": "Cancelled", "status": "cancelled"},
]
TARGETS = {t["id"]: t for t in CORRECTION_TARGETS}
LOST_IDS = [x["id"] for x in LOST_REASONS if not x.get("importOnly")]
SERVICES = {b["id"]: {s["id"] for s in b["services"]} for b in BRANDS}

OK = {"allowed": True, "reason": None}


def _deny(reason: str) -> dict:
    return {"allowed": False, "reason": reason}


def plain_status(status: str, event_status: str | None) -> str:
    if status in ("submitted", "in_progress", "revision_requested"):
        return "With AM"
    if status == "accepted":
        return "Initially confirmed" if event_status == "initial" else "Confirmed"
    if status == "closed_unrecorded":
        return "Closed · not recorded"
    if status == "closed_postponed":
        return "Closed · postponed"
    return next((t["label"] for t in CORRECTION_TARGETS if t["status"] == status), status)


def stage_for_status(status: str) -> str:
    if status == "accepted":
        return "won"
    if status == "rejected":
        return "lost"
    if status == "cancelled":
        return "closed_no_result"
    if status in ("shared_with_client", "postponed"):
        return "negotiation"
    return "proposal_requested"


def can_correct_status(r, viewer, users: dict) -> dict:
    if r.status == "draft":
        return _deny("A draft has no status to correct yet.")
    if viewer.active_role == COMMERCIAL_HEAD:
        return OK
    if viewer.user_id == r.bd_owner and acts_as_business_development(viewer, users.get(viewer.user_id)):
        return OK
    if viewer.user_id == r.assigned_am and viewer.active_role == ACCOUNT_MANAGER:
        return OK
    return _deny("Only the Commercial Head, the BD owner or the assigned Account Manager can correct the status.")


def _text(v):
    return v.strip() if isinstance(v, str) and v.strip() else None


def _blank(v) -> bool:
    return v is None or v == ""


def _day(v) -> bool:
    return isinstance(v, str) and is_real_date(v)


def _number(v):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return int(n) if math.isfinite(n) and n == int(n) else n


def validate_correction(data: dict, r) -> dict:
    """data = {target, followUpOn, eventDate, eventEndDate, finalPrice, finalParticipants, lostReason, note}."""
    errors = {}
    t = TARGETS.get(data.get("target")) if isinstance(data.get("target"), str) else None
    values = {"target": t["id"] if t else None, "status": t["status"] if t else None,
              "eventStatus": t.get("eventStatus") if t else None, "followUpOn": None, "eventDate": None,
              "eventEndDate": None, "finalPrice": None, "finalParticipants": None, "lostReason": None,
              "note": _text(data.get("note")), "from": plain_status(r.status, r.event_status),
              "to": t["label"] if t else None}
    if not t:
        errors["target"] = "Choose the right status."
        return {"errors": errors, "values": values}
    if t["label"] == values["from"]:
        errors["target"] = f"It is already {t['label']}."
    if t["id"] == "postponed":
        if not _day(data.get("followUpOn")):
            errors["followUpOn"] = "Enter the follow-up date."
        else:
            values["followUpOn"] = data["followUpOn"]
    if t["status"] == "accepted":
        errors.update(confirm_event_errors({"eventDate": data.get("eventDate"), "eventEndDate": data.get("eventEndDate"),
                                            "finalPrice": data.get("finalPrice"),
                                            "finalParticipants": data.get("finalParticipants")}))
        values["eventDate"] = data.get("eventDate")
        values["eventEndDate"] = None if _blank(data.get("eventEndDate")) else data.get("eventEndDate")
        values["finalPrice"] = None if _blank(data.get("finalPrice")) else _number(data.get("finalPrice"))
        values["finalParticipants"] = None if _blank(data.get("finalParticipants")) else _number(data.get("finalParticipants"))
    if t["id"] == "lost":
        if not data.get("lostReason"):
            errors["lostReason"] = "Choose why it was lost."
        elif data.get("lostReason") not in LOST_IDS:
            errors["lostReason"] = "Choose a reason from the list."
        else:
            values["lostReason"] = data["lostReason"]
    if values["note"] and len(values["note"]) > NOTE_MAX:
        errors["note"] = f"Use at most {NOTE_MAX} characters."
    return {"errors": errors, "values": values}


def correction_note(values: dict) -> str:
    note = f" — {values['note']}" if values["note"] else ""
    return f"{CORRECTED_NOTE} from {values['from']} to {values['to']}{note}"


# ---------- "Add past proposal or event" ----------

PAST_OUTCOMES = {"with_client": "shared_with_client", "postponed": "postponed", "confirmed": "accepted",
                 "done": "accepted", "lost": "rejected", "cancelled": "cancelled"}


def can_add_past_record(viewer, users: dict, client=None, brand: str | None = None) -> dict:
    me = users.get(viewer.user_id)
    if viewer.active_role == COMMERCIAL_HEAD:
        return OK
    if acts_as_business_development(viewer, me):
        return OK if client is None or client.owner == viewer.user_id else _deny(
            "You can add past records for your own clients only.")
    if viewer.active_role == ACCOUNT_MANAGER:
        return OK if not brand or not (me and me.brand) or me.brand == brand else _deny(
            "You can add past records for your brand only.")
    return _deny("Only the Commercial Head, Business Development or Account Managers can add past records.")


def validate_past_record(data: dict, today: str | None = None) -> dict:
    errors = {}
    v = {k: _text(data.get(k)) for k in ("brand", "service", "bdOwner", "assignedAM", "eventName", "briefDate", "sentDate",
                                          "eventDate", "eventEndDate", "outcome")}
    v.update({"participants": None, "amPrice": None, "finalPrice": None, "lostReason": None,
              "followUpOn": _text(data.get("followUpOn")), "notes": _text(data.get("notes"))})
    if v["brand"] not in SERVICES:
        errors["brand"] = "Choose the brand."
    elif v["service"] not in SERVICES[v["brand"]]:
        errors["service"] = "Choose a service of this brand."
    if not v["bdOwner"]:
        errors["bdOwner"] = "Choose the BD owner."
    if not v["assignedAM"]:
        errors["assignedAM"] = "Choose the Account Manager."
    if v["eventName"] and len(v["eventName"]) > 120:
        errors["eventName"] = "Use at most 120 characters."

    def day(key, label):
        if v[key] and not _day(v[key]):
            errors[key] = f"Enter a valid {label}."

    if not v["briefDate"]:
        errors["briefDate"] = "Enter the brief date."
    else:
        day("briefDate", "brief date")
    day("sentDate", "date")
    day("eventDate", "event date")
    day("eventEndDate", "end date")
    day("followUpOn", "follow-up date")
    if "briefDate" not in errors and today and v["briefDate"] > today:
        errors["briefDate"] = "A past record cannot start in the future."
    if v["sentDate"] and "sentDate" not in errors and "briefDate" not in errors:
        if v["sentDate"] < v["briefDate"]:
            errors["sentDate"] = "The proposal cannot be sent before the brief."
        elif today and v["sentDate"] > today:
            errors["sentDate"] = "The sent date cannot be in the future."
    if (v["eventEndDate"] and v["eventDate"] and "eventDate" not in errors and "eventEndDate" not in errors
            and v["eventEndDate"] < v["eventDate"]):
        errors["eventEndDate"] = "The end date cannot be before the start date."
    if v["outcome"] not in PAST_OUTCOMES:
        errors["outcome"] = "Choose what happened."
    if v["outcome"] in ("confirmed", "done") and not v["eventDate"]:
        errors["eventDate"] = "Enter the event date."
    if (v["outcome"] == "done" and v["eventDate"] and "eventDate" not in errors and today
            and (v["eventEndDate"] or v["eventDate"]) > today):
        errors["eventDate"] = 'A done event has a date in the past (choose "Confirmed" for one still to come).'
    if v["outcome"] == "lost":
        if not data.get("lostReason"):
            errors["lostReason"] = "Choose why it was lost."
        elif data.get("lostReason") not in LOST_IDS:
            errors["lostReason"] = "Choose a reason from the list."
        else:
            v["lostReason"] = data["lostReason"]

    def whole(key, minimum, message):
        raw = data.get(key)
        if raw is None or raw == "":
            return
        n = _number(raw)
        if n is None or isinstance(n, float) or isinstance(raw, bool) or n < minimum:
            errors[key] = message
        else:
            v[key] = n

    whole("participants", 1, "Enter a whole number of participants greater than 0.")
    whole("amPrice", 1, "Enter the proposal price as a whole number of EGP.")
    whole("finalPrice", 0, "Enter the final price as a whole number of EGP.")
    if v["notes"] and len(v["notes"]) > 1000:
        errors["notes"] = "Use at most 1000 characters."
    return {"errors": errors, "values": v}


def past_history(v: dict, today: str) -> list[dict]:
    """The history steps of a past record (see frontend pastHistory)."""
    status = PAST_OUTCOMES[v["outcome"]]
    at = v["sentDate"] or v["briefDate"]
    steps = [{"status": "submitted", "day": v["briefDate"]}]
    if v["sentDate"]:
        steps.append({"status": "ready_for_bd", "day": v["sentDate"], "amPrice": v["amPrice"]})
        steps.append({"status": "shared_with_client", "day": v["sentDate"]})
    elif status not in ("cancelled", "rejected"):
        steps.append({"status": "shared_with_client", "day": v["briefDate"]})
    if status == "postponed":
        follow = v["followUpOn"] or (date.fromisoformat(today) + timedelta(days=7)).isoformat()
        steps.append({"status": "postponed", "day": at, "followUpOn": follow})
    if status == "accepted":
        steps.append({"status": "accepted", "day": at})
    if status == "rejected":
        steps.append({"status": "rejected", "day": at, "lostReason": v["lostReason"]})
    if status == "cancelled":
        steps.append({"status": "cancelled", "day": at})
    return steps
