"""
A presentation copy of the real data:  python -m app.present_copy

Copies backend/eventflow-real.db to backend/eventflow-present.db (and the real proposal files to
storage/proposal-files-present), then brings the COPY up to the latest migration. The real file is
opened read-only and never written. Running it again replaces the copy with a fresh one.
start-dev.ps1 -Data present runs this, then opens the app on the copy ("Presentation copy" in the header).
"""

import shutil
import sqlite3
import sys
from pathlib import Path

from alembic import command

from .migrations_check import alembic_config
from .settings import BACKEND_DIR

REAL_DB = Path(BACKEND_DIR) / "eventflow-real.db"
COPY_DB = Path(BACKEND_DIR) / "eventflow-present.db"
REAL_FILES = Path(BACKEND_DIR) / "storage" / "proposal-files-real"
COPY_FILES = Path(BACKEND_DIR) / "storage" / "proposal-files-present"


def copy_url() -> str:
    return "sqlite:///" + COPY_DB.as_posix()


def make_copy(real_db: Path = REAL_DB, copy_db: Path = COPY_DB, real_files: Path = REAL_FILES,
              copy_files: Path = COPY_FILES) -> str:
    if not real_db.exists():
        raise SystemExit(f"No real database at {real_db}. Run ./start-dev.ps1 (real data) first.")
    if real_db.resolve() == copy_db.resolve():
        raise SystemExit("The copy must be a different file from the real database.")
    for leftover in (copy_db, copy_db.with_name(copy_db.name + "-wal"), copy_db.with_name(copy_db.name + "-shm")):
        leftover.unlink(missing_ok=True)
    source = sqlite3.connect(f"file:{real_db.as_posix()}?mode=ro", uri=True)  # read-only: never writes the real file
    target = sqlite3.connect(copy_db)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    if copy_files.exists():
        shutil.rmtree(copy_files)
    if real_files.exists():
        shutil.copytree(real_files, copy_files)
    else:
        copy_files.mkdir(parents=True, exist_ok=True)
    command.upgrade(alembic_config("sqlite:///" + copy_db.as_posix()), "head")  # the COPY only
    return f"Presentation copy ready: {copy_db.name} (from {real_db.name}, which was not changed)."


def main() -> int:
    print(make_copy())
    return 0


if __name__ == "__main__":
    sys.exit(main())
