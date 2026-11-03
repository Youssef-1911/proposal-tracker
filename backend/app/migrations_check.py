"""
Startup safety check: the server only runs against a database that Alembic manages
and that is at the latest revision. It never creates, migrates or drops anything itself.
"""

from pathlib import Path

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import inspect

from .settings import BACKEND_DIR


class SchemaNotReadyError(RuntimeError):
    pass


def alembic_config(database_url: str) -> Config:
    config = Config(str(Path(BACKEND_DIR) / "alembic.ini"))
    config.set_main_option("script_location", str(Path(BACKEND_DIR) / "alembic"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def head_revision(database_url: str) -> str:
    return ScriptDirectory.from_config(alembic_config(database_url)).get_current_head()


def check_schema(engine, database_url: str) -> None:
    head = head_revision(database_url)
    with engine.connect() as conn:
        current = MigrationContext.configure(conn).get_current_revision()
        tables = set(inspect(conn).get_table_names())
    if current is None:
        if tables - {"alembic_version"}:
            raise SchemaNotReadyError(
                "This database has tables that are not managed by Alembic (an old, unmanaged schema?). "
                "Refusing to start. Nothing was changed. Move it aside and run 'alembic upgrade head' on a new database."
            )
        raise SchemaNotReadyError("The database is empty. Run 'alembic upgrade head' first.")
    if current != head:
        raise SchemaNotReadyError(
            f"Database is at revision {current}, but the code expects {head}. Run 'alembic upgrade head'."
        )
