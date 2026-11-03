"""
Request fields: create, edit, and completeness for submission.
Port of the "Request fields" part of frontend workflow.js (validateRequestFields,
normalizeRequestFields, checkCreator, findPossibleDuplicates) and clientsForCreator from
permissions.js. Messages are identical to the frontend's.

Pure functions over plain views: no database, no FastAPI.
"""

import math
import re
from datetime import date

from ..config_domain import BRANDS, BUSINESS_DEVELOPMENT, COMMERCIAL_HEAD, OPPORTUNITY_STAGES
from .access import acts_as_business_development
from .permissions import can_open_request_form
from .lists import DEFAULT_LISTS, check_codes
from .rules import is_open_request

DAY, MONTH, UNSET = "day", "month", "unset"  # UNSET: "Date not set yet"
EVENT_NAME_MAX = 80
FIELD_LABELS = {
    "clientId": "Client", "brand": "Brand", "service": "Service", "eventDate": "Event date",
    "requiredBy": "Proposal deadline", "participants": "Expected participants", "requirementsSummary": "Event brief",
}
ALWAYS_REQUIRED = ["clientId", "brand", "service"]
SUBMIT_REQUIRED = [*ALWAYS_REQUIRED, "eventDate", "requiredBy", "participants", "requirementsSummary"]
FIELDS = ["clientId", "brand", "service", "opportunityId", "eventName", "eventDatePrecision", "eventDate", "requiredBy",
          "participants", "requirementsSummary", "specificRequirements"]

BRANDS_BY_ID = {b["id"]: b for b in BRANDS}
CLOSED_OPPORTUNITY_STAGES = {s["id"] for s in OPPORTUNITY_STAGES if s["closed"]}

_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_MONTH = re.compile(r"\d{4}-\d{2}")
_JS_NUMBER = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")


def js_number(value) -> float:
    """JavaScript Number(value) for the inputs a form or JSON can send (NaN when not a number)."""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return 0.0
        if text in ("Infinity", "+Infinity"):
            return math.inf
        if text == "-Infinity":
            return -math.inf
        return float(text) if _JS_NUMBER.fullmatch(text) else math.nan
    return math.nan


def is_whole(number: float) -> bool:
    return math.isfinite(number) and number == int(number)


def is_real_date(value) -> bool:
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def is_real_month(value) -> bool:
    return isinstance(value, str) and bool(_MONTH.fullmatch(value)) and 1 <= int(value[5:]) <= 12


def _blank(value) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def _text(value):
    if _blank(value):
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip()


def normalize_request_fields(data: dict) -> dict:
    """Trims strings, turns blanks into None, participants into a number (frontend shape)."""
    participants = None if _blank(data.get("participants")) else js_number(data.get("participants"))
    if participants is not None and is_whole(participants):
        participants = int(participants)
    precision = data.get("eventDatePrecision") if data.get("eventDatePrecision") in (MONTH, UNSET) else DAY
    return {
        "clientId": _text(data.get("clientId")),
        "brand": _text(data.get("brand")),
        "service": _text(data.get("service")),
        "opportunityId": _text(data.get("opportunityId")),
        "eventName": _text(data.get("eventName")),  # optional, e.g. "Ramadan Iftar Riders – Alex"
        "eventDatePrecision": precision,
        # "Not set yet" has no date; an end date exists only for an exact start date.
        "eventDate": None if precision == UNSET else _text(data.get("eventDate")),
        "eventEndDate": _text(data.get("eventEndDate")) if precision == DAY else None,
        "requiredBy": _text(data.get("requiredBy")),
        "participants": participants,
        "requirementsSummary": _text(data.get("requirementsSummary")),
        "specificRequirements": _text(data.get("specificRequirements")),
        # Optional quick tags (codes from the "briefTags" list); the brief itself stays free text.
        "briefTags": [] if data.get("briefTags") is None else data.get("briefTags"),
    }


def event_start_date(event_date: str | None, precision: str) -> str | None:
    if not event_date:
        return None
    return f"{event_date}-01" if precision == MONTH else event_date


