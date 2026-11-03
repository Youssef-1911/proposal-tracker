"""
Who is calling. TEMPORARY development identity until authentication exists.

Every protected endpoint depends on get_current_actor() and receives an Actor.
Authorization code only ever sees Actor, so replacing this module's header logic
with real authentication (session/token -> user id + validated active role) will
not change any authorization or workflow code.

Fail closed:
- development identity disabled            -> 401 for every protected endpoint
- request not from a loopback address       -> 403 (127.0.0.1 / ::1 only)
- X-Dev-User missing / unknown / inactive  -> 401
- X-Dev-Role missing                        -> 401
- X-Dev-Role not one of the user's roles   -> 403

This is NOT security: anyone who can reach the API can claim any identity while it
is enabled. It is only allowed with EVENTFLOW_ENV=development and binds to 127.0.0.1.
"""

from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from .database import get_db
from .errors import forbidden, unauthenticated
from .models import User


@dataclass(frozen=True)
class Actor:
    user_id: str
    active_role: str


DEV_USER_HEADER = "X-Dev-User"
DEV_ROLE_HEADER = "X-Dev-Role"
LOOPBACK_CLIENTS = {"127.0.0.1", "::1"}


def get_current_actor(request: Request, db: Session = Depends(get_db)) -> Actor:
    settings = request.app.state.settings
    if not settings.dev_identity_active:
        raise unauthenticated(
            "No caller identity. Authentication is not implemented yet, and the development "
            "identity is disabled (requires EVENTFLOW_ENV=development and EVENTFLOW_DEV_IDENTITY=true)."
        )

    # Loopback only, checked on every request regardless of how the server was started
    # (e.g. `uvicorn --host 0.0.0.0` bypasses app.serve's bind check, but not this).
    client_host = request.client.host if request.client else None
    if client_host not in LOOPBACK_CLIENTS:
        raise forbidden(
            "The development identity is only accepted from this computer (127.0.0.1). "
            f"Request came from {client_host or 'an unknown address'}."
        )

    user_id = (request.headers.get(DEV_USER_HEADER) or "").strip()
    role = (request.headers.get(DEV_ROLE_HEADER) or "").strip()
    if not user_id:
        raise unauthenticated(f"Missing {DEV_USER_HEADER} header.")
    user = db.get(User, user_id)
    if user is None or not user.active:
        raise unauthenticated(f"Unknown user {user_id!r}.")
    if not role:
        raise unauthenticated(f"Missing {DEV_ROLE_HEADER} header.")
    if role not in user.role_ids:
        raise forbidden(f"{user.name} does not hold the role {role!r}.")
    if role == OFFICE_SCREEN and not (request.method == "GET" and request.url.path in OFFICE_SCREEN_PATHS):
        raise forbidden("The office screen account can open the office screen only.")
    return Actor(user_id=user.id, active_role=role)


# The office TV account: the screen's data and what the app needs to start (it sees no client: clients come back empty).
OFFICE_SCREEN = "office_screen"
OFFICE_SCREEN_PATHS = {"/api/me", "/api/config", "/api/users", "/api/clients", "/api/screen"}
