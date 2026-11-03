from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..services.lists import lists_out
from .. import config_domain as cfg
from ..database import get_db
from ..domain import access, tracker
from ..domain.crm import can_create_client
from ..domain.permissions import can_open_request_form
from ..domain.views import user_from_orm
from ..identity import Actor, get_current_actor
from ..models import User
from ..schemas import MeOut, Permission, UserList, UserOut
from ..seed.guards import data_kind
from ..services.routing import current_routing

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/health")
def health():
    """Liveness only. The only endpoint that needs no caller identity."""
    return {"status": "ok"}


def create_requests_permission(actor: Actor, users: dict) -> Permission:
    """Same rule and wording as the frontend's canOpenRequestForm (domain/permissions.py)."""
    return Permission(**can_open_request_form(actor, users))


@router.get("/me", response_model=MeOut)
def me(request: Request, actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    user = db.get(User, actor.user_id)
    users = {u.id: user_from_orm(u) for u in db.scalars(select(User)).all()}
    me_view = users[actor.user_id]
    return MeOut(user=UserOut.of(user), active_role=actor.active_role,
                 create_requests=create_requests_permission(actor, users),
                 create_clients=Permission(**can_create_client(actor, users)),
                 privileges=access.privileges_of(me_view),
                 pages=access.page_access(actor, me_view),
                 scopes=tracker.scopes_for(actor.active_role, me_view),
                 data_kind=_data_kind(request.app.state.settings, db))


def _data_kind(settings, db) -> str:
    """What the header says: a copy says so ("Test copy", "Presentation copy"); else the database's own kind."""
    if settings.test_copy:
        return "test"
    return "presentation" if settings.presentation else data_kind(db)


@router.get("/users", response_model=UserList)
def users(include_inactive: bool = Query(default=False, alias="includeInactive",
                                        description="Also deactivated people (their names still appear in history)"),
          _: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    stmt = select(User).options(selectinload(User.roles)).order_by(User.name)
    if not include_inactive:
        stmt = stmt.where(User.active.is_(True))
    rows = db.scalars(stmt).all()
    return UserList(items=[UserOut.of(u) for u in rows], total=len(rows))


@router.get("/config")
def config(_: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    """Business configuration (same values as the frontend's domain modules); routing is the live one."""
    return {
        "roles": [{"id": k, "label": v} for k, v in cfg.ROLES.items()],
        "brands": cfg.BRANDS,
        "routing": current_routing(db),
        "privileges": [{"id": p, "label": cfg.PRIVILEGE_LABELS[p]} for p in cfg.PRIVILEGE_IDS],
        "clientTypes": [{"id": k, "label": v} for k, v in cfg.CLIENT_TYPES.items()],
        "proposalStatuses": cfg.PROPOSAL_STATUSES,
        "proposalStages": cfg.PROPOSAL_STAGES,
        "lostReasons": cfg.LOST_REASONS,
        "shareChannels": cfg.SHARE_CHANNELS,
        "proposalFiles": {"types": cfg.PROPOSAL_FILE_TYPES, "maxBytes": cfg.PROPOSAL_FILE_MAX_BYTES,
                          "uploadStatuses": cfg.UPLOAD_STATUSES},
        "commentMaxLength": cfg.COMMENT_MAX_LENGTH,
        "opportunityStages": cfg.OPPORTUNITY_STAGES,
        "eventDatePrecisions": list(cfg.EVENT_DATE_PRECISIONS),
        "businessTimezone": "Africa/Cairo",
        "currency": "EGP",
        # The dropdown lists as Settings left them (codes, labels, hidden flags).
        "lists": lists_out(db),
    }
