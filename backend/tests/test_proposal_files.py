"""
Phase 3B: proposal files (seeded demo database, real local file storage in a temp folder).

Upload rules (who, when, which version, real file type, 25 MB), replace-before-ready, lock at
Ready for BD, Mark ready preconditions, downloads (permission-checked, attachment, safe name),
old versions after a revision, orphan clean-up and append-only rows.
"""

import hashlib
import io
import zipfile

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DatabaseError

from app.models import ProposalFile, ProposalRequest
from app.services import proposal_files as files_service

from .conftest import AHMED, MD_AM, MK_AM, MK_BD, NOHA, SHERINE, as_user, pr
from .write_helpers import act, detail, error, ok, row_version, sample_pdf, sample_pptx, upload

ABDELRAHMAN = as_user("u-abdelrahman", "business_development")
ALL_VIEWERS = [NOHA, AHMED, SHERINE, MK_BD, MK_AM, MD_AM, ABDELRAHMAN]


def storage(api):
    return api.app.state.storage


def file_rows(session):
    session.expire_all()
    return session.scalar(select(func.count()).select_from(ProposalFile))


# ---------------------------------------------------------------------------
# Uploading
# ---------------------------------------------------------------------------

def test_upload_pdf_and_pptx_succeed(api, session):
    rid = pr(14)  # In Progress, Grasshoppers, AM Mariam El Khayat, no file yet
    before_version = row_version(api, rid, MK_AM)
    out = ok(upload(api, rid, MK_AM, name="Grade 5 science trip.pdf"))
    f = out["file"]
    assert (f["version"], f["fileType"], f["originalName"], f["current"], f["replacesFileId"]) == (
        1, "pdf", "Grade 5 science trip.pdf", True, None)
    assert f["uploadedBy"] == "u-mariam-elkhayat" and f["role"] == "account_manager"
    client = "_".join(out["request"]["clientName"].split())
    assert f["downloadName"] == f"{rid}_{client}_v1.pdf"
    assert out["message"] == "Proposal file for version 1 uploaded."
    assert out["request"]["rowVersion"] == before_version + 1, "an upload is a change to the request"
    assert out["request"]["upload"]["replaces"] is True, "uploading again would replace it"

    pptx = ok(upload(api, pr(15), MD_AM, data=sample_pptx(), name="Leadership day.pptx"))  # Team Up, AM Mariam Dimitri
    assert pptx["file"]["fileType"] == "pptx" and pptx["file"]["downloadName"].endswith("_v1.pptx")


@pytest.mark.parametrize("name,data,why", [
    ("proposal.pdf", b"MZ\x90\x00\x03" + b"\x00" * 2000, "a Windows program renamed to .pdf"),
    ("proposal.pdf", b"Dear client, here is our offer.\n" * 20, "a text file renamed to .pdf"),
    ("proposal.pptx", b"PK\x03\x04" + b"\x00" * 200, "a broken zip renamed to .pptx"),
    ("proposal.exe", None, "a real PDF with an .exe name"),
    ("proposal.pptx", None, "a real PDF named .pptx"),
    ("proposal", None, "no extension"),
    ("proposal.pdf", b"MZ\x90\x00" + sample_pdf(), "a PDF hidden after other content"),
])
def test_wrong_file_types_are_rejected_by_content(api, session, name, data, why):
    keys = set(storage(api).keys())
    rows = file_rows(session)
    r = upload(api, pr(14), MK_AM, data=data, name=name, content_type="application/pdf")  # claimed type is ignored
    assert r.status_code == 422, why
    assert "Only PDF (.pdf) and PowerPoint (.pptx) files can be uploaded" in error(r)["fields"]["file"], why
    assert set(storage(api).keys()) == keys and file_rows(session) == rows, "nothing stored"


def test_a_zip_that_is_not_a_presentation_is_rejected(api):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", "<w:document/>")
        z.writestr("[Content_Types].xml", "wordprocessingml")
    r = upload(api, pr(14), MK_AM, data=buf.getvalue(), name="proposal.pptx")
    assert r.status_code == 422


