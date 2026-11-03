"""Alembic baseline: forward and back on SQLite, matches the models, database-level guards."""

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError, OperationalError

from app.database import Base
from app.migrations_check import alembic_config, head_revision
from app.models import AppendOnlyError, OpportunityHistory

from .conftest import sqlite_url

TABLES = {"users", "user_roles", "clients", "client_brands", "opportunities", "opportunity_history",
          "proposal_requests", "request_status_history", "proposal_files", "request_comments", "client_contacts", "client_history", "request_events", "user_history", "brand_routing", "routing_history", "id_counters", "app_meta", "list_options", "notifications", "request_reads", "alembic_version",
          "occasions", "occasion_periods", "radar_dismissals", "todos", "staffing_ratios", "facilitators", "facilitator_notes",
          "facilitator_assignments", "facilitator_ratings", "facilitator_rating_history"}
TRIGGERS = {"opportunity_history_no_update", "opportunity_history_no_delete",
            "request_status_history_no_update", "request_status_history_no_delete",
            "proposal_files_no_update", "proposal_files_no_delete",
            "request_comments_no_update", "request_comments_no_delete",
            "client_history_no_update", "client_history_no_delete",
            "request_events_no_update", "request_events_no_delete",
            "user_history_no_update", "user_history_no_delete",
            "routing_history_no_update", "routing_history_no_delete"}


def snapshot(url):
    eng = create_engine(url)
    with eng.connect() as conn:
        tables = set(inspect(conn).get_table_names())
        triggers = {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='trigger'"))}
        revision = MigrationContext.configure(conn).get_current_revision()
    eng.dispose()
    return tables, triggers, revision


def test_upgrade_downgrade_upgrade(tmp_path):
    url = sqlite_url(tmp_path / "m.db")
    config = alembic_config(url)

    command.upgrade(config, "head")
    tables, triggers, rev = snapshot(url)
    assert tables == TABLES
    assert triggers == TRIGGERS
    assert rev == head_revision(url) == "0018"

    command.downgrade(config, "base")
    tables, triggers, rev = snapshot(url)
    assert tables == {"alembic_version"} and triggers == set() and rev is None

    command.upgrade(config, "head")
    assert snapshot(url)[0] == TABLES, "migrations are repeatable"


def test_migrated_schema_matches_the_models(tmp_path):
    url = sqlite_url(tmp_path / "m.db")
    command.upgrade(alembic_config(url), "head")
    eng = create_engine(url)
    with eng.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn, opts={"compare_type": True}), Base.metadata)
    eng.dispose()
    assert diff == [], f"models and migration differ: {diff}"


def test_history_is_append_only_at_the_database_level(seeded, engine):
    with engine.connect() as conn:
        with pytest.raises((IntegrityError, OperationalError), match="append-only"):
            conn.execute(text("UPDATE opportunity_history SET note = 'edited' WHERE id = 1"))
        conn.rollback()
        with pytest.raises((IntegrityError, OperationalError), match="append-only"):
            conn.execute(text("DELETE FROM opportunity_history WHERE id = 1"))
        conn.rollback()
        assert conn.execute(text("SELECT count(*) FROM opportunity_history")).scalar() == 18


def test_history_is_append_only_in_the_orm(seeded, session):
    entry = session.get(OpportunityHistory, 1)
    entry.note = "edited"
    with pytest.raises(AppendOnlyError):
        session.commit()
    session.rollback()
    session.delete(session.get(OpportunityHistory, 1))
    with pytest.raises(AppendOnlyError):
        session.commit()
    session.rollback()


def test_lost_requires_a_reason_at_the_database_level(seeded, engine):
    with engine.connect() as conn:
        with pytest.raises(IntegrityError):
            conn.execute(text("UPDATE opportunities SET stage = 'lost', lost_reason = NULL WHERE id = 'OPP-0001'"))
        conn.rollback()
        with pytest.raises(IntegrityError):
            conn.execute(text("UPDATE opportunities SET stage = 'lost', lost_reason = '   ' WHERE id = 'OPP-0001'"))
        conn.rollback()


