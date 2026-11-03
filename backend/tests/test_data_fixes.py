"""
Real starting data and data fixes:
1. apply_tracker_mapping puts already-imported requests on the new 2026 mapping (history from the
   sheet's dates), keeps anything added in the app, and restores the append-only guard; check_tracker
   compares the app with the sheet, read-only.
2. "Correct status (data fix)": the contract rules, who may, what is recorded, no notifications, the
   opportunity follows.
3. "Add past proposal or event": history from the dates, marked, no notifications, duplicate warning,
   who may, the optional file.
"""

from datetime import date

import pytest
from sqlalchemy import func, select, text

from app.apply_tracker_mapping import run as apply_mapping
from app.check_tracker import run as check_run
from app.database import make_engine, make_sessionmaker
from app.domain import corrections
from app.domain.views import request_from_json, user_from_json
from app.identity import Actor
from app.import_tracker import run as import_run
from app.models import Notification, Opportunity, ProposalRequest, RequestComment

from .conftest import AHMED, MD_AM, MK_BD, NOHA
from .contract_world import load_scenarios
from .test_import_tracker import NOW, real_db, workbook  # noqa: F401 (fixture)
from .write_helpers import act, create, detail, error, future, ok, sample_pdf, upload

SCENARIOS = load_scenarios()
C = SCENARIOS["correctionCases"]
WORLD = SCENARIOS["world"]
USERS = {u["id"]: user_from_json(u) for u in WORLD["users"]}
REQUESTS = {r["id"]: request_from_json(r) for r in WORLD["requests"]}


def actor(v):
    return Actor(v["userId"], v["activeRole"])


# ---------- the shared rules ----------

def test_correction_and_past_record_rules_match_the_contract():
    assert [t["id"] for t in corrections.CORRECTION_TARGETS] == C["targets"]
    assert list(corrections.PAST_OUTCOMES) == C["pastOutcomes"]
    for c in C["plain"]:
        r = REQUESTS[c["id"]]
        assert corrections.plain_status(r.status, r.event_status) == c["expect"], c
    for c in C["stages"]:
        assert corrections.stage_for_status(c["status"]) == c["expect"], c
    for c in C["canCorrect"]:
        assert corrections.can_correct_status(REQUESTS[c["id"]], actor(c["viewer"]), USERS) == c["expect"], c
    for c in C["validate"]:
        got = corrections.validate_correction(c["input"], REQUESTS[c["id"]])
        assert got == c["expect"], c
        if c["note"]:
            assert corrections.correction_note(got["values"]) == c["note"]
    for c in C["canAddPast"]:
        client = type("C", (), {"owner": c["ctx"]["clientOwner"]})() if c["ctx"].get("clientOwner") else None
        assert corrections.can_add_past_record(actor(c["viewer"]), USERS, client=client, brand=c["ctx"].get("brand")) == c["expect"], c
    for c in C["past"]:
        got = corrections.validate_past_record(c["input"], SCENARIOS["today"])
        assert got == c["expect"], c
        if c["history"]:
            assert corrections.past_history(got["values"], SCENARIOS["today"]) == c["history"]


# ---------- 2. Correct status ----------

def shared(api):
    rid = ok(create(api, AHMED, submit=True, **{"clientId": "CL-0008", "brand": "teamup", "service": "team_building",
                                                "eventDatePrecision": "day", "eventDate": future(40), "requiredBy": future(10),
                                                "participants": 80, "requirementsSummary": "Offsite"}))["request"]["id"]
    ok(act(api, rid, "start_work", MD_AM))
    ok(upload(api, rid, MD_AM, data=sample_pdf()))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=90000))
    ok(act(api, rid, "share_with_client", AHMED, confirmShared=True, channel="email"))
    return rid


def correct(api, rid, who, **body):
    v = detail(api, rid, NOHA)["rowVersion"]
    return api.post(f"/api/proposal-requests/{rid}/correct-status", headers=who, json={"expectedRowVersion": v, **body})


def test_correct_status_jumps_records_and_notifies_no_one(api, session):
    rid = shared(api)
    assert detail(api, rid, AHMED)["correctStatus"]["allowed"] is True
    assert detail(api, rid, MK_BD)["correctStatus"]["allowed"] is False
    assert correct(api, rid, MK_BD, target="lost", lostReason="price").status_code == 403
    r = correct(api, rid, NOHA, target="lost")
    assert error(r)["fields"] == {"lostReason": "Choose why it was lost."}
    before = session.scalar(select(func.count()).select_from(Notification))
    d = ok(correct(api, rid, NOHA, target="lost", lostReason="price", note="Typed in the wrong place"))["request"]
    assert d["status"] == "rejected"
    last = d["history"][-1]
    assert (last["corrected"], last["note"], last["changedBy"]) == (
        True, "Status corrected from With client to Lost — Typed in the wrong place", "u-noha")
    session.expire_all()
    assert session.scalar(select(func.count()).select_from(Notification)) == before, "a data fix notifies no one"
    d = ok(correct(api, rid, MD_AM, target="confirmed", eventDate=future(30), finalPrice=88000))["request"]
    assert (d["status"], d["eventDate"], d["finalPrice"]) == ("accepted", future(30), 88000)
    ev = api.get(f"/api/events/{rid}", headers=NOHA).json()
    assert (ev["eventStatus"], ev["timing"], ev["correctStatus"]["allowed"]) == ("confirmed", "upcoming", True)
    assert error(correct(api, rid, NOHA, target="confirmed", eventDate=future(30)))["fields"] == {
        "target": "It is already Confirmed."}


