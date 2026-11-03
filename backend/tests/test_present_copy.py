"""
start-dev.ps1 -Data present (python -m app.present_copy) on TEMPORARY files, never the real database:
the source is only read (unchanged byte for byte), the copy is migrated, running it again replaces it.
"""

import hashlib
import sqlite3
from contextlib import closing

from app.migrations_check import head_revision
from app.present_copy import make_copy
from app.setup_real import setup_real

from .conftest import sqlite_url
from .test_import_tracker import NOW


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_the_copy_is_fresh_migrated_and_the_source_untouched(tmp_path):
    real = tmp_path / "real.db"
    setup_real(sqlite_url(real), now=NOW)
    files = tmp_path / "files-real"
    files.mkdir()
    (files / "a.pdf").write_bytes(b"%PDF-1.4 test")
    before = digest(real)
    copy = tmp_path / "present.db"

    message = make_copy(real, copy, files, tmp_path / "files-present")
    assert "was not changed" in message
    assert digest(real) == before, "the real file is only read"
    assert (tmp_path / "files-present" / "a.pdf").read_bytes() == b"%PDF-1.4 test"
    with closing(sqlite3.connect(copy)) as c:
        assert c.execute("select version_num from alembic_version").fetchone()[0] == head_revision(sqlite_url(copy))
        c.execute("insert into app_meta (key, value, updated_at) values ('marker', 'changed in the copy', '2026-10-22')")
        c.commit()

    make_copy(real, copy, files, tmp_path / "files-present")  # again: a fresh copy
    with closing(sqlite3.connect(copy)) as c:
        assert c.execute("select count(*) from app_meta where key = 'marker'").fetchone()[0] == 0
    assert digest(real) == before
