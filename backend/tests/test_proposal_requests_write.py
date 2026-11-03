"""
Phase 3A write endpoints (seeded demo database):
POST /api/proposal-requests · PATCH /api/proposal-requests/{id} · POST /api/proposal-requests/{id}/actions

Lifecycle paths, decisions 1-4, server-generated values, hidden drafts, stale row versions,
parallel creation, atomicity (injected failures) and append-only history.
"""

import threading
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.exc import DatabaseError
from sqlalchemy.orm.exc import StaleDataError

from app.clock import get_now
from app.main import create_app
from app.models import IdCounter, Opportunity, OpportunityHistory, ProposalRequest, RequestStatusHistory

from .conftest import AHMED, LOOPBACK, MD_AM, MK_AM, MK_BD, NOHA, SHERINE, as_user, pr
from .write_helpers import act, cl, create, detail, edit, error, future, ok, opportunity, row_version, upload

ABDELRAHMAN = as_user("u-abdelrahman", "business_development")


def teamup_for_ahmed(**over):
    """A complete Team Up request for Ahmed's client Harbor Line Logistics (CL-0008)."""
    return {"clientId": cl(8), "brand": "teamup", "service": "team_building", "eventDatePrecision": "day",
            "eventDate": future(40), "requiredBy": future(10), "participants": 120,
            "requirementsSummary": "Half-day team building", **over}


def counts(session, rid=None):
    session.expire_all()
    total = session.scalar(select(func.count()).select_from(ProposalRequest))
    history = session.scalar(select(func.count()).select_from(RequestStatusHistory))
    return total, history


# ---------------------------------------------------------------------------
# Every lifecycle path through the API
# ---------------------------------------------------------------------------

def test_full_path_create_submit_info_loop_ready_share_revision_won(api):
    created = ok(create(api, AHMED, submit=True, **teamup_for_ahmed(opportunityId="OPP-0015", service="family_day",
                                                                     eventDate=future(45))))
    rid = created["request"]["id"]
    assert rid == pr(20), "next number after the 19 seeded requests"
    assert created["request"]["status"] == "submitted" and created["request"]["assignedAM"] == "u-mariam-dimitri"
    ok(act(api, rid, "start_work", MD_AM))
    ok(act(api, rid, "request_bd_info", MD_AM, note="Need venue capacity"))
    ok(act(api, rid, "provide_bd_info", AHMED, note="350 seated"))
    ok(act(api, rid, "start_work", MD_AM))
    ok(upload(api, rid, MD_AM))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=250000))
    ok(act(api, rid, "share_with_client", AHMED, confirmShared=True, channel="whatsapp"))
    ok(act(api, rid, "request_revision", AHMED, note="Half-day option", newRequiredBy=future(4)))
    ok(upload(api, rid, MD_AM))  # version 2, prepared while the revision is requested
    ok(act(api, rid, "start_revision", MD_AM))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=210000, note="Half day, price down EGP 40,000"))
    ok(act(api, rid, "share_with_client", AHMED, confirmShared=True, channel="email"))
    done = ok(act(api, rid, "record_accepted", AHMED, eventDate=future(30)))

    r = done["request"]
    assert (r["status"], r["stage"], r["subLabel"], r["version"]) == ("accepted", "closed", "Confirmed", 2)
    assert [e["status"] for e in r["history"]] == [
        "draft", "submitted", "in_progress", "awaiting_bd_info", "submitted", "in_progress", "ready_for_bd",
        "shared_with_client", "revision_requested", "in_progress", "ready_for_bd", "shared_with_client", "accepted"]
    assert [(v["version"], v["amPrice"]) for v in r["versions"]] == [(2, 210000), (1, 250000)]
    assert [e["channel"] for e in r["history"] if e["status"] == "shared_with_client"] == ["whatsapp", "email"]
    assert r["allowedActions"] == [], "closed: nothing left to do"
    opp = opportunity(api, "OPP-0015", NOHA)
    assert opp["stage"] == "won"
    assert [h["reasonCode"] for h in opp["history"][1:]] == ["proposal_accepted"], "already in Negotiation before"