def test_files_over_25_mb_and_empty_files_are_rejected(api, session):
    keys = set(storage(api).keys())
    big = sample_pdf() + b"0" * (25 * 1024 * 1024)
    r = upload(api, pr(14), MK_AM, data=big)
    assert (r.status_code, error(r)["fields"]) == (422, {"file": "The file is larger than 25 MB."})
    exactly = b"%PDF-1.4\n" + b"0" * (25 * 1024 * 1024 - 9 - 6) + b"%%EOF\n"
    assert len(exactly) == 25 * 1024 * 1024
    assert upload(api, pr(14), MK_AM, data=exactly).status_code == 201, "25 MB exactly is allowed"
    empty = upload(api, pr(15), MD_AM, data=b"")
    assert (empty.status_code, error(empty)["fields"]) == (422, {"file": "The file is empty."})
    assert len(set(storage(api).keys()) - keys) == 1


def test_only_the_assigned_am_can_upload(api):
    rid = pr(14)  # AM Mariam El Khayat; BD owner Sherine
    for who, reason in [
        (SHERINE, "Only the assigned Account Manager, Mariam El Khayat, can do this."),
        (NOHA, "Only the assigned Account Manager, Mariam El Khayat, can do this."),
    ]:
        r = upload(api, rid, who)
        assert (r.status_code, error(r)) == (403, {"code": "forbidden", "message": reason}), who
    # The Team Up AM does not see this Grasshoppers request at all (no "See all brands").
    assert upload(api, rid, MD_AM).status_code == 404
    own = upload(api, pr(16), MK_BD)  # her own request, but acting as BD
    assert own.status_code == 403
    assert error(own)["message"] == ("You are acting as Business Development. Switch your active role to "
                                     "Account Manager — Grasshoppers to do this.")
    assert detail(api, rid, SHERINE)["upload"] == {
        "allowed": False, "code": "forbidden", "reason": "Only the assigned Account Manager, Mariam El Khayat, can do this.",
        "version": 1, "replaces": False, "startsWork": False}


def test_upload_only_while_with_the_am_and_hidden_drafts_are_404(api):
    for rid, who in ((pr(10), MD_AM), (pr(7), MK_AM), (pr(2), MK_AM)):  # ready, shared, accepted
        r = upload(api, rid, who)
        assert (r.status_code, error(r)["code"]) == (409, "invalid_transition"), rid
        assert "only be uploaded while the request is with the AM" in error(r)["message"]
    hidden = upload(api, pr(19), MD_AM, version=1)  # Ahmed's draft
    missing = upload(api, "PR-1999-0001", MD_AM, version=1)
    assert hidden.status_code == missing.status_code == 404


def test_upload_needs_the_current_row_version(api):
    r = api.post(f"/api/proposal-requests/{pr(14)}/files", content=sample_pdf(),
                 headers={**MK_AM, "X-File-Name": "p.pdf"})
    assert r.status_code == 422 and "expectedRowVersion" in error(r)["fields"]
    stale = upload(api, pr(14), MK_AM, version=99)
    assert (stale.status_code, error(stale)["code"]) == (409, "stale")
    no_name = api.post(f"/api/proposal-requests/{pr(14)}/files", params={"expectedRowVersion": 1}, content=sample_pdf(),
                       headers=MK_AM)
    assert no_name.status_code == 422 and "X-File-Name" in error(no_name)["fields"]["file"]


def test_uploaded_names_are_never_used_as_paths(api, session):
    out = ok(upload(api, pr(14), MK_AM, name="..\\..\\..\\etc/passwd\x00.pdf"))
    assert out["file"]["originalName"] == "passwd.pdf", "folders and control characters removed (display only)"
    session.expire_all()
    key = session.get(ProposalFile, out["file"]["id"]).storage_key
    root = storage(api).root.resolve()
    stored = [p for p in root.rglob("*") if p.is_file() and p.name == key]
    assert len(key) == 32 and all(c in "0123456789abcdef" for c in key), "random server-generated name"
    assert len(stored) == 1 and stored[0].resolve().is_relative_to(root)
    assert not any("passwd" in p.name for p in root.rglob("*"))


def test_uploading_again_before_ready_replaces_the_file_and_keeps_its_history(api):
    first = ok(upload(api, pr(14), MK_AM, name="draft v1.pdf"))["file"]
    second = ok(upload(api, pr(14), MK_AM, data=sample_pdf("second"), name="final v1.pdf"))
    assert second["message"] == "Proposal file for version 1 replaced."
    files = second["request"]["files"]
    assert [(f["id"], f["originalName"], f["current"], f["replacesFileId"]) for f in files] == [
        (first["id"], "draft v1.pdf", False, None), (second["file"]["id"], "final v1.pdf", True, first["id"])]
    # Both stay downloadable (nothing is ever deleted).
    assert api.get(first["downloadUrl"], headers=NOHA).content == sample_pdf(pr(14))
    assert api.get(second["file"]["downloadUrl"], headers=NOHA).content == sample_pdf("second")


