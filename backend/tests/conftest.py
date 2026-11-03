import os

# Never let the developer's shell configuration leak into tests (e.g. a dev identity flag
# that would make importing app.main refuse to start, or a real DATABASE_URL).
for key in ("EVENTFLOW_ENV", "EVENTFLOW_DEV_IDENTITY", "EVENTFLOW_HOST", "DATABASE_URL"):
    os.environ.pop(key, None)

import shutil  # noqa: E402

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database import make_engine, make_sessionmaker  # noqa: E402
from app.main import create_app  # noqa: E402
from app.migrations_check import alembic_config  # noqa: E402
from app.seed import mark_demo, seed_demo  # noqa: E402
from app.settings import Settings  # noqa: E402


# The development identity is only accepted from loopback addresses (127.0.0.1 / ::1).
LOOPBACK = ("127.0.0.1", 50000)


def sqlite_url(path) -> str:
    return f"sqlite:///{path.as_posix()}"


@pytest.fixture(scope="session")
def migrated_template(tmp_path_factory):
    """A database migrated with Alembic once; each test gets its own copy (real schema + triggers)."""
    path = tmp_path_factory.mktemp("template") / "template.db"
    command.upgrade(alembic_config(sqlite_url(path)), "head")
    return path


@pytest.fixture
def db_url(migrated_template, tmp_path):
    path = tmp_path / "test.db"
    shutil.copy(migrated_template, path)
    return sqlite_url(path)


@pytest.fixture
def engine(db_url):
    eng = make_engine(db_url)
    yield eng
    eng.dispose()


@pytest.fixture
def session(engine):
    db = make_sessionmaker(engine)()
    yield db
    db.close()


@pytest.fixture
def dev_settings(db_url, tmp_path):
    return Settings(env="development", dev_identity=True, database_url=db_url, files_dir=str(tmp_path / "files"))


@pytest.fixture
def seeded(dev_settings, engine):
    mark_demo(dev_settings, engine)
    return seed_demo(dev_settings, engine)


@pytest.fixture
def api(dev_settings, engine, seeded):
    """A running app (lifespan included, so the real schema check runs) over seeded demo data."""
    with TestClient(create_app(dev_settings, engine=engine), client=LOOPBACK) as client:
        yield client


def as_user(user_id: str, role: str) -> dict:
    return {"X-Dev-User": user_id, "X-Dev-Role": role}


def pr(n: int) -> str:
    """Seeded request id; the year is the Africa/Cairo year at seeding time (as on the server)."""
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo
    return f"PR-{datetime.now(timezone.utc).astimezone(ZoneInfo('Africa/Cairo')).year}-{n:04d}"


NOHA = as_user("u-noha", "commercial_head")
AHMED = as_user("u-ahmed", "business_development")
SHERINE = as_user("u-sherine", "business_development")
MK_BD = as_user("u-mariam-elkhayat", "business_development")
MK_AM = as_user("u-mariam-elkhayat", "account_manager")
MD_AM = as_user("u-mariam-dimitri", "account_manager")


@pytest.fixture(scope="module")
def contract_api(tmp_path_factory, migrated_template):
    """App over the shared contract world (contracts/proposal-scenarios.json), clock frozen at its 'now'."""
    from .contract_world import contract_client, load_scenarios, load_world
    scenarios = load_scenarios()
    path = tmp_path_factory.mktemp("contract") / "contract.db"
    shutil.copy(migrated_template, path)
    url = sqlite_url(path)
    eng = make_engine(url)
    with make_sessionmaker(eng)() as session:
        load_world(session, scenarios)
    with contract_client(Settings(env="development", dev_identity=True, database_url=url), eng, scenarios) as client:
        yield client
    eng.dispose()