def test_lost_path_records_the_reason_on_history_and_opportunity(api):
    out = ok(act(api, pr(7), "record_rejected", SHERINE, lostReason="other", note="School changed principal"))
    entry = out["request"]["history"][-1]
    assert (entry["status"], entry["lostReason"], entry["note"]) == ("rejected", "other", "School changed principal")
    opp = opportunity(api, "OPP-0013", NOHA)
    assert (opp["stage"], opp["lostReason"]) == ("lost", "other"), "decision 3: the reason code"
    assert (opp["history"][-1]["reasonCode"], opp["history"][-1]["note"]) == ("proposal_rejected", "School changed principal")


def test_cancel_path_by_bd_owner_and_by_commercial_head(api):
    assert ok(act(api, pr(13), "cancel", AHMED, note="Client postponed"))["request"]["status"] == "cancelled"
    out = ok(act(api, pr(15), "cancel", NOHA, note="Duplicate"))
    assert out["request"]["history"][-1]["role"] == "commercial_head"


def test_mariam_el_khayat_self_assigned_request_through_the_api(api):
    created = ok(create(api, MK_BD, submit=True, clientId=cl(1), brand="grasshoppers", service="explorers_league",
                        eventDate=future(30), requiredBy=future(7), participants=60,
                        requirementsSummary="Explorers League term"))
    rid, r = created["request"]["id"], created["request"]
    assert (r["createdBy"], r["bdOwner"], r["submittedBy"], r["assignedAM"]) == ("u-mariam-elkhayat",) * 4

    as_bd = act(api, rid, "start_work", MK_BD)
    assert as_bd.status_code == 403
    assert error(as_bd)["message"] == ("You are acting as Business Development. Switch your active role to "
                                       "Account Manager — Grasshoppers to do this.")
    ok(act(api, rid, "start_work", MK_AM))
    ok(upload(api, rid, MK_AM))
    ok(act(api, rid, "mark_ready", MK_AM, amPrice=90000))
    as_am = act(api, rid, "share_with_client", MK_AM, confirmShared=True, channel="in_person")
    assert as_am.status_code == 403 and "Switch your active role to Business Development" in error(as_am)["message"]
    out = ok(act(api, rid, "share_with_client", MK_BD, confirmShared=True, channel="in_person"))
    assert [(e["status"], e["role"]) for e in out["request"]["history"]] == [
        ("draft", "business_development"), ("submitted", "business_development"), ("in_progress", "account_manager"),
        ("ready_for_bd", "account_manager"), ("shared_with_client", "business_development")]


def test_noha_creates_edits_and_submits_on_behalf_of_the_bd_owner(api):
    draft = ok(create(api, NOHA, clientId=cl(7), brand="teamup", service="corporate_event"))["request"]
    rid = draft["id"]
    assert (draft["createdBy"], draft["bdOwner"], draft["history"][0]["onBehalfOf"]) == ("u-noha", "u-abdelrahman", "u-abdelrahman")
    assert api.get(f"/api/proposal-requests/{rid}", headers=ABDELRAHMAN).status_code == 404, "private draft"

    out = ok(edit(api, rid, NOHA, submit=True, eventDate=future(60), requiredBy=future(12), participants=250,
                  requirementsSummary="Annual dinner"))
    r = out["request"]
    assert (r["status"], r["submittedBy"], r["bdOwner"]) == ("submitted", "u-noha", "u-abdelrahman")
    assert (r["history"][-1]["role"], r["history"][-1]["onBehalfOf"]) == ("commercial_head", "u-abdelrahman")
    seen_by_owner = detail(api, rid, ABDELRAHMAN)
    assert [a["action"] for a in seen_by_owner["allowedActions"] if a["allowed"]] == ["cancel"]


# ---------------------------------------------------------------------------
# Decisions
# ---------------------------------------------------------------------------