# ---------------------------------------------------------------------------
# Marking ready, locking, revisions
# ---------------------------------------------------------------------------

def test_mark_ready_needs_the_file_then_the_price(api):
    rid = pr(14)
    ready = next(a for a in detail(api, rid, MK_AM)["allowedActions"] if a["action"] == "mark_ready")
    assert (ready["allowed"], ready["reason"]) == (False, "Upload the proposal file before marking it ready.")
    blocked = act(api, rid, "mark_ready", MK_AM, amPrice=90000)
    assert (blocked.status_code, error(blocked)) == (409, {"code": "precondition_failed",
                                                          "message": "Upload the proposal file before marking it ready."})
    ok(upload(api, rid, MK_AM))
    assert next(a for a in detail(api, rid, MK_AM)["allowedActions"] if a["action"] == "mark_ready")["allowed"] is True
    no_price = act(api, rid, "mark_ready", MK_AM)
    assert (no_price.status_code, error(no_price)["fields"]) == (422, {"amPrice": "Enter the AM price in EGP."})
    out = ok(act(api, rid, "mark_ready", MK_AM, amPrice=99000))["request"]  # 110 participants
    assert (out["amPrice"], out["amPricePerParticipant"]) == (99000, 900)
    assert (out["versions"][0]["pricePerParticipant"], out["versions"][0]["hasFile"]) == (900, True)


def test_version_2_needs_a_what_changed_note_and_old_versions_stay_downloadable(api):
    rid = pr(6)  # Revision Requested, Team Up, v1 ready (demo file), 100 participants
    v1 = detail(api, rid, NOHA)["files"]
    assert [(f["version"], f["current"]) for f in v1] == [(1, True)]
    target = detail(api, rid, MD_AM)["upload"]
    assert (target["allowed"], target["version"]) == (True, 2), "a revision prepares the next version"
    ok(upload(api, rid, MD_AM, name="v2 half day.pdf"))
    ok(act(api, rid, "start_revision", MD_AM))
    ready = next(a for a in detail(api, rid, MD_AM)["allowedActions"] if a["action"] == "mark_ready")
    assert (ready["requires"], ready["notePrompt"]) == ({"amPrice": True, "note": True}, "What changed in this version?")
    missing = act(api, rid, "mark_ready", MD_AM, amPrice=196000)
    assert error(missing)["fields"] == {
        "note": 'Describe what changed in this version, e.g. "Removed transport, price down EGP 40,000".'}
    out = ok(act(api, rid, "mark_ready", MD_AM, amPrice=196000, note="Half day, price down EGP 40,000"))["request"]
    v = {x["version"]: x for x in out["versions"]}
    assert (v[2]["changeNote"], v[2]["pricePerParticipant"], v[2]["hasFile"]) == ("Half day, price down EGP 40,000", 1960, True)
    assert (v[1]["amPrice"], v[1]["hasFile"]) == (236000, True)
    # Version 1's file is still there and downloadable after the revision.
    old = next(f for f in out["files"] if f["version"] == 1)
    r = api.get(old["downloadUrl"], headers=AHMED)
    assert r.status_code == 200 and r.content.startswith(b"%PDF-")
    # Version 2 is now locked: no more uploads until another revision.
    locked = upload(api, rid, MD_AM)
    assert locked.status_code == 409


def test_a_ready_version_is_locked(api):
    rid = pr(14)
    ok(upload(api, rid, MK_AM))
    ok(act(api, rid, "mark_ready", MK_AM, amPrice=99000))
    r = upload(api, rid, MK_AM)
    assert (r.status_code, error(r)["code"]) == (409, "invalid_transition")


def test_sharing_records_the_version_and_channel(api):
    out = ok(act(api, pr(10), "share_with_client", ABDELRAHMAN, confirmShared=True, channel="whatsapp"))["request"]
    entry = out["history"][-1]
    assert (entry["status"], entry["version"], entry["channel"]) == ("shared_with_client", 1, "whatsapp")
    assert out["sharedAt"] == entry["changedAt"] and out["daysSinceShared"] == 0
    assert out["stageSince"] == entry["changedAt"] and out["daysInStage"] == 0