# ---------- 3. Add past proposal or event ----------

def past(api, who, **over):
    body = {"clientId": "CL-0008", "brand": "teamup", "service": "team_building", "bdOwner": "u-ahmed",
            "assignedAM": "u-mariam-dimitri", "briefDate": "2026-03-01", "sentDate": "2026-03-10",
            "eventDate": "2026-04-15", "outcome": "done", "amPrice": 70000, "finalPrice": 65000, "participants": 90,
            "eventName": "Spring offsite", **over}
    return api.post("/api/proposal-requests/past", headers=who, json=body)


def test_add_a_past_record_with_its_history_and_no_notifications(api, session, client):
    before = session.scalar(select(func.count()).select_from(Notification))
    d = ok(past(api, AHMED))["request"]
    assert (d["status"], d["finalPrice"], d["amPrice"], d["eventName"]) == ("accepted", 65000, 70000, "Spring offsite")
    assert [(h["status"], h["note"], h["imported"]) for h in d["history"]] == [
        (s, "Added manually — before IEE", True) for s in ("submitted", "ready_for_bd", "shared_with_client", "accepted")]
    assert d["history"][0]["changedAt"].startswith("2026-03-01")
    session.expire_all()
    assert session.scalar(select(func.count()).select_from(Notification)) == before, "no notifications"
    assert api.get(f"/api/events/{d['id']}", headers=NOHA).json()["timing"] == "done"
    opp_id = session.get(ProposalRequest, d["id"]).opportunity_id
    assert session.get(Opportunity, opp_id).stage == "won"
    ok(correct(api, d["id"], NOHA, target="lost", lostReason="timing"))
    session.expire_all()
    assert session.get(Opportunity, opp_id).stage == "lost", "a correction moves the opportunity too"
    r = past(api, AHMED)
    assert r.status_code == 409 and error(r)["code"] == "possible_duplicate"
    assert ok(past(api, AHMED, confirmDuplicate=True))["request"]["id"] != d["id"]
    r = past(api, MD_AM, brand="grasshoppers", service="school_trip")
    assert r.status_code == 403, "an AM adds past records for their own brand only"
    assert error(past(api, AHMED, outcome="lost", eventDate=None))["fields"] == {"lostReason": "Choose why it was lost."}
    # The optional proposal file: its creator, once.
    r = client.post(f"/api/proposal-requests/{d['id']}/past-file", content=sample_pdf(), headers={**AHMED, "X-File-Name": "p.pdf"})
    assert r.status_code == 201, r.text
    r = client.post(f"/api/proposal-requests/{d['id']}/past-file", content=sample_pdf(), headers={**AHMED, "X-File-Name": "p.pdf"})
    assert r.status_code == 403


@pytest.fixture
def client(api):
    return api


# ---------- 1. The mapping on already-imported data, and the reconciliation ----------

def test_apply_tracker_mapping_rebuilds_untouched_rows_and_keeps_app_changes(tmp_path, real_db):  # noqa: F811
    path = workbook(tmp_path / "t.xlsx")
    import_run(path, database_url=real_db, apply=True, now=NOW)
    engine = make_engine(real_db)
    Session = make_sessionmaker(engine)
    with Session() as db:  # as the earlier mapping left them: closed history, "Needs review"
        rows = {r.import_row: r for r in db.scalars(select(ProposalRequest)).all()}
        for n in (3, 4, 5):
            rows[n].status, rows[n].needs_review = "closed_unrecorded", True
        rows[6].status = "closed_postponed"
        db.add(RequestComment(request_id=rows[5].id, author_id="u-noha", role="commercial_head", body="Checked",
                              created_at=NOW, kind="comment"))
        db.commit()
    dry = apply_mapping(database_url=real_db, file=path, now=NOW)
    assert "To update: 3 · already on the mapping: 4 · kept (changed in the app): 1" in dry
    assert "Closed · outcome not recorded" in dry and "Dry run: nothing was changed." in dry
    with Session() as db:
        assert db.scalars(select(ProposalRequest).where(ProposalRequest.import_row == 3)).one().status == "closed_unrecorded"
    out = apply_mapping(database_url=real_db, file=path, apply_changes=True, now=NOW)
    assert "APPLIED" in out
    with Session() as db:
        rows = {r.import_row: r for r in db.scalars(select(ProposalRequest)).all()}
        assert (rows[3].status, rows[4].status, rows[6].status) == ("in_progress", "shared_with_client", "postponed")
        assert rows[5].status == "closed_unrecorded", "kept: something was added in the app"
        assert not any(r.needs_review for r in rows.values())
        assert [h.status for h in sorted(rows[4].history, key=lambda h: h.seq)] == ["submitted", "ready_for_bd", "shared_with_client"]
        assert rows[6].follow_up_on == date(2026, 10, 29)
        with pytest.raises(Exception):  # the append-only guard is back
            db.execute(text(f"DELETE FROM request_status_history WHERE request_id = '{rows[4].id}'"))
    report = check_run(path, database_url=real_db)
    assert "Rows that differ: 1" in report and "Not recorded (sheet: With client)" in report
    assert "Read-only" in report
    engine.dispose()