def test_decision_1_expected_row_version_is_required_and_stale_is_409(api):
    missing = api.post(f"/api/proposal-requests/{pr(17)}/actions", json={"action": "start_work"}, headers=MD_AM)
    assert missing.status_code == 422 and "expectedRowVersion" in error(missing)["fields"]
    missing_patch = api.patch(f"/api/proposal-requests/{pr(19)}", json={"participants": 5}, headers=AHMED)
    assert missing_patch.status_code == 422 and "expectedRowVersion" in error(missing_patch)["fields"]

    v = row_version(api, pr(17), MD_AM)
    first = api.post(f"/api/proposal-requests/{pr(17)}/actions",
                     json={"action": "start_work", "expectedRowVersion": v}, headers=MD_AM)
    assert first.status_code == 200 and first.json()["request"]["rowVersion"] == v + 1
    second = api.post(f"/api/proposal-requests/{pr(17)}/actions",
                      json={"action": "cancel", "note": "x", "expectedRowVersion": v}, headers=NOHA)
    assert second.status_code == 409
    assert error(second) == {"code": "stale",
                             "message": "This request was changed by someone else. Reload it and try again."}
    assert detail(api, pr(17), NOHA)["status"] == "in_progress", "the stale write changed nothing"

    stale_edit = edit(api, pr(19), AHMED, version=99, participants=5)
    assert stale_edit.status_code == 409 and error(stale_edit)["code"] == "stale"


def test_a_row_version_conflict_at_write_time_is_also_409(api, monkeypatch):
    from app.services import proposal_requests as service

    def boom(*args, **kwargs):
        raise StaleDataError("simulated concurrent update")
    monkeypatch.setattr(service, "perform_action", boom)
    r = act(api, pr(17), "start_work", MD_AM)
    assert r.status_code == 409 and error(r)["code"] == "stale"


def test_decision_2_mark_won_leaves_other_open_requests_and_warns(api):
    other = ok(create(api, MK_BD, submit=True, clientId=cl(12), brand="teamup", service="family_day",
                      opportunityId="OPP-0014", eventDate=future(50), requiredBy=future(9), participants=200,
                      requirementsSummary="Second family day option"))["request"]
    out = ok(act(api, pr(9), "record_accepted", MK_BD, eventDate=future(30)))
    assert opportunity(api, "OPP-0014", NOHA)["stage"] == "won"
    assert detail(api, other["id"], NOHA)["status"] == "submitted", "nothing cancelled automatically"
    assert out["warnings"] == [{
        "code": "other_open_requests",
        "message": (f"Opportunity OPP-0014 is Won, but {other['id']} is still open. Nothing was changed on it; "
                    "cancel it if no longer needed."),
        "requests": [{"id": other["id"], "status": "submitted", "bdOwner": "u-mariam-elkhayat"}],
    }]


def test_decision_3_mark_lost_needs_a_listed_reason_note_only_for_other(api):
    assert error(act(api, pr(7), "record_rejected", SHERINE))["fields"] == {"lostReason": "Choose why the proposal was lost."}
    assert error(act(api, pr(7), "record_rejected", SHERINE, lostReason="other"))["fields"] == {
        "note": 'Describe the reason when choosing "Other".'}
    out = ok(act(api, pr(7), "record_rejected", SHERINE, lostReason="price"))
    assert (out["request"]["history"][-1]["lostReason"], out["request"]["history"][-1]["note"]) == ("price", None)
    assert out["request"]["opportunity"]["lostReason"] == "price"


def test_decision_4_share_records_the_channel(api):
    assert error(act(api, pr(10), "share_with_client", ABDELRAHMAN, confirmShared=True))["fields"] == {
        "channel": "Choose how the proposal was sent to the client."}
    out = ok(act(api, pr(10), "share_with_client", ABDELRAHMAN, confirmShared=True, channel="email"))
    assert out["request"]["history"][-1]["channel"] == "email"
    opp = opportunity(api, "OPP-0012", NOHA)
    assert (opp["stage"], opp["history"][-1]["reasonCode"], opp["history"][-1]["sourceRequestId"]) == (
        "negotiation", "proposal_shared", pr(10))


# ---------------------------------------------------------------------------
# Permissions, hidden drafts, server-generated values
# ---------------------------------------------------------------------------

