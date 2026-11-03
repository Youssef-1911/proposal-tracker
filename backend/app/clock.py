"""
The current time, as a FastAPI dependency so tests can freeze it.
"today" for business rules (overdue, upcoming) is the Africa/Cairo calendar date.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

from .database import utcnow

CAIRO = ZoneInfo("Africa/Cairo")


def get_now() -> datetime:
    return utcnow()


def cairo_today_iso(now: datetime) -> str:
    return now.astimezone(CAIRO).date().isoformat()


def iso_z(value: datetime | None) -> str | None:
    """UTC timestamp in the frontend's format, e.g. 2026-10-20T09:15:00.000Z."""
    if value is None:
        return None
    return value.astimezone(ZoneInfo("UTC")).isoformat(timespec="milliseconds").replace("+00:00", "Z")
