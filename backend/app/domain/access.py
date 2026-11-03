"""
Who SEES what (port of the frontend's domain/access.js; same rules and wording, checked by
the contract file's accountCases): data visibility by ACTIVE role, the per-person privileges,
and which pages a person gets.

- Privileges belong to the PERSON: the same switches whichever role they are acting in.
- Privileges only widen what a person sees (or allow reminders later). They never allow a
  workflow action outside the role's rules.

viewer has .user_id and .active_role; users maps id -> UserView (roles, brand, privileges).
"""

from ..config_domain import (
    ACCOUNT_MANAGER, BRINGS_IN_CLIENTS, BUSINESS_DEVELOPMENT, COMMERCIAL_HEAD, EXECUTIVE, MANAGE_ACCOUNTS, MARKETING,
    OPERATIONS,
    PRIVILEGE_IDS, ROLE_DEFAULT_PRIVILEGES, SEE_ALL_BRANDS, SEE_ANALYTICS,
)
from .rules import can_view_request

# all = both brands · brand = the person's own brand (unless "See all brands") · none = no proposal data
DATA_ACCESS = {
    COMMERCIAL_HEAD: "all",
    EXECUTIVE: "all",
    BUSINESS_DEVELOPMENT: "all",
    ACCOUNT_MANAGER: "brand",
    MARKETING: "none",
    OPERATIONS: "none",
    "hr": "none",
    "office_screen": "none",
}
OFFICE_SCREEN_ROLE = "office_screen"
READ_ONLY_ROLES = (EXECUTIVE,)
WORKING_ROLES = (BUSINESS_DEVELOPMENT, ACCOUNT_MANAGER, COMMERCIAL_HEAD)

# Model column for each privilege.
PRIVILEGE_COLUMNS = {
    "manageAccounts": "manage_accounts", "seeAnalytics": "see_analytics",
    "sendReminders": "send_reminders", "seeAllBrands": "see_all_brands", "bringsInClients": "brings_in_clients",
}


def default_privileges(roles) -> dict:
    """A switch is on when any of the roles turns it on."""
    return {p: any(ROLE_DEFAULT_PRIVILEGES.get(r, {}).get(p, False) for r in roles) for p in PRIVILEGE_IDS}


def privileges_of(user) -> dict:
    """A person's switches (their role defaults when none are stored)."""
    if user is None:
        return {p: False for p in PRIVILEGE_IDS}
    stored = getattr(user, "privileges", None) or {}
    defaults = default_privileges(user.roles)
    return {p: stored[p] if isinstance(stored.get(p), bool) else defaults[p] for p in PRIVILEGE_IDS}


def has_privilege(user, privilege: str) -> bool:
    return privileges_of(user)[privilege] is True


def acts_as_business_development(viewer, user) -> bool:
    """
    Does this viewer do the BD steps for their own clients right now? Acting as BD, or - for someone
    without the BD role, like Noha or Doaa - having "Brings in clients" (no role switch). A person who
    HAS the BD role (Mariam El Khayat) still switches to it.
    """
    if viewer.active_role == BUSINESS_DEVELOPMENT:
        return True
    return user is not None and BUSINESS_DEVELOPMENT not in user.roles and has_privilege(user, BRINGS_IN_CLIENTS)


def can_own_clients(user) -> bool:
    """An active person with the BD role or "Brings in clients" may be a client's relationship owner."""
    return (user is not None and user.active is not False
            and (BUSINESS_DEVELOPMENT in user.roles or has_privilege(user, BRINGS_IN_CLIENTS)))


def set_privileges(user_row, privileges: dict) -> None:
    """Writes the switches onto a users row."""
    for p, column in PRIVILEGE_COLUMNS.items():
        setattr(user_row, column, bool(privileges[p]))


# ---------- data visibility ----------

def sees_proposal_data(active_role: str) -> bool:
    return DATA_ACCESS.get(active_role, "none") != "none"


def visible_brands(viewer, user) -> list[str] | None:
    """None = every brand; otherwise the brands seen (possibly none)."""
    access = DATA_ACCESS.get(viewer.active_role, "none")
    if access == "all":
        return None
    if access == "brand":
        if has_privilege(user, SEE_ALL_BRANDS):
            return None
        return [user.brand] if user is not None and user.brand else []
    return []


def can_see_brand(viewer, user, brand: str) -> bool:
    brands = visible_brands(viewer, user)
    return brands is None or brand in brands


def can_see_request(r, viewer, users: dict) -> bool:
    """The draft rule (a draft only for its creator) AND this role's brands."""
    return can_view_request(r, viewer.user_id) and can_see_brand(viewer, users.get(viewer.user_id), r.brand)


def can_see_client(client_brands, viewer, users: dict) -> bool:
    brands = visible_brands(viewer, users.get(viewer.user_id))
    return brands is None or any(b in brands for b in client_brands)


