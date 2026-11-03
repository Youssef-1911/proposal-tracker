"""Development identity: fail closed, and refuse to start outside development."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.migrations_check import SchemaNotReadyError
from app.settings import Settings, SettingsError, load_settings

from .conftest import AHMED, MD_AM, MK_AM, MK_BD, NOHA, as_user, sqlite_url

BACKEND = Path(__file__).resolve().parent.parent
PROTECTED = [
    "/api/me", "/api/users", "/api/config", "/api/clients", "/api/clients/CL-0001",
    "/api/opportunities", "/api/opportunities/OPP-0001",
]


def error(response):
    return response.json()["error"]


# ---------- disabled -> 401 ----------

@pytest.mark.parametrize("env,flag", [("development", False), ("test", False), ("production", False)])
def test_identity_disabled_rejects_every_protected_endpoint(engine, seeded, db_url, env, flag):
    with TestClient(create_app(Settings(env=env, dev_identity=flag, database_url=db_url), engine=engine)) as c:
        for path in PROTECTED:
            r = c.get(path, headers=NOHA)  # headers are ignored when the dev identity is off
            assert r.status_code == 401, path
            assert error(r)["code"] == "unauthenticated"
        assert c.get("/api/health").status_code == 200, "health needs no identity"


# ---------- enabled: fail closed ----------

def test_missing_user_header_is_401(api):
    r = api.get("/api/me", headers={"X-Dev-Role": "commercial_head"})
    assert r.status_code == 401
    assert "X-Dev-User" in error(r)["message"]


def test_unknown_user_is_401(api):
    r = api.get("/api/me", headers=as_user("u-nobody", "commercial_head"))
    assert r.status_code == 401
    assert error(r)["code"] == "unauthenticated"


def test_missing_role_header_is_401(api):
    r = api.get("/api/me", headers={"X-Dev-User": "u-noha"})
    assert r.status_code == 401
    assert "X-Dev-Role" in error(r)["message"]


@pytest.mark.parametrize("headers", [
    as_user("u-ahmed", "account_manager"),
    as_user("u-ahmed", "commercial_head"),
    as_user("u-mariam-dimitri", "business_development"),
    as_user("u-noha", "business_development"),
    as_user("u-noha", "made_up_role"),
])
def test_role_not_held_is_403(api, headers):
    r = api.get("/api/me", headers=headers)
    assert r.status_code == 403
    assert error(r)["code"] == "forbidden"
    assert "does not hold the role" in error(r)["message"]


def test_inactive_user_is_401(api, session):
    from app.models import User
    user = session.get(User, "u-sherine")
    user.active = False
    session.commit()
    assert api.get("/api/me", headers=as_user("u-sherine", "business_development")).status_code == 401


# ---------- /api/me and active role ----------

def test_me_reports_user_active_role_and_create_permission(api):
    me = api.get("/api/me", headers=NOHA).json()
    assert me["user"]["id"] == "u-noha"
    assert me["activeRole"] == "commercial_head"
    assert me["createRequests"] == {"allowed": True, "reason": None}

    bd = api.get("/api/me", headers=MK_BD).json()
    am = api.get("/api/me", headers=MK_AM).json()
    assert bd["user"]["roles"] == am["user"]["roles"] == ["business_development", "account_manager"]
    assert bd["activeRole"] == "business_development" and bd["createRequests"]["allowed"] is True
    assert am["activeRole"] == "account_manager" and am["createRequests"]["allowed"] is False
    assert "Switch your active role to Business Development" in am["createRequests"]["reason"]

    md = api.get("/api/me", headers=MD_AM).json()
    assert md["createRequests"]["allowed"] is False
    assert "Only Business Development or the Commercial Head" in md["createRequests"]["reason"]
    assert api.get("/api/me", headers=AHMED).json()["createRequests"]["allowed"] is True


def test_users_list(api):
    body = api.get("/api/users", headers=AHMED).json()
    assert body["total"] == 8  # the six of the team, plus Doaa and Tony (Executives)
    by_id = {u["id"]: u for u in body["items"]}
    assert by_id["u-mariam-elkhayat"]["brand"] == "grasshoppers"
    assert by_id["u-mariam-dimitri"]["roles"] == ["account_manager"]
    assert set(by_id["u-noha"]) == {"id", "name", "initials", "avatarTone", "brand", "roles", "active", "email", "jobTitle",
                                    "privileges", "rowVersion"}
    assert by_id["u-doaa"]["roles"] == ["executive"] and by_id["u-doaa"]["jobTitle"] == "Managing Director"


# ---------- refuse to start ----------

@pytest.mark.parametrize("environ", [
    {"EVENTFLOW_ENV": "production", "EVENTFLOW_DEV_IDENTITY": "true"},
    {"EVENTFLOW_ENV": "test", "EVENTFLOW_DEV_IDENTITY": "true"},
    {"EVENTFLOW_DEV_IDENTITY": "true"},  # env defaults to production
    {"EVENTFLOW_ENV": "development", "EVENTFLOW_DEV_IDENTITY": "true", "EVENTFLOW_HOST": "0.0.0.0"},
    {"EVENTFLOW_ENV": "staging"},
])
def test_unsafe_settings_are_rejected(environ):
    with pytest.raises(SettingsError):
        load_settings(environ)


def test_defaults_are_safe():
    s = load_settings({})
    assert s.env == "production" and s.dev_identity is False and s.dev_identity_active is False
    assert s.host == "127.0.0.1"
    assert load_settings({"EVENTFLOW_ENV": "development", "EVENTFLOW_DEV_IDENTITY": "true"}).dev_identity_active


def test_create_app_refuses_dev_identity_outside_development():
    with pytest.raises(SettingsError, match="Refusing to start"):
        create_app(Settings(env="production", dev_identity=True))


@pytest.mark.parametrize("module", ["import app.main", "import app.serve; app.serve.main()"])
def test_server_process_refuses_to_start_outside_development(module):
    env = {**os.environ, "EVENTFLOW_ENV": "production", "EVENTFLOW_DEV_IDENTITY": "true", "PYTHONDONTWRITEBYTECODE": "1"}
    result = subprocess.run([sys.executable, "-c", module], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode != 0
    assert "Refusing to start" in result.stderr


def test_server_refuses_to_start_on_unmigrated_or_unmanaged_database(tmp_path):
    from sqlalchemy import create_engine, text
    empty = tmp_path / "empty.db"
    settings = Settings(env="development", dev_identity=True, database_url=sqlite_url(empty))
    with pytest.raises(SchemaNotReadyError, match="empty"):
        with TestClient(create_app(settings)):
            pass

    legacy = tmp_path / "legacy.db"
    eng = create_engine(sqlite_url(legacy))
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT)"))
        conn.execute(text("INSERT INTO clients (name) VALUES ('Real client')"))
    eng.dispose()
    with pytest.raises(SchemaNotReadyError, match="not managed by Alembic"):
        with TestClient(create_app(Settings(env="development", dev_identity=True, database_url=sqlite_url(legacy)))):
            pass
    eng = create_engine(sqlite_url(legacy))
    with eng.connect() as conn:
        assert conn.execute(text("SELECT name FROM clients")).scalar() == "Real client", "nothing was changed"
    eng.dispose()
