"""
Proposal file uploads and request comments.

Upload = file bytes in storage + one proposal_files row + the request's lastUpdated/rowVersion,
all or nothing:
- the bytes are saved only after every check has passed;
- if anything fails after saving (database flush, or the router's commit), the saved bytes
  are deleted again (see discard_saved_file);
- sweep_orphan_files() removes bytes that have no database row (e.g. after a crash between
  saving and committing).
Nothing here commits; the router commits once.
"""

import hashlib
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..domain.proposal_files import clean_original_name, detect_file_type, upload_target, validate_comment
from ..domain.views import request_from_orm
from ..domain import conversation
from ..errors import forbidden, validation
from .lists import load_lists
from ..identity import Actor
from ..models import ProposalFile, ProposalRequest, RequestComment
from ..storage import FileStorage
from .proposal_requests import _users, perform_action, raise_failure


@dataclass
class Upload:
    """The request body of an upload, read with a hard size limit."""
    file_name: str
    data: bytes | None  # None when the body was larger than the limit (reading stopped there)
    too_large: bool = False


def upload_proposal_file(db: Session, storage: FileStorage, actor: Actor, row: ProposalRequest, upload: Upload,
                         now: datetime) -> dict:
    """Checks, stores and records one upload for the version being prepared. Returns {file, message, storage_key}."""
    target = upload_target(request_from_orm(row), actor, _users(db))
    if not target["allowed"]:
        raise_failure({**target, "error": target["reason"], "errors": {}})

    version = target["version"]
    result = store_file(db, storage, actor, row, upload, version=version, now=now)
    record, key, previous = result["file"], result["storage_key"], result["replaces"]
    try:
        # Uploading while Submitted ("New") also starts work: In Progress, with its own history entry,
        # in the same transaction. An upload never marks a proposal Ready for BD.
        started = perform_action(db, actor, row, "start_work", {}, now) if target["startsWork"] else None
    except BaseException:
        storage.delete(key)
        raise
    verb = "replaced" if previous else "uploaded"
    message = f"Proposal file for version {version} {verb}."
    if started:
        message = f"{message} {started['message']}"
    return {"file": record, "storage_key": key, "message": message, "warnings": []}


def store_file(db: Session, storage: FileStorage, actor: Actor, row: ProposalRequest, upload: Upload, *, version: int,
               now: datetime) -> dict:
    """Checks one upload (size, name, PDF or PowerPoint) and records it for a version. Who may upload is the caller's check."""
    if upload.too_large:
        raise validation("Please fix the highlighted fields.", {"file": "The file is larger than 25 MB."})
    if not upload.file_name.strip():
        raise validation("Please fix the highlighted fields.", {
            "file": "Send the file name in the X-File-Name header (URL-encoded)."})
    file_type, error = detect_file_type(upload.data or b"", upload.file_name)
    if error:
        raise validation("Please fix the highlighted fields.", {"file": error})
    previous = next((f for f in reversed(row.files) if f.version == version), None)
    key = storage.save(upload.data)
    try:
        record = ProposalFile(
            version=version, storage_key=key, file_type=file_type,
            original_name=clean_original_name(upload.file_name), size_bytes=len(upload.data),
            sha256=hashlib.sha256(upload.data).hexdigest(), uploaded_by_id=actor.user_id, role=actor.active_role,
            uploaded_at=now, replaces_file_id=previous.id if previous else None,
        )
        row.files.append(record)
        row.last_updated = now
        row.updated_at = now
        db.flush()  # row_version check happens here (StaleDataError -> 409)
    except BaseException:
        storage.delete(key)
        raise
    return {"file": record, "storage_key": key, "replaces": previous}


def discard_saved_file(storage: FileStorage, key: str | None) -> None:
    """Called when the transaction that recorded an upload did not commit."""
    if key:
        storage.delete(key)


def sweep_orphan_files(db: Session, storage: FileStorage) -> list[str]:
    """Deletes stored files that no proposal_files row refers to. Returns the deleted keys."""
    known = set(db.scalars(select(ProposalFile.storage_key)).all())
    orphans = [k for k in storage.keys() if k not in known]
    for key in orphans:
        storage.delete(key)
    return orphans


def visible_files(files: list[ProposalFile], see_replaced: bool) -> list[ProposalFile]:
    """Every file for the assigned AM and the Commercial Head; each version's current file for everyone else."""
    current = current_file_ids(files)
    return [f for f in files if see_replaced or f.id in current]


def current_file_ids(files: list[ProposalFile]) -> set[int]:
    """The latest upload per version is that version's current file."""
    latest: dict[int, ProposalFile] = {}
    for f in files:
        if f.version not in latest or f.id > latest[f.version].id:
            latest[f.version] = f
    return {f.id for f in latest.values()}


def add_comment(db: Session, actor: Actor, row: ProposalRequest, body, now: datetime, *, kind=None, about=None,
                parent_id=None, reasons=None, new_required_by=None, notify: bool = True) -> RequestComment:
    """A comment (anyone who sees the request), or a question / answer / "Mark as answered" (domain/conversation.py)."""
    if kind in (None, "comment"):
        checked = validate_comment(body)
        if checked["errors"]:
            raise validation("Please fix the highlighted fields.", checked["errors"])
        values = {"kind": "comment", "body": checked["body"], "about": None, "parentId": None, "reasons": None}
    else:
        permission = conversation.can_post_message(kind, request_from_orm(row), actor, _users(db))
        if not permission["allowed"]:
            raise forbidden(permission["reason"])
        messages = [{"id": c.id, "kind": c.kind, "parentId": c.parent_id} for c in row.comments]
        checked = conversation.validate_message({"kind": kind, "body": body, "about": about, "parentId": parent_id,
                                                 "reasons": reasons}, lists=load_lists(db), messages=messages)
        if checked["errors"]:
            raise validation("Please fix the highlighted fields.", checked["errors"])
        values = checked["values"]
    comment = RequestComment(request_id=row.id, author_id=actor.user_id, role=actor.active_role, body=values["body"],
                             created_at=now, kind=values["kind"], about=values["about"], parent_id=values["parentId"],
                             reasons=values["reasons"])
    db.add(comment)
    db.flush()
    if values["kind"] == "change":
        _apply_change(db, actor, row, values, new_required_by, now)
    if notify:
        from .notifications import notify_new_activity  # here: notifications imports this module
        notify_new_activity(db, row, now)
    return comment


def _apply_change(db: Session, actor: Actor, row: ProposalRequest, values: dict, new_required_by, now: datetime) -> None:
    """
    "Change needed" in the same transaction: before the client has it (Ready for BD) the proposal goes back to
    the AM as an internal change; once shared, it is recorded as a client revision (a new deadline is needed).
    Earlier (the AM is still preparing it) it is only the card the AM picks up.
    """
    note = None if values["body"] == "Change needed" else values["body"]
    if row.status == "ready_for_bd":
        perform_action(db, actor, row, "request_changes", {"reasons": values["reasons"], "note": note}, now)
    elif row.status in ("shared_with_client", "postponed"):
        if row.status == "postponed":
            perform_action(db, actor, row, "resume", {}, now)
        perform_action(db, actor, row, "request_revision",
                       {"reasons": values["reasons"], "note": note, "newRequiredBy": new_required_by}, now)
