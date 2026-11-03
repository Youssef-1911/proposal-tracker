"""
Who may ACT on a request (port of frontend permissions.js). Separate from who may VIEW
(rules.can_view_request) and from the transition table (workflow.py).
Reason texts are identical to the frontend's; the contract scenarios compare them.

viewer = Actor(user_id, active_role); users = {id: UserView}.
"""

from ..config_domain import ACCOUNT_MANAGER, BRANDS, BUSINESS_DEVELOPMENT, COMMERCIAL_HEAD, ROLES
from .access import acts_as_business_development, can_see_request
from .views import RequestView, UserView

CREATOR = "creator"
BD_OWNER = "bdOwner"
ASSIGNED_AM = "assignedAM"
HEAD = "commercialHead"

BRAND_NAMES = {b["id"]: b["name"] for b in BRANDS}


def role_label(role: str, user: UserView | None = None) -> str:
    """'Account Manager — Grasshoppers' for AMs with a brand, the plain role label otherwise."""
    base = ROLES.get(role, role)
    if role == ACCOUNT_MANAGER and user is not None and user.brand:
        return f"{base} — {BRAND_NAMES.get(user.brand, user.brand)}"
    return base


def holds_responsibility(actor: str, r: RequestView, viewer, users: dict | None = None) -> bool:
    """"BD" means acting as BD, or "Brings in clients" without the BD role (Noha, Doaa); see access.py."""
    as_bd = acts_as_business_development(viewer, (users or {}).get(viewer.user_id))
    if actor == CREATOR:
        return viewer.user_id == r.created_by and (
            (as_bd and viewer.user_id == r.bd_owner) or viewer.active_role == COMMERCIAL_HEAD
        )
    if actor == BD_OWNER:
        return viewer.user_id == r.bd_owner and as_bd
    if actor == ASSIGNED_AM:
        return viewer.user_id == r.assigned_am and viewer.active_role == ACCOUNT_MANAGER
    if actor == HEAD:
        return viewer.active_role == COMMERCIAL_HEAD
    return False


def _name_of(users: dict, user_id: str) -> str:
    user = users.get(user_id)
    return user.name if user else "someone else"


def _denial_reason(actors: list[str], r: RequestView, viewer, users: dict) -> str:
    parts = []
    for a in actors:
        if a == BD_OWNER:
            parts.append(f"the BD owner, {_name_of(users, r.bd_owner)},")
        elif a == ASSIGNED_AM:
            parts.append(f"the assigned Account Manager, {_name_of(users, r.assigned_am)},")
        elif a == CREATOR:
            parts.append(f"the person who created this draft, {_name_of(users, r.created_by)},")
        elif a == HEAD:
            parts.append("the Commercial Head")
        else:
            parts.append(a)
    # Right person, wrong active role (e.g. Mariam El Khayat acting as AM on a BD step).
    user = users.get(viewer.user_id)
    switch_to = next(
        (role for role in (
            BUSINESS_DEVELOPMENT if a == BD_OWNER and viewer.user_id == r.bd_owner
            else ACCOUNT_MANAGER if a == ASSIGNED_AM and viewer.user_id == r.assigned_am
            else None
            for a in actors) if role),
        None,
    )
    if switch_to and user is not None and switch_to in user.roles:
        return (f"You are acting as {role_label(viewer.active_role, user)}. "
                f"Switch your active role to {role_label(switch_to, user)} to do this.")
    return f"Only {' or '.join(parts)} can do this."


def check_actors(actors: list[str], r: RequestView, viewer, users: dict) -> dict:
    if not can_see_request(r, viewer, users):
        return {"allowed": False, "reason": "You cannot view this request."}
    if any(holds_responsibility(a, r, viewer, users) for a in actors):
        return {"allowed": True, "reason": None}
    return {"allowed": False, "reason": _denial_reason(actors, r, viewer, users)}


def can_open_request_form(viewer, users: dict) -> dict:
    """BD (in their BD role), anyone with "Brings in clients" and the Commercial Head may create requests."""
    if viewer.active_role == COMMERCIAL_HEAD or acts_as_business_development(viewer, users.get(viewer.user_id)):
        return {"allowed": True, "reason": None}
    user = users.get(viewer.user_id)
    if user is not None and BUSINESS_DEVELOPMENT in user.roles:
        return {"allowed": False, "reason": (
            f"You are acting as {role_label(viewer.active_role, user)}. "
            "Switch your active role to Business Development to create a proposal request.")}
    return {"allowed": False, "reason": "Only Business Development or the Commercial Head can create proposal requests."}
