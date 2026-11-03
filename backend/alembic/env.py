"""Alembic environment: migrates the database named by DATABASE_URL (or sqlalchemy.url)."""

import os

from alembic import context

from app import models  # noqa: F401  (registers all tables)
from app.database import Base, make_engine
from app.settings import DEFAULT_DATABASE_URL

config = context.config
target_metadata = Base.metadata


def database_url() -> str:
    return config.get_main_option("sqlalchemy.url") or os.environ.get("DATABASE_URL") or DEFAULT_DATABASE_URL


def run_migrations_offline() -> None:
    url = database_url()
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True,
                      render_as_batch=url.startswith("sqlite"), compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    url = database_url()
    engine = make_engine(url)
    sqlite = url.startswith("sqlite")
    with engine.connect() as connection:
        if sqlite:
            # Table rebuilds (widening CHECKs) drop and recreate tables others point at: SQLite only allows
            # that with foreign keys off, which must be set outside a transaction. Every reference is
            # checked again below, before the migration commits.
            connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
            connection.commit()
        context.configure(connection=connection, target_metadata=target_metadata,
                          render_as_batch=sqlite, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
            if sqlite:
                broken = connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
                if broken:
                    raise RuntimeError(f"Migration left broken references (nothing was saved): {broken[:5]}")
        if sqlite:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
