"""
Clients, contacts and opportunities: permissions, field validation, manual stage moves,
duplicate warnings and the owner-transfer plan. Port of the frontend's domain/crm.js (same
rules and wording, checked by the contract scenarios' crmCases).

Pure functions over plain dicts with the frontend's field names (owner, archivedAt, clientId,
stage, contacts, ...). viewer = Actor(user_id, active_role); users = {id: UserView}.
"""

import re
import unicodedata
from datetime import date

from ..config_domain import (
    BRANDS, BUSINESS_DEVELOPMENT, CLIENT_TYPES, COMMERCIAL_HEAD, LOST_REASON_FORM_IDS, LOST_REASON_OTHER, OPPORTUNITY_STAGES,
)
from .access import acts_as_business_development, can_own_clients
from .permissions import role_label
from .rules import is_open_request

CH, BD = COMMERCIAL_HEAD, BUSINESS_DEVELOPMENT
WON, LOST = "won", "lost"
STAGE_IDS = [s["id"] for s in sorted(OPPORTUNITY_STAGES, key=lambda s: s["order"])]
CLOSED_STAGES = {s["id"] for s in OPPORTUNITY_STAGES if s["closed"]}
BRANDS_BY_ID = {b["id"]: b for b in BRANDS}
OK = {"allowed": True, "reason": None}


def _deny(reason):
    return {"allowed": False, "reason": reason}


def _name_of(users, user_id):
    user = users.get(user_id)
    return user.name if user else "someone else"


def _switch_to_bd(viewer, users):
    user = users.get(viewer.user_id)
    if viewer.active_role != BD and user is not None and BD in user.roles:
        return (f"You are acting as {role_label(viewer.active_role, user)}. "
                "Switch your active role to Business Development to do this.")
    return None


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------

def can_create_client(viewer, users) -> dict:
    """Any BD (acting as BD), anyone with "Brings in clients" (no role switch), or the Commercial Head."""
    if viewer.active_role == CH or acts_as_business_development(viewer, users.get(viewer.user_id)):
        return OK
    return _deny(_switch_to_bd(viewer, users) or "Only Business Development or the Commercial Head can create clients.")


def can_edit_client(client: dict, viewer, users) -> dict:
    if client.get("archivedAt"):
        return _deny("This client is archived.")
    if viewer.active_role == CH:
        return OK
    if viewer.user_id == client["owner"]:
        if acts_as_business_development(viewer, users.get(viewer.user_id)):
            return OK
        switch = _switch_to_bd(viewer, users)
        if switch:
            return _deny(switch)
    return _deny(f"Only the relationship owner, {_name_of(users, client['owner'])}, or the Commercial Head can do this.")


def can_transfer_client(client: dict, viewer) -> dict:
    if client.get("archivedAt"):
        return _deny("This client is archived.")
    if viewer.active_role == CH:
        return OK
    return _deny("Only the Commercial Head can transfer a client to another owner.")


def can_edit_opportunity(opp: dict, viewer, users) -> dict:
    if opp.get("archivedAt"):
        return _deny("This opportunity is archived.")
    if viewer.active_role == CH:
        return OK
    if viewer.user_id == opp["owner"]:
        if acts_as_business_development(viewer, users.get(viewer.user_id)):
            return OK
        switch = _switch_to_bd(viewer, users)
        if switch:
            return _deny(switch)
    return _deny(f"Only the opportunity owner, {_name_of(users, opp['owner'])}, or the Commercial Head can do this.")


def client_permissions(client: dict, viewer, users) -> dict:
    edit = can_edit_client(client, viewer, users)
    return {"edit": edit, "contacts": edit, "archive": edit, "addOpportunity": edit,
            "transfer": can_transfer_client(client, viewer)}


# ---------------------------------------------------------------------------
# Manual stage moves
# ---------------------------------------------------------------------------

def manual_stage_targets(opp: dict) -> list[str]:
    final = (WON, "closed_no_result")
    if opp["stage"] in final:
        return []
    return [s for s in STAGE_IDS if s not in final and s != opp["stage"]]


