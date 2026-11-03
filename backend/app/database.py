from collections.abc import Iterator
from datetime import datetime, timezone

from fastapi import Request
from sqlalchemy import DateTime, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator


class Base(DeclarativeBase):
    pass


class UTCDateTime(TypeDecorator):
    """
    Timestamps are always stored and returned in UTC, on every database.
    SQLite has no time-zone support, so values are stored as naive UTC and
    re-attached to UTC on read. Naive datetimes are rejected on write.
    """

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("Naive datetime: timestamps must be timezone-aware (UTC).")
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def make_engine(url: str, **kwargs):
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    engine = create_engine(url, connect_args=connect_args, **kwargs)

    if url.startswith("sqlite"):
        # SQLite ignores foreign keys unless explicitly enabled per connection.
        @event.listens_for(engine, "connect")
        def _enable_fk(dbapi_conn, _):
            dbapi_conn.execute("PRAGMA foreign_keys=ON")

    return engine


def make_sessionmaker(engine) -> sessionmaker:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db(request: Request) -> Iterator[Session]:
    """One session per request, from the engine configured on the running app."""
    db = request.app.state.sessionmaker()
    try:
        yield db
    finally:
        db.close()


def begin_write(db: Session) -> None:
    """
    Start a write transaction that holds the write lock from its first statement.

    SQLite: plain BEGIN only takes the write lock at the first INSERT/UPDATE, so two writers
    that both read first can deadlock (one fails immediately with "database is locked").
    BEGIN IMMEDIATE takes the lock up front; others wait (busy timeout) and then read fresh data.
    PostgreSQL: nothing to do here; rows are locked with SELECT ... FOR UPDATE and row_version.
    """
    conn = db.connection()
    if conn.dialect.name == "sqlite" and not conn.connection.dbapi_connection.in_transaction:
        conn.exec_driver_sql("BEGIN IMMEDIATE")
