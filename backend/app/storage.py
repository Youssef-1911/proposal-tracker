"""
File storage for proposal files, behind a small interface so it can move to cloud storage
(e.g. S3) later without changing any other code.

Rules every implementation keeps:
- Keys are random and generated here (never the uploaded file name), so a name can never
  be used as a path.
- Nothing here is served over HTTP; files only leave through the permission-checked
  download endpoint.
- delete() exists only to clean up files whose database row was never saved (orphans).
  There is no API route that deletes a proposal file.
"""

import os
import re
import secrets
import tempfile
from pathlib import Path
from typing import Iterator, Protocol

KEY_PATTERN = re.compile(r"[0-9a-f]{32}")


class FileStorage(Protocol):
    def save(self, data: bytes) -> str: ...
    def read(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...
    def keys(self) -> Iterator[str]: ...


class LocalFileStorage:
    """Files on local disk under `root`, as root/ab/abcdef... (two-level fan-out)."""

    def __init__(self, root: str | Path):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        if not KEY_PATTERN.fullmatch(key):  # defence in depth: keys are only ever ours
            raise ValueError("Invalid storage key.")
        return self.root / key[:2] / key

    def save(self, data: bytes) -> str:
        key = secrets.token_hex(16)
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temporary file in the same folder, then rename: a crash never leaves half a file.
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".upload-")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        return key

    def read(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def keys(self) -> Iterator[str]:
        if not self.root.is_dir():
            return
        for path in self.root.glob("*/*"):
            if path.is_file() and KEY_PATTERN.fullmatch(path.name):
                yield path.name
