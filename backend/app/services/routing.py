"""Brand routing: which Account Manager receives each brand's NEW proposal requests."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config_domain import BRANDS
from ..errors import conflict
from ..models import BrandRouting

BRAND_NAMES = {b["id"]: b["name"] for b in BRANDS}


def current_routing(db: Session) -> dict:
    """{ brand: AM user id } as it is now."""
    return {r.brand: r.am_user_id for r in db.scalars(select(BrandRouting)).all()}


def routed_am(db: Session, brand: str) -> str:
    """The AM a new request for this brand goes to (existing requests keep theirs)."""
    row = db.get(BrandRouting, brand)
    if row is None:
        raise conflict(f"No Account Manager receives {BRAND_NAMES.get(brand, brand)} requests yet. Someone with "
                       '"Manage accounts" can choose one in Settings.', code="precondition_failed")
    return row.am_user_id
