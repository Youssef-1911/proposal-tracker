"""
Managing accounts and brand routing (port of the frontend's domain/accounts.js; same rules and
wording, checked by the contract file's accountCases): field checks, new account ids, the
safeguards, and what changed (for the user history).

users maps id -> UserView (active and deactivated); routing maps brand -> AM user id.
"""

import re
import unicodedata

from ..config_domain import ACCOUNT_MANAGER, BRANDS, MANAGE_ACCOUNTS, PRIVILEGE_IDS, PROPOSAL_STATUSES, ROLE_IDS
from .access import default_privileges, has_privilege, privileges_of
from .rules import is_open_request

EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
KEEP_MANAGER = 'At least one active person must keep "Manage accounts".'
BRAND_NAMES = {b["id"]: b["name"] for b in BRANDS}
STATUS_CLOSED = {st["id"]: st["closed"] for st in PROPOSAL_STATUSES}
HISTORY_FIELDS = ("name", "email", "jobTitle", "roles", "brand")


def routing_first(brand: str) -> str:
    return f"Change routing for {BRAND_NAMES.get(brand, brand)} first."


def _ok():
    return {"allowed": True, "reason": None}


def _deny(reason: str):
    return {"allowed": False, "reason": reason}


def _text(v) -> str:
    if v is None:
        return ""
    return (v if isinstance(v, str) else str(v)).strip()


def can_manage_accounts(viewer, users: dict) -> dict:
    """Only people with "Manage accounts" create or change accounts and routing (in any active role)."""
    if has_privilege(users.get(viewer.user_id), MANAGE_ACCOUNTS):
        return _ok()
    return _deny('Only people with "Manage accounts" can do this.')


# ---------- fields ----------

def validate_account_fields(data: dict, users, id: str | None = None) -> dict:
    """data = { name, email, jobTitle, roles, brand, privileges } -> { errors, values }."""
    roles = []
    for r in data.get("roles") if isinstance(data.get("roles"), list) else []:
        if r not in roles:
            roles.append(r)
    is_am = ACCOUNT_MANAGER in roles
    given = data.get("privileges") if isinstance(data.get("privileges"), dict) else {}
    defaults = default_privileges(roles)
    values = {
        "name": _text(data.get("name")),
        "email": _text(data.get("email")).lower(),
        "jobTitle": _text(data.get("jobTitle")) or None,
        "roles": [r for r in ROLE_IDS if r in roles],
        "brand": (_text(data.get("brand")) or None) if is_am else None,
        "privileges": {p: given[p] if isinstance(given.get(p), bool) else defaults[p] for p in PRIVILEGE_IDS},
    }
    errors = {}
    if not values["name"]:
        errors["name"] = "Enter the full name."
    elif len(values["name"]) > 200:
        errors["name"] = "Use at most 200 characters."
    if not values["email"]:
        errors["email"] = "Enter the work email."
    elif len(values["email"]) > 254 or not EMAIL.match(values["email"]):
        errors["email"] = "Enter a valid email address."
    elif any(u.id != id and _text(u.email).lower() == values["email"] for u in _all(users)):
        errors["email"] = "Another account already uses this email."
    if values["jobTitle"] and len(values["jobTitle"]) > 200:
        errors["jobTitle"] = "Use at most 200 characters."
    if not roles:
        errors["roles"] = "Choose at least one role."
    elif not all(r in ROLE_IDS for r in roles):
        errors["roles"] = "Choose from the listed roles."
    if is_am and not values["brand"]:
        errors["brand"] = "Choose the brand this Account Manager works for."
    elif is_am and values["brand"] not in BRAND_NAMES:
        errors["brand"] = "Choose Grasshoppers or Team Up."
    return {"errors": errors, "values": values}


def _all(users):
    return users.values() if isinstance(users, dict) else users


def new_account_id(name, existing_ids) -> str:
    """"u-sara-mostafa"; "u-sara-mostafa-2" when taken. Made once; it never changes when the name does."""
    decomposed = unicodedata.normalize("NFKD", _text(name))
    plain = re.sub("[̀-ͯ]", "", decomposed).lower()
    slug = re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", plain))[:40] or "user"
    taken = set(existing_ids)
    base = f"u-{slug}"
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


def initials_for(name) -> str:
    words = [w for w in re.split(r"\s+", _text(name)) if w]
    if not words:
        return "?"
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][0] + words[-1][0]).upper()


def avatar_tone_for(account_count: int) -> int:
    return (account_count % 6) + 1


# ---------- safeguards ----------

def _managers(users):
    return [u for u in _all(users) if u.active and has_privilege(u, MANAGE_ACCOUNTS)]


