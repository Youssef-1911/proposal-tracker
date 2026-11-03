"""
One-time setup of the REAL database (kept on this laptop, next to the demo database, never mixed):

    python -m app.setup_real            creates backend/eventflow-real.db (or DATABASE_URL), migrates it,
                                        marks it data_kind = 'real' and adds the team's accounts and routing

The team: the same eight people as the demo, with placeholder @eventflow.example emails until
Microsoft sign-in. Noha and Doaa get "Brings in clients". No clients or requests are created:
those come from the 2026 tracker (python -m app.import_tracker).

Safe to run again: a database that is already set up is left alone. It refuses a demo database or
a database that already holds records, and the demo seed refuses a real database (app/seed/guards.py).
"""

import sys

from alembic import command
from sqlalchemy.orm import Session

from .config_domain import BRAND_AM_ROUTING
from .database import make_engine, make_sessionmaker, utcnow
from .domain.access import default_privileges, set_privileges
from .migrations_check import alembic_config
from .models import AppMeta, BrandRouting, User, UserRole
from .seed.demo import BRINGS_IN_CLIENTS, USERS
from .seed.guards import DATA_KIND, SeedRefused, data_kind, require_empty
from .settings import BACKEND_DIR, load_settings

REAL_DATABASE_URL = f"sqlite:///{(BACKEND_DIR / 'eventflow-real.db').as_posix()}"


def real_database_url(env=None) -> str:
    """DATABASE_URL when it is set; otherwise the real database file (never the demo one)."""
    import os
    return (env or os.environ).get("DATABASE_URL") or REAL_DATABASE_URL


def setup_real(database_url: str, now=None) -> str:
    now = now or utcnow()
    command.upgrade(alembic_config(database_url), "head")
    engine = make_engine(database_url)
    try:
        with make_sessionmaker(engine)() as db:
            kind = data_kind(db)
            if kind == "real":
                return "The real database is already set up. Nothing was changed."
            if kind is not None:
                raise SeedRefused(f"Refusing: this database is marked data_kind={kind!r}, not real.")
            require_empty(db)
            _add_team(db, now)
            db.add(AppMeta(key=DATA_KIND, value="real", updated_at=now))
            db.commit()
    finally:
        engine.dispose()
    return f"Real database ready: {len(USERS)} accounts and the brand routing. Next: python -m app.import_tracker <file>"


def _add_team(db: Session, now) -> None:
    for uid, name, initials, tone, roles, brand, job_title, email in USERS:
        user = User(id=uid, name=name, initials=initials, avatar_tone=tone, brand=brand, active=True, email=email,
                    job_title=job_title, created_at=now, updated_at=now)
        set_privileges(user, {**default_privileges(roles), **({"bringsInClients": True} if uid in BRINGS_IN_CLIENTS else {})})
        user.roles = [UserRole(role=r, position=i) for i, r in enumerate(roles)]
        db.add(user)
    db.flush()
    for brand, am in BRAND_AM_ROUTING.items():
        db.add(BrandRouting(brand=brand, am_user_id=am, updated_at=now))
    db.flush()


def main() -> int:
    try:
        load_settings()  # validates the environment the same way the server does
        print(setup_real(real_database_url()))
    except SeedRefused as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
