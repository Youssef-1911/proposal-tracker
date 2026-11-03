"""
Events: a proposal request that is Won. Port of frontend events.js (eventTiming); the contract
file checks both give the same answers.
"""

import re

ACCEPTED = "accepted"

DONE, UPCOMING, UNDATED, CANCELLED, POSTPONED = "done", "upcoming", "undated", "cancelled", "postponed"
# The event's own status (separate from the proposal's): initial · confirmed · postponed · cancelled.
INITIAL, CONFIRMED = "initial", "confirmed"


def event_status_of(request: dict) -> str | None:
    """None for anything not accepted; events confirmed before event statuses existed count as Confirmed."""
    if request.get("status") != ACCEPTED:
        return None
    if request.get("eventStatus"):
        return request["eventStatus"]
    return CANCELLED if request.get("eventCancelledAt") else CONFIRMED
_COMPLETED = "event completed"  # the 2026 tracker's own status for events that took place
_MONTH = re.compile(r"\d{4}-\d{2}")


def event_timing(request: dict, today: str) -> str | None:
    """Done · Upcoming · Undated, or None when the request is not Won. today = "YYYY-MM-DD" (Cairo)."""
    if request.get("status") != ACCEPTED:
        return None
    status = event_status_of(request)
    if status == CANCELLED:
        return CANCELLED  # never Done: "Cancelled after confirmation"
    if status == POSTPONED:
        return POSTPONED
    if request.get("imported") and (request.get("originalStatus") or "").strip().lower() == _COMPLETED:
        return DONE
    last = request.get("eventEndDate") or request.get("eventDate")
    if not last or request.get("eventDatePrecision") == "unset":
        return UNDATED
    if _MONTH.fullmatch(last):
        return DONE if last < today[:7] else UPCOMING
    return DONE if last < today else UPCOMING


# ---------- who sees a confirmed event, its price, and who manages it ----------

PRICE_ROLES = ("business_development", "account_manager", "commercial_head", "executive")


def can_see_event(r, viewer, users: dict) -> bool:
    """Whoever may see the request, plus Marketing and Operations (both brands). Never an unconfirmed proposal."""
    from .access import can_see_request, sees_proposal_data
    if r.status != ACCEPTED:
        return False
    if sees_proposal_data(viewer.active_role):
        return can_see_request(r, viewer, users)
    if viewer.active_role == "hr":  # staffing: initially confirmed or confirmed (done ones for ratings), nothing else
        return view_event_status(r) in (INITIAL, CONFIRMED)
    return viewer.active_role in ("marketing", "operations")


def can_see_event_price(viewer) -> bool:
    return viewer.active_role in PRICE_ROLES


def can_manage_event(r, viewer, users: dict) -> dict:
    from .access import acts_as_business_development
    if r.status != ACCEPTED:
        return {"allowed": False, "reason": "Only confirmed events can be changed here."}
    if view_event_status(r) == CANCELLED:
        return {"allowed": False, "reason": "This event was cancelled."}
    if viewer.active_role == "commercial_head":
        return {"allowed": True, "reason": None}
    if viewer.user_id == r.bd_owner and acts_as_business_development(viewer, users.get(viewer.user_id)):
        return {"allowed": True, "reason": None}
    return {"allowed": False, "reason": "Only the BD owner or the Commercial Head can change a confirmed event."}


def _real_day(v) -> bool:
    from .request_form import is_real_date
    return isinstance(v, str) and is_real_date(v)


def validate_event_date_change(r, data: dict) -> dict:
    end = data.get("eventEndDate")
    note = data.get("note")
    values = {"eventDate": data.get("eventDate"), "eventEndDate": None if end in ("", None) else end,
              "note": note.strip()[:300] if isinstance(note, str) and note.strip() else None}
    errors = {}
    if not _real_day(values["eventDate"]):
        errors["eventDate"] = "Enter the event date."
    if values["eventEndDate"] is not None:
        if not _real_day(values["eventEndDate"]):
            errors["eventEndDate"] = "Enter a valid end date."
        elif "eventDate" not in errors and values["eventEndDate"] < values["eventDate"]:
            errors["eventEndDate"] = "The end date cannot be before the start date."
    if not errors and values["eventDate"] == r.event_date and values["eventEndDate"] == r.event_end_date:
        errors["eventDate"] = "Choose a different date."
    return {"errors": errors, "values": values}


def validate_event_cancel(data: dict, lists) -> dict:
    from .lists import OTHER, check_codes
    note = data.get("note")
    values = {"reason": data.get("reason"), "note": note.strip() if isinstance(note, str) and note.strip() else None}
    errors = {}
    if not values["reason"]:
        errors["reason"] = "Choose why it was cancelled."
    elif check_codes(lists, "eventCancelReasons", [values["reason"]], multi=False):
        errors["reason"] = "Choose from the list."
    elif values["reason"] == OTHER and not values["note"]:
        errors["note"] = 'Add a note when choosing "Other".'
    if values["note"] and len(values["note"]) > 300:
        errors["note"] = "Use at most 300 characters."
    return {"errors": errors, "values": values}



def view_event_status(r) -> str | None:
    """event_status_of for a RequestView."""
    return event_status_of({"status": r.status, "eventStatus": r.event_status, "eventCancelledAt": r.event_cancelled_at})


def event_actions(r, viewer, users: dict) -> list[str]:
    if not can_manage_event(r, viewer, users)["allowed"]:
        return []
    status = view_event_status(r)
    return ((["confirm"] if status in (INITIAL, POSTPONED) else []) + (["postpone"] if status in (INITIAL, CONFIRMED) else [])
            + ["changeDate", "cancel"])


def validate_event_postpone(data: dict, lists) -> dict:
    from .lists import OTHER, check_codes
    note = data.get("note")
    values = {"reason": data.get("reason"), "note": note.strip() if isinstance(note, str) and note.strip() else None}
    errors = {}
    if not values["reason"]:
        errors["reason"] = "Choose why it was postponed."
    elif check_codes(lists, "postponeWhy", [values["reason"]], multi=False):
        errors["reason"] = "Choose from the list."
    elif values["reason"] == OTHER and not values["note"]:
        errors["note"] = 'Add a note when choosing "Other".'
    if values["note"] and len(values["note"]) > 300:
        errors["note"] = "Use at most 300 characters."
    return {"errors": errors, "values": values}


PIPELINE = ("in_progress", "awaiting_bd_info", "revision_requested", "ready_for_bd", "shared_with_client")
PIPELINE_FIELDS = ["id", "clientId", "clientName", "eventName", "eventDate", "eventEndDate", "eventDatePrecision",
                   "participants", "brand", "status"]


def can_see_pipeline_item(r, viewer, users: dict) -> bool:
    """Proposals being prepared or with the client: awareness only. Never drafts."""
    from .access import can_see_request, sees_proposal_data
    if r.status not in PIPELINE or r.needs_review:
        return False
    return viewer.active_role == "operations"  # the "Coming up (proposals)" tab: Operations only
