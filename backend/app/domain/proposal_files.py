"""
Proposal files and comments. Port of the frontend's domain/proposalFiles.js (upload
eligibility, download name, comment validation; same wording, checked by the contract), plus
the server-only check of the REAL file type from the content.

Pure functions: no database, no storage.
"""

import io
import re
import unicodedata
import zipfile

from ..config_domain import (
    ACCOUNT_MANAGER, COMMENT_MAX_LENGTH, COMMERCIAL_HEAD, PROPOSAL_FILE_MAX_BYTES, UPLOAD_STATUSES,
)
from .permissions import ASSIGNED_AM, check_actors
from .access import can_see_request
from .rules import has_proposal_file
from .views import RequestView


def is_version_locked(r: RequestView, version: int) -> bool:
    """A version is locked once it has been marked Ready for BD."""
    return any(e.status == "ready_for_bd" and e.version == version for e in r.history)


def upload_target(r: RequestView, viewer, users: dict) -> dict:
    """
    May this viewer upload the proposal file now, and for which version?
    -> {allowed, code, reason, version, replaces, startsWork}; code: not_found / invalid_transition / forbidden.
    startsWork: the request is Submitted, so the upload also moves it to In Progress.
    """
    def deny(code, reason, version=None):
        return {"allowed": False, "code": code, "reason": reason, "version": version, "replaces": False,
                "startsWork": False}

    if not can_see_request(r, viewer, users):
        return deny("not_found", f"Request {r.id} not found.")
    if r.status not in UPLOAD_STATUSES:
        return deny("invalid_transition", "Proposal files can only be uploaded while the request is with the AM "
                                          "(Submitted, In Progress, Awaiting BD Information or Revision Requested).")
    version = r.version + 1 if r.status == "revision_requested" else r.version
    permission = check_actors([ASSIGNED_AM], r, viewer, users)
    if not permission["allowed"]:
        return deny("forbidden", permission["reason"], version)
    if is_version_locked(r, version):
        return deny("invalid_transition", f"Version {version} was marked Ready for BD, so its file is locked. "
                                          f"Request a revision to prepare version {version + 1}.", version)
    return {"allowed": True, "code": None, "reason": None, "version": version,
            "replaces": has_proposal_file(r, version), "startsWork": r.status == "submitted"}


def can_see_replaced_files(r: RequestView, viewer) -> bool:
    """Files replaced before Ready for BD: only the assigned AM (acting as AM) and the Commercial Head."""
    return viewer.active_role == COMMERCIAL_HEAD or (
        viewer.user_id == r.assigned_am and viewer.active_role == ACCOUNT_MANAGER)


def download_file_name(request_id: str, client_name: str | None, version: int, file_type: str) -> str:
    """'PR-2026-0042_Papyrus_Fintech_v2.pdf': letters, digits, dashes and underscores only."""
    client = re.sub(r"[^A-Za-z0-9]+", "_", client_name or "").strip("_")[:60] or "Client"
    return f"{request_id}_{client}_v{version}.{file_type}"


# ---------------------------------------------------------------------------
# Checking the real file type (server only)
# ---------------------------------------------------------------------------

TYPE_ERROR = ("Only PDF (.pdf) and PowerPoint (.pptx) files can be uploaded, and the file's content must "
              "really be that type. This file is not a valid PDF or PowerPoint file.")
MIME = {"pdf": "application/pdf",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}


def _looks_like_pdf(data: bytes) -> bool:
    # The PDF header must be at the very start (leading junk is how polyglot files hide).
    return data.startswith(b"%PDF-") and b"%%EOF" in data[-2048:]


def _looks_like_pptx(data: bytes) -> bool:
    if not data.startswith(b"PK\x03\x04"):
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = set(z.namelist())
            if "[Content_Types].xml" not in names or "ppt/presentation.xml" not in names:
                return False
            info = z.getinfo("[Content_Types].xml")
            if info.file_size > 1_000_000:  # never decompress anything large just to check the type
                return False
            return b"presentationml.presentation.main+xml" in z.read(info)
    except (zipfile.BadZipFile, KeyError, RuntimeError, NotImplementedError, OSError):
        return False


def detect_file_type(data: bytes, file_name: str) -> tuple[str | None, str | None]:
    """
    (file_type, None) when the extension is .pdf/.pptx AND the content really is that type;
    (None, error message) otherwise. The browser's claimed type is never trusted.
    """
    if not data:
        return None, "The file is empty."
    if len(data) > PROPOSAL_FILE_MAX_BYTES:
        return None, "The file is larger than 25 MB."
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    if ext == "pdf" and _looks_like_pdf(data):
        return "pdf", None
    if ext == "pptx" and _looks_like_pptx(data):
        return "pptx", None
    return None, TYPE_ERROR


def clean_original_name(name: str) -> str:
    """The uploaded name, kept for display only: no folders, no control characters, at most 255 characters."""
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(ch for ch in name if unicodedata.category(ch)[0] != "C").strip()
    return name[:255] or "proposal"


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------

def validate_comment(body) -> dict:
    """Plain text, 1 to 2,000 characters after trimming. -> {"errors", "body"}"""
    text = body.strip() if isinstance(body, str) else ""
    if not text:
        return {"errors": {"body": "Write a comment first."}, "body": None}
    if len(text) > COMMENT_MAX_LENGTH:
        return {"errors": {"body": f"Comments can be up to 2,000 characters (this one has {len(text)})."}, "body": None}
    return {"errors": {}, "body": text}
