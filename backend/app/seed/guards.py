"""
Guards that keep demo data away from real data. Every seed command calls these
first and changes nothing if any of them refuses.

A database is only seeded when ALL of these hold:
1. EVENTFLOW_ENV=development
2. it is migrated to the latest revision
3. it is explicitly marked as a demo database (app_meta data_kind = 'demo')
4. the core tables are empty
"""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..migrations_check import SchemaNotReadyError, check_schema
from ..models import AppMeta, Client, Opportunity, OpportunityHistory, ProposalRequest, RequestStatusHistory, User
from ..settings import Settings

DATA_KIND = "data_kind"
CORE_TABLES = (User, Client, Opportunity, OpportunityHistory, ProposalRequest, RequestStatusHistory)


class SeedRefused(RuntimeError):
    pass


def data_kind(db: Session) -> str | None:
    row = db.get(AppMeta, DATA_KIND)
    return row.value if row else None


def core_row_counts(db: Session) -> dict:
    return {m.__tablename__: db.scalar(select(func.count()).select_from(m)) for m in CORE_TABLES}


def require_development(settings: Settings) -> None:
    if settings.env != "development":
        raise SeedRefused(f"Refusing: demo data is development-only (EVENTFLOW_ENV={settings.env!r}).")


def require_migrated(engine, settings: Settings) -> None:
    try:
        check_schema(engine, settings.database_url)
    except SchemaNotReadyError as exc:
        raise SeedRefused(f"Refusing: {exc}") from exc


def require_empty(db: Session) -> None:
    counts = core_row_counts(db)
    if any(counts.values()):
        raise SeedRefused(f"Refusing: the database already contains records {counts}. Nothing was changed.")


def require_marked_demo(db: Session) -> None:
    kind = data_kind(db)
    if kind != "demo":
        raise SeedRefused(
            f"Refusing: this database is not marked as a demo database (data_kind={kind!r}). "
            "Run 'python -m app.seed mark-demo' on an empty development database first."
        )
