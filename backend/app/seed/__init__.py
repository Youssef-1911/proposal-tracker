"""
Development-only demo data commands:

    python -m app.seed mark-demo        mark an EMPTY, migrated development database as a demo database
    python -m app.seed demo             load the demo data (database must be marked demo and empty)
    python -m app.seed reset-demo --yes rebuild a demo database from scratch (only if marked demo)

None of these run automatically, and all of them refuse outside EVENTFLOW_ENV=development.
"""

from alembic import command
from sqlalchemy.orm import Session

from ..database import make_engine, make_sessionmaker, utcnow
from ..migrations_check import alembic_config
from ..models import AppMeta
from ..services.proposal_files import sweep_orphan_files
from ..settings import Settings
from ..storage import LocalFileStorage
from .demo import SEED_VERSION, load_demo_data
from .guards import (
    DATA_KIND, SeedRefused, data_kind, require_development, require_empty, require_marked_demo, require_migrated,
)


def _session(engine) -> Session:
    return make_sessionmaker(engine)()


def mark_demo(settings: Settings, engine=None) -> str:
    require_development(settings)
    engine = engine or make_engine(settings.database_url)
    require_migrated(engine, settings)
    with _session(engine) as db:
        kind = data_kind(db)
        if kind is not None:
            raise SeedRefused(f"Refusing: this database is already marked data_kind={kind!r}.")
        require_empty(db)
        db.add(AppMeta(key=DATA_KIND, value="demo", updated_at=utcnow()))
        db.commit()
    return "Marked as a demo database."


class _TrackingStorage:
    """Remembers which files the seed saved, so they can be removed again if the seed fails."""

    def __init__(self, storage):
        self.storage, self.saved = storage, []

    def save(self, data: bytes) -> str:
        key = self.storage.save(data)
        self.saved.append(key)
        return key


def seed_demo(settings: Settings, engine=None) -> dict:
    require_development(settings)
    engine = engine or make_engine(settings.database_url)
    require_migrated(engine, settings)
    storage = _TrackingStorage(LocalFileStorage(settings.files_dir))
    with _session(engine) as db:
        require_marked_demo(db)
        require_empty(db)
        # One transaction: either the whole dataset is saved, or nothing (closing without commit rolls back).
        # Demo proposal files are small placeholder PDFs; they are deleted again if anything fails.
        try:
            result = load_demo_data(db, storage=storage)
            db.merge(AppMeta(key="seed_version", value=SEED_VERSION, updated_at=utcnow()))
            db.commit()
        except BaseException:
            for key in storage.saved:
                storage.storage.delete(key)
            raise
    return result


def reset_demo(settings: Settings, confirm: bool, engine=None) -> dict:
    """Drops and rebuilds ONLY a database already marked as demo. Requires explicit confirmation."""
    require_development(settings)
    if not confirm:
        raise SeedRefused("Refusing: reset-demo deletes all demo data; pass --yes to confirm.")
    engine = engine or make_engine(settings.database_url)
    require_migrated(engine, settings)
    with _session(engine) as db:
        require_marked_demo(db)
    engine.dispose()
    config = alembic_config(settings.database_url)
    command.downgrade(config, "base")
    command.upgrade(config, "head")
    engine = make_engine(settings.database_url)
    mark_demo(settings, engine)
    result = seed_demo(settings, engine)
    with _session(engine) as db:  # the previous demo's files no longer belong to any request
        result["removed_files"] = len(sweep_orphan_files(db, LocalFileStorage(settings.files_dir)))
    return result


__all__ = ["SeedRefused", "mark_demo", "reset_demo", "seed_demo"]