def can_see_opportunity(brand: str, viewer, users: dict) -> bool:
    return can_see_brand(viewer, users.get(viewer.user_id), brand)


def can_comment_on_request(r, viewer, users: dict) -> bool:
    """Anyone who can see a request may comment on it, Executives included."""
    return can_see_request(r, viewer, users)


# ---------- analytics ----------

def can_see_analytics(user, viewer=None) -> dict:
    """Everyone with "See analytics" (company numbers), and BD / AM (acting so) for their own scorecard."""
    if has_privilege(user, SEE_ANALYTICS):
        return {"allowed": True, "reason": None}
    if viewer is not None and viewer.active_role in (BUSINESS_DEVELOPMENT, ACCOUNT_MANAGER):
        return {"allowed": True, "reason": None}
    return {"allowed": False, "reason": 'Only people with "See analytics" can open Analytics.'}


MANAGEMENT_ROLES = (COMMERCIAL_HEAD, EXECUTIVE)


def is_management_view(viewer, user) -> bool:
    return viewer.active_role in MANAGEMENT_ROLES and has_privilege(user, SEE_ANALYTICS)


def scorecard_kinds(person) -> list[str]:
    if person is None:
        return []
    return ((["bd"] if BUSINESS_DEVELOPMENT in person.roles or has_privilege(person, BRINGS_IN_CLIENTS) else [])
            + (["am"] if ACCOUNT_MANAGER in person.roles else []))


def analytics_scope(viewer, user, users: dict, person=None, as_=None) -> dict | None:
    """Whose numbers Analytics shows: own (BD / AM), one person's (management) or the company."""
    if not can_see_analytics(user, viewer)["allowed"]:
        return None
    if viewer.active_role == BUSINESS_DEVELOPMENT:
        return {"kind": "bd", "userId": viewer.user_id, "brands": None}
    if viewer.active_role == ACCOUNT_MANAGER:
        return {"kind": "am", "userId": viewer.user_id, "brands": analytics_brands(viewer, user)}
    if person and is_management_view(viewer, user):
        if as_ in scorecard_kinds(users.get(person)):
            return {"kind": as_, "userId": person, "brands": None}
        return {"error": "Choose a person from the list."}
    return {"kind": "company", "userId": None, "brands": analytics_brands(viewer, user)}


def in_analytics_scope(r, scope: dict, viewer) -> bool:
    if not scope or scope.get("error") or not can_view_request(r, viewer.user_id):
        return False
    if scope["kind"] == "bd":
        return r.bd_owner == scope["userId"]
    if scope["kind"] == "am":
        return r.assigned_am == scope["userId"]
    return scope["brands"] is None or r.brand in scope["brands"]


def analytics_brands(viewer, user) -> list[str] | None:
    """Every brand, except an Account Manager (as AM) without "See all brands": their own brand."""
    return visible_brands(viewer, user) if DATA_ACCESS.get(viewer.active_role) == "brand" else None


def analytics_request_visible(r, viewer, user) -> bool:
    brands = analytics_brands(viewer, user)
    return can_view_request(r, viewer.user_id) and (brands is None or r.brand in brands)


# ---------- pages ----------

def page_access(viewer, user) -> dict:
    data = sees_proposal_data(viewer.active_role)
    privileges = privileges_of(user)
    role = viewer.active_role
    menu = MENUS.get(role, ())
    analytics = "analytics" in menu and has_privilege(user, SEE_ANALYTICS)  # "See analytics" (Noha, Doaa, Tony)
    admin = "admin" in menu and privileges[MANAGE_ACCOUNTS]
    return {
        "home": "home" in menu, "queue": "queue" in menu, "proposals": "proposals" in menu and data,
        "events": "events" in menu, "clients": "clients" in menu and data, "dashboard": "dashboard" in menu,
        "myNumbers": role in (BUSINESS_DEVELOPMENT, ACCOUNT_MANAGER), "analytics": analytics,
        "team": admin, "settings": admin, "staffing": "staffing" in menu, "facilitators": "facilitators" in menu,
        "screen": "screen" in menu, "opportunities": False, "tasks": False,
    }


# Each role's menu (the frontend's navigation.js shows the same; the server refuses the rest).
MENUS = {
    BUSINESS_DEVELOPMENT: ("home", "proposals", "events", "clients", "dashboard"),
    ACCOUNT_MANAGER: ("home", "queue", "proposals", "events", "dashboard"),
    COMMERCIAL_HEAD: ("home", "proposals", "events", "clients", "dashboard", "analytics", "admin", "screen"),
    EXECUTIVE: ("dashboard", "analytics", "proposals", "events", "clients", "screen"),
    "operations": ("home", "events", "staffing", "facilitators"),
    "hr": ("home", "staffing", "facilitators", "events"),
    MARKETING: ("home", "events"),
    OFFICE_SCREEN_ROLE: ("screen",),
}