def test_permission_failures_are_403_with_the_frontend_reason_text(api):
    cases = [
        (pr(17), "start_work", NOHA, {}, "Only the assigned Account Manager, Mariam Dimitri, can do this."),
        (pr(10), "share_with_client", AHMED, {"confirmShared": True, "channel": "email"},
         "Only the BD owner, Abdelrahman Shams, can do this."),
        (pr(7), "cancel", AHMED, {"note": "x"}, "Only the BD owner, Sherine El Tabakh, or the Commercial Head can do this."),
        (pr(18), "submit", MK_AM, {}, "Only the person who created this draft, Mariam El Khayat, can do this."),
    ]
    for rid, action, who, inputs, reason in cases:
        r = act(api, rid, action, who, **inputs)
        assert (r.status_code, error(r)) == (403, {"code": "forbidden", "message": reason}), (rid, action)
    r = create(api, MD_AM, **teamup_for_ahmed())
    assert (r.status_code, error(r)["message"]) == (
        403, "Only Business Development or the Commercial Head can create proposal requests.")


def test_hidden_drafts_are_404_for_writes_exactly_like_missing_requests(api):
    for method, path, body in (
        ("patch", "/api/proposal-requests/{id}", {"expectedRowVersion": 1, "participants": 5}),
        ("post", "/api/proposal-requests/{id}/actions", {"action": "submit", "expectedRowVersion": 1}),
        ("post", "/api/proposal-requests/{id}/actions", {"action": "cancel", "note": "x", "expectedRowVersion": 99}),
    ):
        hidden = getattr(api, method)(path.format(id=pr(19)), json=body, headers=NOHA)  # Ahmed's draft
        missing = getattr(api, method)(path.format(id="PR-1999-0001"), json=body, headers=NOHA)
        assert hidden.status_code == missing.status_code == 404
        assert error(hidden) == {"code": "not_found", "message": f"Request '{pr(19)}' not found."}
        assert error(missing) == {"code": "not_found", "message": "Request 'PR-1999-0001' not found."}
    assert detail(api, pr(19), AHMED)["rowVersion"] == 1, "untouched"


@pytest.mark.parametrize("field", ["id", "status", "createdBy", "bdOwner", "assignedAM", "submittedBy",
                                   "submittedAt", "lastUpdated", "rowVersion", "version", "amPrice",
                                   "expectedRowVersion"])
def test_server_generated_values_cannot_be_sent_on_create(api, session, field):
    before = counts(session)
    r = create(api, AHMED, **teamup_for_ahmed(), **{field: "x"})
    assert r.status_code == 422 and field in error(r)["fields"]
    assert counts(session) == before


def test_ids_timestamps_and_people_come_from_the_server(api):
    frozen = datetime(2026, 12, 31, 22, 30, tzinfo=timezone.utc)  # already 1 Jan 2027 in Cairo
    api.app.dependency_overrides[get_now] = lambda: frozen
    try:
        r = ok(create(api, AHMED, clientId=cl(8), brand="teamup", service="team_building"))["request"]
    finally:
        api.app.dependency_overrides.pop(get_now)
    assert r["id"] == "PR-2027-0001", "numbered per Africa/Cairo year"
    assert r["lastUpdated"] == r["history"][0]["changedAt"] == "2026-12-31T22:30:00.000Z"
    assert (r["createdBy"], r["bdOwner"], r["assignedAM"], r["history"][0]["changedBy"]) == (
        "u-ahmed", "u-ahmed", "u-mariam-dimitri", "u-ahmed")


# ---------------------------------------------------------------------------
# Concurrency and atomicity
# ---------------------------------------------------------------------------

def test_parallel_creation_gives_unique_consecutive_ids(dev_settings, engine, seeded):
    app = create_app(dev_settings, engine=engine)
    ids, failures = [], []
    lock = threading.Lock()

    def worker():
        client = TestClient(app, client=LOOPBACK)
        for _ in range(3):
            r = client.post("/api/proposal-requests", json={"clientId": cl(8), "brand": "teamup",
                                                            "service": "team_building"}, headers=AHMED)
            with lock:
                (ids if r.status_code == 201 else failures).append(r.json()["request"]["id"] if r.status_code == 201 else r.text)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert failures == []
    assert len(ids) == len(set(ids)) == 24
    assert sorted(ids) == [pr(n) for n in range(20, 44)], "no gaps, no duplicates"