def routed_brands(user_id: str, routing: dict) -> list[str]:
    return [b for b in BRAND_NAMES if routing.get(b) == user_id]


def check_account_update(target, values: dict, actor_id: str, users, routing: dict) -> dict:
    errors = {}
    had = has_privilege(target, MANAGE_ACCOUNTS)
    if had and not values["privileges"][MANAGE_ACCOUNTS]:
        if target.id == actor_id:
            errors["privileges"] = 'You cannot remove your own "Manage accounts".'
        elif target.active and all(u.id == target.id for u in _managers(users)):
            errors["privileges"] = KEEP_MANAGER
    for brand in routed_brands(target.id, routing):
        if ACCOUNT_MANAGER not in values["roles"]:
            errors["roles"] = routing_first(brand)
        elif values["brand"] != brand:
            errors["brand"] = routing_first(brand)
    return {"errors": errors}


def can_deactivate(target, actor_id: str, users, routing: dict) -> dict:
    if not target.active:
        return _deny("This account is already deactivated.")
    if target.id == actor_id:
        return _deny("You cannot deactivate your own account.")
    routed = routed_brands(target.id, routing)
    if routed:
        return _deny(routing_first(routed[0]))
    if has_privilege(target, MANAGE_ACCOUNTS) and all(u.id == target.id for u in _managers(users)):
        return _deny(KEEP_MANAGER)
    return _ok()


def can_reactivate(target) -> dict:
    return _ok() if not target.active else _deny("This account is already active.")


def deactivation_warnings(user_id: str, clients, requests) -> dict:
    """clients: dicts with owner, archivedAt; requests: RequestViews."""
    return {
        "clients": sum(1 for c in clients if c["owner"] == user_id and not c.get("archivedAt")),
        "openRequests": sum(1 for r in requests if r.bd_owner == user_id and is_open_request(r)),
    }


def deactivation_move(target, users, requests) -> dict:
    """
    An Account Manager's requests that are not closed (drafts included). Deactivating them is blocked
    unless these move to another active Account Manager of the same brand, in the same step.
    requests: RequestViews. -> {requestIds, count, brand, choices, blocked}
    """
    request_ids = [r.id for r in requests if r.assigned_am == target.id and not STATUS_CLOSED.get(r.status, False)]
    choices = [u.id for u in routing_choices(target.brand, users) if u.id != target.id]
    blocked = (f"Add another Account Manager for {BRAND_NAMES.get(target.brand, 'this brand')} first."
               if request_ids and not choices else None)
    return {"requestIds": request_ids, "count": len(request_ids), "brand": target.brand, "choices": choices,
            "blocked": blocked}


def validate_deactivation_move(target, data: dict, users, requests) -> dict:
    plan = deactivation_move(target, users, requests)
    if not plan["count"]:
        return {"errors": {}}
    if plan["blocked"]:
        return {"errors": {"moveTo": plan["blocked"]}}
    if data.get("moveTo") not in plan["choices"]:
        n = plan["count"]
        return {"errors": {"moveTo": f"Choose who takes over {target.name}'s {n} {'open request' if n == 1 else 'open requests'}."}}
    return {"errors": {}}


def assigned_am_change_note(from_name: str, to_name: str, by_name: str) -> str:
    return f"Assigned AM changed from {from_name} to {to_name} by {by_name} — deactivation"


# ---------- history ----------

def account_fields(user) -> dict:
    """The fields the history compares, frontend-shaped."""
    return {"name": user.name, "email": user.email, "jobTitle": user.job_title, "roles": list(user.roles),
            "brand": user.brand, "privileges": privileges_of(user)}


def account_changes(before: dict, values: dict) -> dict:
    changes = {}
    for f in HISTORY_FIELDS:
        old, new = before.get(f), values.get(f)
        if old != new:
            changes[f] = {"from": old, "to": new}
    was = before["privileges"]
    for p in PRIVILEGE_IDS:
        if was[p] != values["privileges"][p]:
            changes[f"privileges.{p}"] = {"from": was[p], "to": values["privileges"][p]}
    return changes


# ---------- routing ----------

def routing_choices(brand: str, users) -> list:
    return [u for u in _all(users) if u.active and ACCOUNT_MANAGER in u.roles and u.brand == brand]


def validate_routing(brand, am_id, users, routing: dict) -> dict:
    if brand not in BRAND_NAMES:
        return {"errors": {"brand": "Choose Grasshoppers or Team Up."}}
    name = BRAND_NAMES[brand]
    if not any(u.id == am_id for u in routing_choices(brand, users)):
        return {"errors": {"amId": f"Choose an active Account Manager for {name}."}}
    if routing.get(brand) == am_id:
        return {"errors": {"amId": f"{name} requests already go to this Account Manager."}}
    return {"errors": {}}