# ---------------------------------------------------------------------------
# Downloads
# ---------------------------------------------------------------------------

def test_downloads_for_every_viewer_as_attachment_with_a_safe_name(api):
    d = detail(api, pr(10), NOHA)  # Ready for BD, demo file v1, client "Obelisk Telecom"
    f = d["files"][0]
    for who in ALL_VIEWERS:  # a Team Up request: the Grasshoppers AM does not see it (no "See all brands")
        expected = 404 if who == MK_AM else 200
        assert api.get(f["downloadUrl"], headers=who).status_code == expected, who
    r = api.get(f["downloadUrl"], headers=as_user("u-doaa", "executive"))  # Executives may download
    assert r.status_code == 200
    assert r.headers["content-disposition"] == f'attachment; filename="{f["downloadName"]}"'
    assert f["downloadName"] == f"{pr(10)}_{d['clientName'].replace(' ', '_')}_v1.pdf"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert r.headers["content-type"] == "application/pdf"
    assert hashlib.sha256(r.content).hexdigest() == f["sha256"]


def test_downloads_of_hidden_drafts_or_other_requests_files_are_404(api):
    f = detail(api, pr(10), NOHA)["files"][0]
    assert api.get(f"/api/proposal-requests/{pr(19)}/files/{f['id']}", headers=NOHA).status_code == 404, "hidden draft"
    assert api.get(f"/api/proposal-requests/{pr(7)}/files/{f['id']}", headers=NOHA).status_code == 404, "not its file"
    assert api.get(f"/api/proposal-requests/{pr(10)}/files/999999", headers=NOHA).status_code == 404


def test_seeded_demo_files_are_real_pdfs(api, session):
    keys = set(session.scalars(select(ProposalFile.storage_key)).all())
    assert keys and keys == set(storage(api).keys())
    for f in detail(api, pr(2), NOHA)["files"]:  # accepted after a revision: v1 and v2
        r = api.get(f["downloadUrl"], headers=NOHA)
        assert r.content.startswith(b"%PDF-1.4") and r.content.rstrip().endswith(b"%%EOF")
    assert [f["version"] for f in detail(api, pr(2), NOHA)["files"]] == [1, 2]


# ---------------------------------------------------------------------------
# All or nothing: no orphan files, no half-saved rows
# ---------------------------------------------------------------------------

def test_database_failure_after_saving_the_file_removes_the_file(api, session, monkeypatch):
    from sqlalchemy.orm import Session
    keys, rows, version = set(storage(api).keys()), file_rows(session), row_version(api, pr(14), MK_AM)

    def failing_commit(self):
        raise RuntimeError("injected commit failure")
    monkeypatch.setattr(Session, "commit", failing_commit)
    with pytest.raises(RuntimeError, match="injected commit failure"):
        upload(api, pr(14), MK_AM, version=version)
    monkeypatch.undo()
    assert set(storage(api).keys()) == keys, "the saved file was deleted again"
    assert file_rows(session) == rows
    assert row_version(api, pr(14), MK_AM) == version


def test_failure_while_recording_the_upload_removes_the_file(api, session, monkeypatch):
    keys, rows = set(storage(api).keys()), file_rows(session)

    def broken(*args, **kwargs):
        raise RuntimeError("injected failure while recording")
    monkeypatch.setattr(files_service, "ProposalFile", broken)
    with pytest.raises(RuntimeError, match="injected failure while recording"):
        upload(api, pr(14), MK_AM)
    assert set(storage(api).keys()) == keys and file_rows(session) == rows


def test_storage_failure_saves_nothing_in_the_database(api, session, monkeypatch):
    rows, version = file_rows(session), row_version(api, pr(14), MK_AM)

    def disk_full(data):
        raise OSError("injected: disk full")
    monkeypatch.setattr(storage(api), "save", disk_full)
    with pytest.raises(OSError, match="disk full"):
        upload(api, pr(14), MK_AM, version=version)
    assert file_rows(session) == rows and row_version(api, pr(14), MK_AM) == version


def test_sweep_removes_only_orphan_files(api, session):
    ok(upload(api, pr(14), MK_AM))
    stray = storage(api).save(b"%PDF-1.4 left behind by a crash %%EOF")
    referenced = set(session.scalars(select(ProposalFile.storage_key)).all())
    removed = files_service.sweep_orphan_files(session, storage(api))
    assert removed == [stray]
    assert set(storage(api).keys()) == referenced


