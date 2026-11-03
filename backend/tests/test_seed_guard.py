"""Demo data must never reach a database that could hold real records."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.database import utcnow
from app.models import AppMeta, Client, Opportunity, OpportunityHistory, User
from app.seed import SeedRefused, mark_demo, reset_demo, seed_demo
from app.seed.guards import core_row_counts
from app.settings import Settings

from .conftest import sqlite_url

BACKEND = Path(__file__).resolve().parent.parent


def counts(session):
    session.expire_all()
    return core_row_counts(session)


EMPTY = {"users": 0, "clients": 0, "opportunities": 0, "opportunity_history": 0,
         "proposal_requests": 0, "request_status_history": 0}
SEEDED = {"users": 8, "clients": 12, "opportunities": 18, "opportunity_history": 18,
          "proposal_requests": 19, "request_status_history": 80}


@pytest.mark.parametrize("env", ["production", "test"])
def test_refuses_outside_development(engine, session, db_url, env):
    settings = Settings(env=env, dev_identity=False, database_url=db_url)
    for run in (lambda: mark_demo(settings, engine), lambda: seed_demo(settings, engine),
                lambda: reset_demo(settings, confirm=True, engine=engine)):
        with pytest.raises(SeedRefused, match="development-only"):
            run()
    assert counts(session) == EMPTY
    assert session.get(AppMeta, "data_kind") is None


def test_refuses_on_database_not_marked_as_demo(dev_settings, engine, session):
    with pytest.raises(SeedRefused, match="not marked as a demo database"):
        seed_demo(dev_settings, engine)
    assert counts(session) == EMPTY


def test_refuses_on_database_marked_real(dev_settings, engine, session):
    session.add(AppMeta(key="data_kind", value="real", updated_at=utcnow()))
    session.commit()
    with pytest.raises(SeedRefused, match="data_kind='real'"):
        seed_demo(dev_settings, engine)
    with pytest.raises(SeedRefused, match="already marked"):
        mark_demo(dev_settings, engine)
    with pytest.raises(SeedRefused, match="not marked as a demo"):
        reset_demo(dev_settings, confirm=True, engine=engine)
    assert counts(session) == EMPTY


def test_refuses_on_non_empty_tables(dev_settings, engine, session):
    mark_demo(dev_settings, engine)
    seed_demo(dev_settings, engine)
    before = counts(session)
    assert before == SEEDED
    with pytest.raises(SeedRefused, match="already contains records"):
        seed_demo(dev_settings, engine)
    assert counts(session) == before, "nothing was changed"


def test_mark_demo_refuses_when_records_already_exist(dev_settings, engine, session):
    # Unmarked database that already holds a record (could be real): never mark it as demo.
    session.add(User(id="u-someone", name="Someone", initials="SO", avatar_tone=1, active=True,
                     email="someone@eventflow.example", created_at=utcnow(), updated_at=utcnow()))
    session.commit()
    with pytest.raises(SeedRefused, match="already contains records"):
        mark_demo(dev_settings, engine)
    assert session.get(AppMeta, "data_kind") is None


def test_refuses_on_unmigrated_database(tmp_path):
    settings = Settings(env="development", dev_identity=False, database_url=sqlite_url(tmp_path / "raw.db"))
    with pytest.raises(SeedRefused, match="alembic upgrade head"):
        mark_demo(settings)


def test_seed_is_all_or_nothing(dev_settings, engine, session, monkeypatch):
    mark_demo(dev_settings, engine)
    import app.seed.demo as demo
    real = demo.create_opportunity
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 7:
            raise RuntimeError("simulated failure half-way through seeding")
        return real(*args, **kwargs)

    monkeypatch.setattr(demo, "create_opportunity", flaky)
    with pytest.raises(RuntimeError):
        seed_demo(dev_settings, engine)
    assert counts(session) == EMPTY, "a failed seed leaves no partial data"


def test_reset_demo_requires_confirmation_and_rebuilds(dev_settings, engine, session):
    mark_demo(dev_settings, engine)
    seed_demo(dev_settings, engine)
    with pytest.raises(SeedRefused, match="--yes"):
        reset_demo(dev_settings, confirm=False, engine=engine)
    session.close()  # release SQLite file locks before the schema is rebuilt
    engine.dispose()
    result = reset_demo(dev_settings, confirm=True)
    assert result["opportunities"] == 18
    session.expire_all()
    assert counts(session) == SEEDED
    assert session.get(AppMeta, "data_kind").value == "demo"
    assert session.scalar(select(func.min(Client.id))) == "CL-0001", "IDs restart from a clean database"


def test_cli_refuses_outside_development(db_url):
    env = {**os.environ, "EVENTFLOW_ENV": "production", "DATABASE_URL": db_url, "PYTHONDONTWRITEBYTECODE": "1"}
    env.pop("EVENTFLOW_DEV_IDENTITY", None)
    for cmd in (["demo"], ["mark-demo"], ["reset-demo", "--yes"]):
        result = subprocess.run([sys.executable, "-m", "app.seed", *cmd], cwd=BACKEND, env=env,
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 2, cmd
        assert "development-only" in result.stderr


def test_seeded_lost_opportunity_has_its_reason_in_history(seeded, session):
    lost = session.scalars(select(Opportunity).where(Opportunity.stage == "lost")).one()
    assert lost.lost_reason == "competitor", "a LOST_REASONS code, like Mark lost stores"
    entry = session.scalars(select(OpportunityHistory).where(OpportunityHistory.opportunity_id == lost.id)).one()
    assert (entry.to_stage, entry.lost_reason, entry.note, entry.reason_code) == ("lost", "competitor", "Demo seed data", "seed")