def validate_stage_move(opp: dict, data: dict) -> dict:
    def fail(code, error, errors=None):
        return {"ok": False, "code": code, "error": error, "errors": errors or {}}

    raw_note = data.get("note")
    note = raw_note.strip() if isinstance(raw_note, str) else ""
    if opp["stage"] == WON:
        return fail("invalid_transition", "Confirmed is final: it is set only when a proposal is confirmed.")
    if data.get("stage") == WON:
        return fail("invalid_transition", "Confirmed is set only when a proposal is confirmed (Mark confirmed on the request).")
    if data.get("stage") not in manual_stage_targets(opp):
        return fail("validation", "Please fix the highlighted fields.", {"stage": "Choose a different stage."})
    errors = {}
    if data["stage"] == LOST:
        if data.get("lostReason") not in LOST_REASON_FORM_IDS:
            errors["lostReason"] = "Choose why the opportunity was lost."
        elif data.get("lostReason") == LOST_REASON_OTHER and not note:
            errors["note"] = 'Describe the reason when choosing "Other".'
    if opp["stage"] == LOST and not note:
        errors["note"] = "Add a short note on why the opportunity is reopened."
    if errors:
        return fail("validation", "Please fix the highlighted fields.", errors)
    return {"ok": True, "stage": data["stage"], "reasonCode": "manual_change", "note": note or None,
            "lostReason": data.get("lostReason") if data["stage"] == LOST else None}


# ---------------------------------------------------------------------------
# Field validation
# ---------------------------------------------------------------------------

_EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
_PHONE = re.compile(r"[+\d][\d\s\-()]{5,24}")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_MONTH = re.compile(r"\d{4}-\d{2}")


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value == int(value):
        value = int(value)
    return str(value).strip()


def _real_date(v: str) -> bool:
    if not _DATE.fullmatch(v):
        return False
    try:
        date.fromisoformat(v)
        return True
    except ValueError:
        return False


def _real_month(v: str) -> bool:
    return bool(_MONTH.fullmatch(v)) and 1 <= int(v[5:]) <= 12


def validate_client_fields(data: dict) -> dict:
    brands = list(dict.fromkeys(data["brands"])) if isinstance(data.get("brands"), list) else []
    values = {"name": _text(data.get("name")), "type": _text(data.get("type")), "brands": brands,
              "city": _text(data.get("city")) or None, "notes": _text(data.get("notes")) or None}
    errors = {}
    if not values["name"]:
        errors["name"] = "Enter the client name."
    elif len(values["name"]) > 200:
        errors["name"] = "Use at most 200 characters."
    if values["type"] not in CLIENT_TYPES:
        errors["type"] = "Choose the client type."
    if not brands:
        errors["brands"] = "Choose at least one brand."
    elif not all(b in BRANDS_BY_ID for b in brands):
        errors["brands"] = "Choose Grasshoppers, Team Up or both."
    if values["city"] and len(values["city"]) > 100:
        errors["city"] = "Use at most 100 characters."
    if values["notes"] and len(values["notes"]) > 2000:
        errors["notes"] = "Use at most 2,000 characters."
    return {"errors": errors, "values": values}


def validate_contact_fields(data: dict) -> dict:
    values = {"name": _text(data.get("name")), "title": _text(data.get("title")) or None,
              "phone": _text(data.get("phone")) or None, "email": _text(data.get("email")) or None,
              "notes": _text(data.get("notes")) or None, "isPrimary": data.get("isPrimary") is True}
    errors = {}
    if not values["name"]:
        errors["name"] = "Enter the contact's name."
    elif len(values["name"]) > 200:
        errors["name"] = "Use at most 200 characters."
    if values["title"] and len(values["title"]) > 200:
        errors["title"] = "Use at most 200 characters."
    if values["phone"] and not _PHONE.fullmatch(values["phone"]):
        errors["phone"] = "Enter a valid phone number."
    if values["email"] and not _EMAIL.fullmatch(values["email"]):
        errors["email"] = "Enter a valid email address."
    if values["notes"] and len(values["notes"]) > 1000:
        errors["notes"] = "Use at most 1,000 characters."
    return {"errors": errors, "values": values}


