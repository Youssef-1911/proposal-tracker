"""
Phase 3B: request comments (seeded demo database).
Anyone who can view a request can read and add comments; drafts stay private to their creator.
Plain text up to 2,000 characters, stored and returned unchanged; append-only.
"""

from datetime import datetime, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DatabaseError

from app.clock import get_now

from .conftest import AHMED, MD_AM, MK_AM, MK_BD, NOHA, SHERINE, as_user, pr
from .write_helpers import detail, error, row_version

ABDELRAHMAN = as_user("u-abdelrahman", "business_development")
ALL_VIEWERS = [NOHA, AHMED, SHERINE, MK_BD, MK_AM, MD_AM, ABDELRAHMAN]
DOAA = as_user("u-doaa", "executive")


def post(api, rid, headers, body):
    return api.post(f"/api/proposal-requests/{rid}/comments", json={"body": body}, headers=headers)


def test_everyone_who_can_view_can_post_and_read(api):
    rid = pr(17)  # submitted, Team Up: everyone sees it except the Grasshoppers AM (no "See all brands")
    viewers = [v for v in ALL_VIEWERS if v != MK_AM] + [DOAA]  # Executives may comment
    for i, who in enumerate(viewers):
        r = post(api, rid, who, f"Comment {i}")
        assert r.status_code == 201, who
        c = r.json()["comment"]
        assert (c["body"], c["author"], c["role"]) == (f"Comment {i}", who["X-Dev-User"], who["X-Dev-Role"])
    for who in viewers:
        listed = api.get(f"/api/proposal-requests/{rid}/comments", headers=who).json()
        assert [c["body"] for c in listed["items"]] == [f"Comment {i}" for i in range(len(viewers))]
        assert listed["total"] == len(viewers)
    assert post(api, rid, MK_AM, "Hidden").status_code == 404, "a brand this AM does not see"
    # Mariam El Khayat's two roles are recorded separately (on a Grasshoppers request she sees in both).
    for who in (MK_BD, MK_AM):
        assert post(api, pr(14), who, "Both roles").status_code == 201
    roles = [c["role"] for c in detail(api, pr(14), NOHA)["comments"] if c["author"] == "u-mariam-elkhayat"]
    assert roles == ["business_development", "account_manager"]


def test_comment_time_is_utc_from_the_server_clock(api):
    frozen = datetime(2026, 10, 20, 21, 30, tzinfo=timezone.utc)  # 00:30 on 21 Oct in Cairo; the UI shows Cairo time
    api.app.dependency_overrides[get_now] = lambda: frozen
    try:
        c = post(api, pr(17), NOHA, "Late note").json()["comment"]
    finally:
        api.app.dependency_overrides.pop(get_now)
    assert c["createdAt"] == "2026-10-20T21:30:00.000Z"


def test_drafts_stay_private_to_their_creator(api):
    draft = pr(19)  # Ahmed's draft
    assert post(api, draft, AHMED, "Note to self").status_code == 201
    for who in (NOHA, MD_AM, SHERINE, ABDELRAHMAN):
        assert post(api, draft, who, "x").status_code == 404, who
        assert api.get(f"/api/proposal-requests/{draft}/comments", headers=who).status_code == 404, who
    missing = post(api, "PR-1999-0001", NOHA, "x")
    assert error(missing)["code"] == error(post(api, draft, NOHA, "x"))["code"] == "not_found"
    assert [c["body"] for c in detail(api, draft, AHMED)["comments"]] == ["Note to self"]


def test_html_is_stored_and_returned_unchanged_as_plain_text(api):
    body = '<script>alert("x")</script> <img src=x onerror=alert(1)> & <b>bold</b> ‹Arabic: شكراً›'
    r = post(api, pr(17), NOHA, body)
    assert r.headers["content-type"] == "application/json"
    assert r.json()["comment"]["body"] == body
    assert api.get(f"/api/proposal-requests/{pr(17)}/comments", headers=AHMED).json()["items"][0]["body"] == body


@pytest.mark.parametrize("body,message", [
    ("", "Write a comment first."),
    ("   \n  ", "Write a comment first."),
    (None, "Write a comment first."),
    (123, "Write a comment first."),
    ("x" * 2001, "Comments can be up to 2,000 characters (this one has 2001)."),
])
def test_comment_validation(api, body, message):
    r = post(api, pr(17), NOHA, body)
    assert (r.status_code, error(r)["fields"]) == (422, {"body": message})


def test_limits_and_trimming(api):
    assert post(api, pr(17), NOHA, "x" * 2000).status_code == 201, "2,000 characters is allowed"
    assert post(api, pr(17), NOHA, "  padded  ").json()["comment"]["body"] == "padded"
    extra = api.post(f"/api/proposal-requests/{pr(17)}/comments", json={"body": "x", "author": "u-ahmed"}, headers=NOHA)
    assert extra.status_code == 422, "author and time come from the server"


def test_comments_do_not_change_the_request_and_stay_separate_from_history(api):
    before = detail(api, pr(17), NOHA)
    post(api, pr(17), NOHA, "Please prioritise")
    after = detail(api, pr(17), NOHA)
    assert after["rowVersion"] == before["rowVersion"] and after["lastUpdated"] == before["lastUpdated"]
    assert after["history"] == before["history"]
    assert [c["body"] for c in after["comments"]] == ["Please prioritise"]
    assert row_version(api, pr(17), NOHA) == before["rowVersion"]


def test_comments_are_append_only(api, engine):
    c = post(api, pr(17), NOHA, "First").json()["comment"]
    for method in ("delete", "put", "patch"):
        r = getattr(api, method)(f"/api/proposal-requests/{pr(17)}/comments/{c['id']}", headers=NOHA)
        assert r.status_code in (404, 405)
        r = getattr(api, method)(f"/api/proposal-requests/{pr(17)}/comments", headers=NOHA)
        assert r.status_code == 405
    for sql in ("UPDATE request_comments SET body = 'edited'", "DELETE FROM request_comments"):
        with engine.connect() as conn:
            with pytest.raises(DatabaseError, match="append-only"):
                conn.execute(text(sql))
            conn.rollback()