def test_file_rows_are_append_only_in_the_database(api, engine):
    ok(upload(api, pr(14), MK_AM))
    for sql in ("UPDATE proposal_files SET original_name = 'x'", "DELETE FROM proposal_files"):
        with engine.connect() as conn:
            with pytest.raises(DatabaseError, match="append-only"):
                conn.execute(text(sql))
            conn.rollback()


def test_no_route_deletes_or_edits_files(api):
    f = detail(api, pr(10), NOHA)["files"][0]
    for method in ("delete", "put", "patch"):
        assert getattr(api, method)(f["downloadUrl"], headers=MD_AM).status_code == 405


def test_counters_are_returned_with_every_request(api):
    items = api.get("/api/proposal-requests", params={"pageSize": 100}, headers=NOHA).json()["items"]
    for i in items:
        assert {"stageSince", "daysInStage", "sharedAt", "daysSinceShared", "amPricePerParticipant"} <= set(i)
    shared = next(i for i in items if i["id"] == pr(7))
    assert shared["daysSinceShared"] == shared["daysInStage"] and shared["sharedAt"] == shared["stageSince"]
    assert next(i for i in items if i["id"] == pr(13))["daysSinceShared"] is None, "only while with the client"


def test_seeded_rows_are_consistent(session):
    session.expire_all()
    for r in session.scalars(select(ProposalRequest)).all():
        ready_versions = {e.version for e in r.history if e.status == "ready_for_bd"}
        assert ready_versions <= {f.version for f in r.files}, f"{r.id}: every Ready version has its file"


# ---------------------------------------------------------------------------
# Phase 4A decisions
# ---------------------------------------------------------------------------

def test_uploading_while_submitted_starts_work_in_the_same_transaction(api):
    rid = pr(16)  # Submitted ("New"), Grasshoppers, AM Mariam El Khayat
    assert detail(api, rid, MK_AM)["upload"]["startsWork"] is True
    out = ok(upload(api, rid, MK_AM))
    r = out["request"]
    assert (r["status"], r["subLabel"]) == ("in_progress", "Preparing")
    last = r["history"][-1]
    assert (last["status"], last["changedBy"], last["role"], last["version"]) == (
        "in_progress", "u-mariam-elkhayat", "account_manager", 1)
    assert out["message"] == f"Proposal file for version 1 uploaded. {rid} is now In Progress."
    # Never further than In Progress: uploading again changes nothing about the status.
    again = ok(upload(api, rid, MK_AM, data=sample_pdf("again")))["request"]
    assert again["status"] == "in_progress" and len(again["history"]) == len(r["history"])


def test_failed_start_of_work_removes_the_uploaded_file(api, session, monkeypatch):
    from app.services import proposal_files as svc
    keys, rows = set(storage(api).keys()), file_rows(session)

    def broken(*args, **kwargs):
        raise RuntimeError("injected failure while starting work")
    monkeypatch.setattr(svc, "perform_action", broken)
    with pytest.raises(RuntimeError, match="starting work"):
        upload(api, pr(16), MK_AM)
    monkeypatch.undo()
    assert set(storage(api).keys()) == keys and file_rows(session) == rows
    assert detail(api, pr(16), NOHA)["status"] == "submitted"


def test_uploads_are_allowed_while_awaiting_bd_information(api):
    out = ok(upload(api, pr(12), MK_AM))  # Awaiting BD Information
    assert out["request"]["status"] == "awaiting_bd_info", "no status change"


def test_replaced_files_only_for_the_assigned_am_and_the_head(api):
    first = ok(upload(api, pr(14), MK_AM, name="first.pdf"))["file"]
    ok(upload(api, pr(14), MK_AM, data=sample_pdf("second"), name="second.pdf"))
    for who in (MK_AM, NOHA):
        files = detail(api, pr(14), who)["files"]
        assert [f["originalName"] for f in files] == ["first.pdf", "second.pdf"], who
        assert api.get(first["downloadUrl"], headers=who).status_code == 200, who
    for who in (SHERINE, MK_BD, AHMED):
        files = detail(api, pr(14), who)["files"]
        assert [f["originalName"] for f in files] == ["second.pdf"], who
        assert api.get(first["downloadUrl"], headers=who).status_code == 404, who