def _whole(value):
    """(value, invalid) like the frontend's wholeNumber: empty -> None; Number(v) must be an integer."""
    if value is None or value == "":
        return None, False
    if isinstance(value, bool):
        return int(value), False
    if isinstance(value, int):
        return value, False
    if isinstance(value, float):
        return (int(value), False) if value == int(value) else (None, True)
    text = str(value).strip()
    if re.fullmatch(r"[+-]?\d+(\.0*)?", text):
        return int(float(text)), False
    return None, True


def validate_opportunity_fields(data: dict, *, today: str, current: dict | None = None) -> dict:
    precision = "month" if data.get("eventDatePrecision") == "month" else "day"
    values = {"brand": _text(data.get("brand")), "service": _text(data.get("service")), "estimatedValue": None,
              "participants": None, "eventDatePrecision": precision, "eventDate": _text(data.get("eventDate")) or None,
              # optional, exact dates only
              "eventEndDate": (_text(data.get("eventEndDate")) or None) if precision == "day" else None,
              "eventName": _text(data.get("eventName")) or None,  # optional, at most 80 characters
              "nextAction": _text(data.get("nextAction")) or None,
              "nextActionDate": _text(data.get("nextActionDate")) or None}
    errors = {}
    brand = BRANDS_BY_ID.get(values["brand"])
    if not brand:
        errors["brand"] = "Choose Grasshoppers or Team Up."
    if not values["service"]:
        errors["service"] = "Choose a service."
    elif brand and not any(s["id"] == values["service"] for s in brand["services"]):
        errors["service"] = f"Choose a {brand['name']} service."

    value, bad = _whole(data.get("estimatedValue"))
    if bad or (value is not None and value < 0):
        errors["estimatedValue"] = "Use a whole EGP amount of 0 or more."
    else:
        values["estimatedValue"] = value
    people, bad = _whole(data.get("participants"))
    if bad or (people is not None and people <= 0):
        errors["participants"] = "Use a whole number greater than 0."
    else:
        values["participants"] = people

    def changed(field):
        return current is None or current.get(field) != values[field]

    ev = values["eventDate"]
    if ev:
        if not (_real_month(ev) if precision == "month" else _real_date(ev)):
            errors["eventDate"] = "Enter a valid month and year." if precision == "month" else "Enter a valid event date."
        elif changed("eventDate") and (ev < today[:7] if precision == "month" else ev < today):
            errors["eventDate"] = "The event date cannot be in the past."
    end = values["eventEndDate"]
    if end:
        if not ev:
            errors["eventEndDate"] = "Enter the start date first."
        elif not _real_date(end):
            errors["eventEndDate"] = "Enter a valid end date."
        elif "eventDate" not in errors and end < ev:
            errors["eventEndDate"] = "The end date cannot be before the start date."
    if values["eventName"] and len(values["eventName"]) > 80:
        errors["eventName"] = "Use at most 80 characters."
    if values["nextAction"] and len(values["nextAction"]) > 300:
        errors["nextAction"] = "Use at most 300 characters."
    nd = values["nextActionDate"]
    if nd:
        if not _real_date(nd):
            errors["nextActionDate"] = "Enter a valid date."
        elif changed("nextActionDate") and nd < today:
            errors["nextActionDate"] = "The next action date cannot be in the past."
    return {"errors": errors, "values": values}


# ---------------------------------------------------------------------------
# Possible duplicates (a warning, never a block)
# ---------------------------------------------------------------------------

def normalize_name(name) -> str:
    text = unicodedata.normalize("NFKC", str(name or "").lower())
    return "".join(ch for ch in text if unicodedata.category(ch)[0] in ("L", "N"))


def normalize_phone(phone) -> str:
    d = re.sub(r"\D+", "", str(phone or ""))
    if d.startswith("0020"):
        d = d[4:]
    elif d.startswith("20") and len(d) >= 11:
        d = d[2:]
    if d.startswith("0"):
        d = d[1:]
    return d


