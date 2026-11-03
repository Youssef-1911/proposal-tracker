"""
The persistent TEST copy of the real data:  python -m app.test_copy [--fresh]

The first time, the real database is copied (opened read-only, never written) to backend/eventflow-test.db
(and its proposal files to storage/proposal-files-test). After that the SAME file is reused on every start,
so work done on it stays; it is only brought up to the latest migration. --fresh replaces it with a new copy.
start-dev.ps1 -Data test runs this, then opens the app on it ("Test copy" in the header).
Every data command (apply_tracker_mapping, check_tracker, check_users) runs with --target test on this file.
"""

import argparse
import sys
from pathlib import Path

from alembic import command

from .migrations_check import alembic_config
from .present_copy import REAL_DB, REAL_FILES, make_copy
from .settings import BACKEND_DIR

TEST_DB = Path(BACKEND_DIR) / "eventflow-test.db"
TEST_FILES = Path(BACKEND_DIR) / "storage" / "proposal-files-test"


def test_url(path: Path = TEST_DB) -> str:
    return "sqlite:///" + path.as_posix()


def ensure_copy(fresh: bool = False, real_db: Path = REAL_DB, test_db: Path = TEST_DB, real_files: Path = REAL_FILES,
                test_files: Path = TEST_FILES) -> str:
    if fresh or not test_db.exists():
        make_copy(real_db, test_db, real_files, test_files)
        return f"Test copy made: {test_db.name} (from {real_db.name}, which was not changed). It is kept from now on."
    test_files.mkdir(parents=True, exist_ok=True)
    command.upgrade(alembic_config(test_url(test_db)), "head")  # the COPY only; its data stays
    return f"Test copy reused: {test_db.name} (your work on it is kept; --fresh replaces it)."


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.test_copy", description="The persistent test copy.")
    parser.add_argument("--fresh", action="store_true", help="replace it with a new copy of the real data")
    print(ensure_copy(fresh=parser.parse_args(argv).fresh))
    return 0


if __name__ == "__main__":
    sys.exit(main())