def validate_request_fields(data: dict, *, mode: str = "draft", today: str, clients: dict | None = None,
                            opportunities: dict | None = None, lists=None) -> tuple[dict, dict]:
    """THE validation for request fields -> (errors, values). clients/opportunities: {id: view}."""
    v = normalize_request_fields(data)
    errors: dict[str, str] = {}
    for f in (SUBMIT_REQUIRED if mode == "submit" else ALWAYS_REQUIRED):
        if f == "eventDate" and v["eventDatePrecision"] == UNSET:
            continue  # "Not set yet" is an answer
        if _blank(v[f]):
            errors[f] = ('Enter the event date, or choose "Not set yet".' if f == "eventDate"
                         else f"{FIELD_LABELS[f]} is required.")

    if v["clientId"] and clients is not None and v["clientId"] not in clients:
        errors["clientId"] = "Choose a client from the list."
    brand = BRANDS_BY_ID.get(v["brand"]) if v["brand"] else None
    if v["brand"] and brand is None:
        errors["brand"] = "Choose Grasshoppers or Team Up."
    if v["service"] and brand and not any(s["id"] == v["service"] for s in brand["services"]):
        errors["service"] = f"Choose a {brand['name']} service."

    if v["opportunityId"] and opportunities is not None:
        opp = opportunities.get(v["opportunityId"])
        if (opp is None or opp.client_id != v["clientId"] or opp.brand != v["brand"]
                or opp.stage in CLOSED_OPPORTUNITY_STAGES):
            errors["opportunityId"] = "Choose an open opportunity for this client and brand, or none."

    # Event date: exact day or month + year, not in the past.
    if v["eventDate"]:
        if v["eventDatePrecision"] == MONTH:
            if not is_real_month(v["eventDate"]):
                errors["eventDate"] = "Enter a valid month and year."
            elif v["eventDate"] < today[:7]:
                errors["eventDate"] = "The event month cannot be in the past."
        elif not is_real_date(v["eventDate"]):
            errors["eventDate"] = "Enter a valid event date."
        elif v["eventDate"] < today:
            errors["eventDate"] = "The event date cannot be in the past."
    if v["eventEndDate"]:
        if not v["eventDate"]:
            errors["eventEndDate"] = "Enter the start date first."
        elif not is_real_date(v["eventEndDate"]):
            errors["eventEndDate"] = "Enter a valid end date."
        elif "eventDate" not in errors and v["eventEndDate"] < v["eventDate"]:
            errors["eventEndDate"] = "The end date cannot be before the start date."

    # Proposal deadline: a real date, today or later, and before the event starts.
    if v["requiredBy"]:
        start = event_start_date(v["eventDate"], v["eventDatePrecision"]) if "eventDate" not in errors else None
        if not is_real_date(v["requiredBy"]):
            errors["requiredBy"] = "Enter a valid proposal deadline."
        elif v["requiredBy"] < today:
            errors["requiredBy"] = "The proposal deadline cannot be in the past."
        elif start and v["requiredBy"] >= start:
            errors["requiredBy"] = (
                "The proposal deadline must be before the first day of the event month."
                if v["eventDatePrecision"] == MONTH else "The proposal deadline must be before the event date."
            )

    if v["eventName"] and len(v["eventName"]) > EVENT_NAME_MAX:
        errors["eventName"] = f"Use at most {EVENT_NAME_MAX} characters."
    if v["briefTags"] != [] or not isinstance(v["briefTags"], list):
        problem = check_codes(lists or DEFAULT_LISTS, "briefTags", v["briefTags"], multi=True)
        if problem:
            errors["briefTags"] = problem

    p = v["participants"]
    if p is not None and (isinstance(p, float) or p <= 0):  # floats here are NaN, infinite or fractional
        errors["participants"] = "Enter a whole number of participants greater than 0."

    return errors, v


def request_fields(r) -> dict:
    """Fields of an existing request (RequestView) in the shape validate_request_fields expects."""
    return {
        "clientId": r.client_id, "brand": r.brand, "service": r.service, "opportunityId": r.opportunity_id,
        "eventName": getattr(r, "event_name", None), "eventDatePrecision": r.event_date_precision, "eventDate": r.event_date,
        "eventEndDate": r.event_end_date, "requiredBy": r.required_by,
        "participants": r.participants, "requirementsSummary": r.requirements_summary,
        "specificRequirements": r.specific_requirements, "briefTags": list(r.brief_tags),
    }


def clients_for_creator(viewer, clients: dict, users: dict | None = None) -> dict:
    """The Commercial Head all; a BD (or anyone with "Brings in clients") only their own; anyone else none."""
    if viewer.active_role == COMMERCIAL_HEAD:
        return clients
    if acts_as_business_development(viewer, (users or {}).get(viewer.user_id)):
        return {k: c for k, c in clients.items() if c.owner == viewer.user_id}
    return {}


def check_creator(values: dict, viewer, users: dict, clients: dict) -> dict:
    """{error, errors} when this viewer may not create/edit a request for this client, else {client}."""
    access = can_open_request_form(viewer, users)
    if not access["allowed"]:
        return {"error": access["reason"], "errors": {}}
    client = clients.get(values["clientId"]) if values["clientId"] else None
    if client is not None and client.id not in clients_for_creator(viewer, clients, users):
        return {"error": "You can only create requests for clients you own.",
                "errors": {"clientId": "Not one of your clients."}}
    return {"client": client}


def find_possible_duplicates(data: dict, all_requests, exclude_id: str | None = None) -> list:
    """Open requests that look like the same request (client, brand, service, event date). Warn, don't block."""
    v = normalize_request_fields(data)
    if not (v["clientId"] and v["brand"] and v["service"] and v["eventDate"]):
        return []
    return [r for r in all_requests
            if r.id != exclude_id and is_open_request(r) and r.client_id == v["clientId"] and r.brand == v["brand"]
            and r.service == v["service"] and r.event_date == v["eventDate"]]


def check_draft(data: dict, *, viewer, users: dict, clients: dict, opportunities: dict, today: str,
                submit: bool, lists=None) -> dict:
    """
    The create/edit-draft checks of createDraft/updateDraft plus saveRequest's submit check, in
    the frontend's order: a permission failure wins over field errors; when submitting, every
    missing or invalid field is reported at once.
    -> {"ok": True, "values", "client"} | {"ok": False, "code": "forbidden"|"validation", "error", "errors"}
    """
    errors, values = validate_request_fields(data, mode="draft", today=today, clients=clients,
                                             opportunities=opportunities, lists=lists)
    who = check_creator(values, viewer, users, clients)
    if who.get("error"):
        saved = {"ok": False, "code": "forbidden", "error": who["error"], "errors": {**errors, **who["errors"]}}
    elif errors:
        saved = {"ok": False, "code": "validation", "error": "Please fix the highlighted fields.", "errors": errors}
    else:
        saved = {"ok": True, "values": values, "client": who["client"]}
    if submit:
        full, _ = validate_request_fields(data, mode="submit", today=today, clients=clients,
                                          opportunities=opportunities, lists=lists)
        field_errors = {**full, **({} if saved["ok"] else saved["errors"])}
        if field_errors:
            if saved["ok"]:
                return {"ok": False, "code": "validation", "error": "Please fix the highlighted fields.",
                        "errors": field_errors}
            return {**saved, "errors": field_errors}
    return saved