def normalize_email(email) -> str:
    return str(email or "").strip().lower()


def _similar_names(a, b) -> bool:
    x, y = normalize_name(a), normalize_name(b)
    if not x or not y:
        return False
    if x == y:
        return True
    short, long_ = (x, y) if len(x) <= len(y) else (y, x)
    return len(short) >= 4 and short in long_


def find_possible_duplicate_clients(candidate: dict, clients: list[dict], exclude_id: str | None = None) -> list[dict]:
    phones = {p for p in (normalize_phone(c.get("phone")) for c in candidate.get("contacts", [])) if len(p) >= 6}
    emails = {e for e in (normalize_email(c.get("email")) for c in candidate.get("contacts", [])) if e}
    out = []
    for c in clients:
        if c["id"] == exclude_id:
            continue
        contacts = c.get("contacts", [])
        matches = []
        if _similar_names(candidate.get("name"), c["name"]):
            matches.append("name")
        if any(normalize_phone(x.get("phone")) in phones for x in contacts):
            matches.append("phone")
        if any(normalize_email(x.get("email")) in emails for x in contacts):
            matches.append("email")
        if matches:
            out.append({"id": c["id"], "name": c["name"], "matches": matches})
    return out


def search_clients(query, clients: list[dict], limit: int = 8) -> list[str]:
    """The client box: matching, not archived clients (names starting with the text first) -> ids."""
    q = normalize_name(query)
    if not q:
        return []
    found = [c for c in clients if not c.get("archivedAt") and q in normalize_name(c["name"])]
    found.sort(key=lambda c: (0 if normalize_name(c["name"]).startswith(q) else 1, c["name"].lower(), c["id"]))
    return [c["id"] for c in found[:limit]]


def did_you_mean(name, clients: list[dict]) -> str | None:
    """"Did you mean Talabat?" while a new client's name is typed: the first similar existing client, or None."""
    found = find_possible_duplicate_clients({"name": name, "contacts": []}, [c for c in clients if not c.get("archivedAt")])
    return next((d["id"] for d in found if "name" in d["matches"]), None)


# ---------------------------------------------------------------------------
# Owner transfer
# ---------------------------------------------------------------------------

def validate_transfer(client: dict, data: dict, users) -> dict:
    errors = {}
    reason = _text(data.get("reason"))
    if not can_own_clients(users.get(data.get("toOwner"))) or data.get("toOwner") == client["owner"]:
        errors["toOwner"] = "Choose a new owner other than the current one."
    if not reason:
        errors["reason"] = "Give a short reason for the transfer."
    elif len(reason) > 500:
        errors["reason"] = "Use at most 500 characters."
    return {"errors": errors}


def new_client_owner(viewer, requested, users) -> dict:
    """The Head chooses anyone who can own clients (herself too); a BD, or anyone else with "Brings in clients", owns it."""
    if viewer.active_role != CH and acts_as_business_development(viewer, users.get(viewer.user_id)):
        return {"owner": viewer.user_id}
    if can_own_clients(users.get(requested)):
        return {"owner": requested}
    return {"errors": {"owner": "Choose the relationship owner."}}


def transfer_plan(client: dict, *, opportunities: list[dict], requests: list, move_requests: bool = True) -> dict:
    """opportunities: dicts (clientId, stage); requests: RequestView. Same plan as the frontend."""
    open_requests = [r for r in requests if r.client_id == client["id"] and is_open_request(r)]
    return {
        "opportunityIds": [o["id"] for o in opportunities if o["clientId"] == client["id"] and o["stage"] not in CLOSED_STAGES],
        "requestIds": [r.id for r in open_requests] if move_requests else [],
        "openRequestCount": len(open_requests),
    }


def request_transfer_note(from_name: str, to_name: str, by_name: str, reason: str) -> str:
    return f"BD owner transferred from {from_name} to {to_name} by {by_name} — {reason}"
