"""
Application settings, read from environment variables (no .env loading).

    EVENTFLOW_ENV            development | test | production   (default: production)
    EVENTFLOW_DEV_IDENTITY   true | false                       (default: false)
    DATABASE_URL             SQLAlchemy URL (default: SQLite file backend/eventflow.db)
    EVENTFLOW_HOST           bind address for app.serve         (default: 127.0.0.1)
    EVENTFLOW_FILES_DIR      proposal file storage folder       (default: backend/storage/proposal-files)
                             Never inside a folder that is served publicly.

The development identity (X-Dev-User / X-Dev-Role headers) is TEMPORARY until real
authentication exists. It is only ever active when EVENTFLOW_ENV=development AND
EVENTFLOW_DEV_IDENTITY=true. Enabling it in any other environment is a startup error.
"""

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DATABASE_URL = f"sqlite:///{(BACKEND_DIR / 'eventflow.db').as_posix()}"
DEFAULT_FILES_DIR = str(BACKEND_DIR / "storage" / "proposal-files")
BUSINESS_TIMEZONE = "Africa/Cairo"

ENVIRONMENTS = {"development", "test", "production"}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class SettingsError(RuntimeError):
    """Invalid or unsafe configuration. The server must not start."""


@dataclass(frozen=True)
class Settings:
    env: str = "production"
    dev_identity: bool = False
    database_url: str = DEFAULT_DATABASE_URL
    host: str = "127.0.0.1"
    files_dir: str = DEFAULT_FILES_DIR
    presentation: bool = False  # a presentation copy of the real data (start-dev.ps1 -Data present)
    test_copy: bool = False  # the persistent test copy of the real data (start-dev.ps1 -Data test)
    business_timezone: str = BUSINESS_TIMEZONE

    @property
    def dev_identity_active(self) -> bool:
        return self.env == "development" and self.dev_identity

    def validate(self) -> "Settings":
        if self.env not in ENVIRONMENTS:
            raise SettingsError(f"EVENTFLOW_ENV must be one of {sorted(ENVIRONMENTS)}, got {self.env!r}.")
        if self.dev_identity and self.env != "development":
            raise SettingsError(
                "EVENTFLOW_DEV_IDENTITY=true is only allowed when EVENTFLOW_ENV=development. "
                "Refusing to start: the development identity headers are not authentication."
            )
        if self.dev_identity and self.host not in LOOPBACK_HOSTS:
            raise SettingsError(
                f"The development identity requires binding to 127.0.0.1 (got EVENTFLOW_HOST={self.host!r})."
            )
        return self


def _flag(value: str | None) -> bool:
    return (value or "").strip().lower() == "true"


def load_settings(environ=None) -> Settings:
    env = os.environ if environ is None else environ
    return Settings(
        env=(env.get("EVENTFLOW_ENV") or "production").strip().lower(),
        dev_identity=_flag(env.get("EVENTFLOW_DEV_IDENTITY")),
        database_url=env.get("DATABASE_URL") or DEFAULT_DATABASE_URL,
        host=(env.get("EVENTFLOW_HOST") or "127.0.0.1").strip(),
        files_dir=env.get("EVENTFLOW_FILES_DIR") or DEFAULT_FILES_DIR,
        presentation=_flag(env.get("EVENTFLOW_PRESENTATION")),
        test_copy=_flag(env.get("EVENTFLOW_TEST_COPY")),
    ).validate()