def _boom(*args, **kwargs):
    raise RuntimeError("injected failure during the opportunity sync")


def test_atomicity_an_action_that_fails_mid_way_saves_nothing(api, session, monkeypatch):
    from app.services import proposal_requests as service
    rid = pr(10)  # Ready for BD; sharing moves OPP-0012 to Negotiation
    before = (counts(session), session.get(ProposalRequest, rid).row_version, session.get(Opportunity, "OPP-0012").stage,
              session.scalar(select(func.count()).select_from(OpportunityHistory)))
    monkeypatch.setattr(service, "set_opportunity_stage", _boom)
    with pytest.raises(RuntimeError, match="injected failure"):
        act(api, rid, "share_with_client", ABDELRAHMAN, confirmShared=True, channel="email")
    session.expire_all()
    after = (counts(session), session.get(ProposalRequest, rid).row_version, session.get(Opportunity, "OPP-0012").stage,
             session.scalar(select(func.count()).select_from(OpportunityHistory)))
    assert after == before, "status, history entry, row version and opportunity all rolled back together"
    assert session.get(ProposalRequest, rid).status == "ready_for_bd"


def test_atomicity_create_and_submit_that_fails_saves_no_draft_and_no_id(api, session, monkeypatch):
    from app.services import proposal_requests as service
    year_counter = f"request:{pr(1)[3:7]}"
    before = (counts(session), session.get(IdCounter, year_counter).last_value)
    monkeypatch.setattr(service, "set_opportunity_stage", _boom)
    with pytest.raises(RuntimeError, match="injected failure"):
        # OPP-0004 is Requirements Gathered, so submitting must move it to Proposal Requested.
        create(api, AHMED, submit=True, **teamup_for_ahmed(opportunityId="OPP-0004", service="family_day"))
    session.expire_all()
    assert (counts(session), session.get(IdCounter, year_counter).last_value) == before
    assert session.get(ProposalRequest, pr(20)) is None


def test_history_rows_cannot_be_updated_or_deleted_by_the_database(api, engine):
    ok(act(api, pr(10), "share_with_client", ABDELRAHMAN, confirmShared=True, channel="email"))
    for sql in ("UPDATE request_status_history SET channel = 'other' WHERE channel = 'email'",
                "UPDATE request_status_history SET note = 'rewritten'",
                "DELETE FROM request_status_history WHERE request_id = :rid",
                "UPDATE opportunity_history SET note = 'rewritten'",
                "DELETE FROM opportunity_history"):
        with engine.connect() as conn:
            with pytest.raises(DatabaseError, match="append-only"):
                conn.execute(text(sql), {"rid": pr(10)})
            conn.rollback()


def test_history_columns_are_constrained_to_their_status_and_lists(api, engine):
    bad = [
        "INSERT INTO request_status_history (request_id, seq, status, changed_by_id, role, changed_at, version, lost_reason) "
        "VALUES (:rid, 99, 'shared_with_client', 'u-noha', 'commercial_head', '2026-01-01', 1, 'price')",
        "INSERT INTO request_status_history (request_id, seq, status, changed_by_id, role, changed_at, version, lost_reason) "
        "VALUES (:rid, 99, 'rejected', 'u-noha', 'commercial_head', '2026-01-01', 1, 'cheaper')",
        "INSERT INTO request_status_history (request_id, seq, status, changed_by_id, role, changed_at, version, channel) "
        "VALUES (:rid, 99, 'shared_with_client', 'u-noha', 'commercial_head', '2026-01-01', 1, 'fax')",
        "INSERT INTO request_status_history (request_id, seq, status, changed_by_id, role, changed_at, version, channel) "
        "VALUES (:rid, 99, 'accepted', 'u-noha', 'commercial_head', '2026-01-01', 1, 'email')",
    ]
    for sql in bad:
        with engine.connect() as conn:
            with pytest.raises(DatabaseError, match="CHECK constraint failed"):
                conn.execute(text(sql), {"rid": pr(10)})
            conn.rollback()