@pytest.mark.parametrize("sql", [
    "UPDATE opportunities SET stage = 'cancelled' WHERE id = 'OPP-0001'",   # old stage set
    "UPDATE opportunities SET brand = 'other' WHERE id = 'OPP-0001'",
    "UPDATE opportunities SET estimated_value = -1 WHERE id = 'OPP-0001'",
    "UPDATE opportunities SET event_date_precision = 'week' WHERE id = 'OPP-0001'",
    "UPDATE clients SET client_type = 'company' WHERE id = 'CL-0001'",       # old client type
    "INSERT INTO user_roles (user_id, role, position) VALUES ('u-ahmed', 'admin', 9)",
])
def test_database_rejects_values_outside_the_approved_sets(seeded, engine, sql):
    with engine.connect() as conn:
        with pytest.raises(IntegrityError):
            conn.execute(text(sql))
        conn.rollback()


@pytest.mark.parametrize("column", ["client_id", "brand", "service", "owner_id", "stage"])
def test_required_opportunity_fields_cannot_be_null(seeded, engine, column):
    with engine.connect() as conn:
        with pytest.raises(IntegrityError):
            conn.execute(text(f"UPDATE opportunities SET {column} = NULL WHERE id = 'OPP-0001'"))
        conn.rollback()


def test_0002_down_to_0001_keeps_the_opportunity_history_guard(tmp_path):
    """0002 rebuilds opportunity_history on SQLite; its append-only triggers must survive both ways."""
    url = sqlite_url(tmp_path / "m.db")
    config = alembic_config(url)
    command.upgrade(config, "head")
    command.downgrade(config, "0001")
    tables, triggers, rev = snapshot(url)
    assert rev == "0001"
    assert "proposal_requests" not in tables and "request_status_history" not in tables
    assert triggers == {"opportunity_history_no_update", "opportunity_history_no_delete"}
    command.upgrade(config, "head")
    assert snapshot(url)[1] == TRIGGERS


def test_request_history_is_append_only_at_the_database_level(seeded, engine):
    with engine.connect() as conn:
        for sql in ("UPDATE request_status_history SET note = 'edited' WHERE id = 1",
                    "DELETE FROM request_status_history WHERE id = 1"):
            with pytest.raises((IntegrityError, OperationalError), match="append-only"):
                conn.execute(text(sql))
            conn.rollback()
        assert conn.execute(text("SELECT count(*) FROM request_status_history")).scalar() == 80


def test_request_history_is_append_only_in_the_orm(seeded, session):
    from app.models import RequestStatusHistory
    entry = session.get(RequestStatusHistory, 1)
    entry.note = "edited"
    with pytest.raises(AppendOnlyError):
        session.commit()
    session.rollback()


@pytest.mark.parametrize("sql", [
    "UPDATE proposal_requests SET status = 'archived' WHERE rowid = 1",
    "UPDATE proposal_requests SET am_price = 0 WHERE rowid = 1",
    "UPDATE proposal_requests SET version = 0 WHERE rowid = 1",
    "INSERT INTO request_status_history (request_id, seq, status, changed_by_id, role, changed_at, version, am_price) "
    "SELECT id, 1, 'submitted', 'u-noha', 'commercial_head', '2026-01-01 00:00:00', 1, NULL FROM proposal_requests LIMIT 1",
    "INSERT INTO request_status_history (request_id, seq, status, changed_by_id, role, changed_at, version, am_price) "
    "SELECT id, 99, 'submitted', 'u-noha', 'commercial_head', '2026-01-01 00:00:00', 1, 5000 FROM proposal_requests LIMIT 1",
])
def test_request_constraints(seeded, engine, sql):
    """Unknown status, non-positive price/version, duplicate seq, and a price on a non-Ready entry are rejected."""
    with engine.connect() as conn:
        with pytest.raises(IntegrityError):
            conn.execute(text(sql))
        conn.rollback()
