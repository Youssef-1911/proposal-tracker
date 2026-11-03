"""
Confirmed events and reminders: the contract file's eventCases / reminderCases (generated from the
frontend's events.js and reminders.js) against the Python rules, and the API end to end: Operations
sees confirmed events only (never prices or unconfirmed proposals), "Mark confirmed" stores the event
details, Done / Cancelled after confirmation, one reminder per recipient per 24 hours, the bell.
"""

from datetime import timedelta

from app.domain import events, lists, reminders
from app.domain.views import request_from_json, user_from_json
from app.identity import Actor

from .conftest import AHMED, MD_AM, NOHA, as_user
from .contract_world import headers, load_scenarios
from .write_helpers import act, create, detail, error, future, ok, sample_pdf, upload

SCENARIOS = load_scenarios()
E = SCENARIOS["eventCases"]
R = SCENARIOS["reminderCases"]
WORLD = SCENARIOS["world"]
USERS = {u["id"]: user_from_json(u) for u in WORLD["users"]}
REQUESTS = {r["id"]: request_from_json(r) for r in WORLD["requests"]}
DEFAULTS = lists.effective_lists()
DOAA = as_user("u-doaa", "executive")


def actor(v):
    return Actor(v["userId"], v["activeRole"])


def test_event_rules_match_the_contract():
    for c in E["canSee"]:
        assert events.can_see_event(REQUESTS[c["id"]], actor(c["viewer"]), USERS) == c["expect"], c
    for c in E["seePrice"]:
        assert events.can_see_event_price(actor(c["viewer"])) == c["expect"], c
    for c in E["canManage"]:
        assert events.can_manage_event(REQUESTS[c["id"]], actor(c["viewer"]), USERS) == c["expect"], c
    for c in E["dateChanges"]:
        assert events.validate_event_date_change(REQUESTS[c["id"]], c["input"]) == c["expect"], c
    for c in E["cancels"]:
        assert events.validate_event_cancel(c["input"], DEFAULTS) == c["expect"], c
    for c in E["status"]:
        assert events.view_event_status(REQUESTS[c["id"]]) == c["expect"], c
    for c in E["actions"]:
        assert events.event_actions(REQUESTS[c["id"]], actor(c["viewer"]), USERS) == c["expect"], c
    for c in E["postpones"]:
        assert events.validate_event_postpone(c["input"], DEFAULTS) == c["expect"], c
    for c in E["pipeline"]:
        assert events.can_see_pipeline_item(REQUESTS[c["id"]], actor(c["viewer"]), USERS) == c["expect"], c
    assert E["pipelineFields"] and all(list(c["expect"]) == events.PIPELINE_FIELDS for c in E["pipelineFields"])
    assert not any(c["expect"] for c in E["pipeline"] if REQUESTS[c["id"]].status == "draft"), "never drafts"
    assert not any(c["expect"] for c in E["actions"] if c["viewer"]["activeRole"] == "operations"), "Operations never changes it"
    ops = [c for c in E["canSee"] if c["viewer"]["activeRole"] == "operations"]
    assert ops and all(c["expect"] == (REQUESTS[c["id"]].status == "accepted") for c in ops), "confirmed events only"
    assert not any(c["expect"] for c in E["seePrice"] if c["viewer"]["activeRole"] in ("operations", "marketing"))


def test_reminder_rules_match_the_contract():
    for c in R["target"]:
        assert reminders.remind_target(REQUESTS[c["id"]]) == c["expect"], c["id"]
    for c in R["canRemind"]:
        assert reminders.can_remind(REQUESTS[c["id"]], actor(c["viewer"]), USERS) == c["expect"], c


def test_api_operations_sees_confirmed_events_only_without_prices(contract_api):
    karim = next(v for v in SCENARIOS["viewers"] if v["activeRole"] == "operations")
    body = contract_api.get("/api/events", headers=headers(karim)).json()
    expected = {c["id"] for c in E["canSee"] if c["viewer"] == karim and c["expect"]}
    assert {i["id"] for i in body["items"]} == expected and expected
    assert body["seePrices"] is False and all("finalPrice" not in i for i in body["items"])
    unconfirmed = next(r["id"] for r in WORLD["requests"] if r["status"] == "shared_with_client")
    assert contract_api.get(f"/api/events/{unconfirmed}", headers=headers(karim)).status_code == 404
    noha = contract_api.get("/api/events", headers=headers(SCENARIOS["viewers"][0])).json()
    assert noha["seePrices"] is True
    cancelled = next(i for i in noha["items"] if i["id"].endswith("0107"))
    assert cancelled["timing"] == "cancelled"


def shared(api):
    rid = ok(create(api, AHMED, submit=True, **{"clientId": "CL-0008", "brand": "teamup", "service": "team_building",
                                                "eventDatePrecision": "day", "eventDate": future(40), "requiredBy": future(10),
                                                "participants": 120, "requirementsSummary": "Offsite"}))["request"]["id"]
    ok(act(api, rid, "start_work", MD_AM))
    ok(upload(api, rid, MD_AM, data=sample_pdf()))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=95000))
    ok(act(api, rid, "share_with_client", AHMED, confirmShared=True, channel="email"))
    return rid


def test_mark_confirmed_records_the_event_then_change_date_and_cancel(api):
    rid = shared(api)
    r = act(api, rid, "record_accepted", AHMED)
    assert error(r)["fields"] == {"eventDate": "Enter the event date."}
    body = ok(act(api, rid, "record_accepted", AHMED, eventDate=future(41), eventEndDate=future(42), finalParticipants=110,
                  finalPrice=93000, venue="Sahel resort", teamNotes="Two buses"))["request"]
    assert (body["status"], body["subLabel"], body["eventDate"], body["finalPrice"], body["confirmedParticipants"]) == (
        "accepted", "Confirmed", future(41), 93000, 110)
    ev = api.get(f"/api/events/{rid}", headers=AHMED).json()
    assert (ev["timing"], ev["venue"], ev["teamNotes"], ev["confirmedBy"], ev["file"]["version"]) == (
        "upcoming", "Sahel resort", "Two buses", "u-ahmed", 1)
    r = api.patch(f"/api/events/{rid}/date", headers=MD_AM, json={"eventDate": future(50), "expectedRowVersion": ev["rowVersion"]})
    assert r.status_code == 403, "only the BD owner or the Commercial Head"
    moved = ok(api.patch(f"/api/events/{rid}/date", headers=AHMED,
                         json={"eventDate": future(50), "expectedRowVersion": ev["rowVersion"]}))["event"]
    assert (moved["eventDate"], moved["eventEndDate"], moved["timing"]) == (future(50), None, "upcoming")
    r = api.post(f"/api/events/{rid}/cancel", headers=NOHA, json={"reason": "other", "expectedRowVersion": moved["rowVersion"]})
    assert error(r)["fields"] == {"note": 'Add a note when choosing "Other".'}
    gone = ok(api.post(f"/api/events/{rid}/cancel", headers=NOHA,
                       json={"reason": "date_clash", "expectedRowVersion": moved["rowVersion"]}))["event"]
    assert gone["timing"] == "cancelled"
    assert [c["event"] for c in gone["changes"]] == ["event_status_set", "event_date_changed", "event_cancelled"]
    assert gone["eventStatus"] == "cancelled" and gone["eventActions"] == []


def test_one_reminder_per_recipient_per_day_and_the_bell(api, session):
    rid = ok(create(api, AHMED, submit=True, **{"clientId": "CL-0008", "brand": "teamup", "service": "team_building",
                                                "eventDatePrecision": "day", "eventDate": future(40), "requiredBy": future(10),
                                                "participants": 50, "requirementsSummary": "Offsite"}))["request"]["id"]
    assert api.post("/api/reminders", json={"requestId": rid}, headers=MD_AM).status_code == 403, "it is waiting on her"
    sent = ok(api.post("/api/reminders", json={"requestId": rid}, headers=AHMED))
    assert sent["recipient"] == "u-mariam-dimitri" and sent["count"] >= 1
    r = api.post("/api/reminders", json={"requestId": rid}, headers=NOHA)
    assert r.status_code == 409 and "last 24 hours" in error(r)["message"]
    assert "u-mariam-dimitri" in api.get("/api/reminders", headers=AHMED).json()["nextAt"]
    bell = api.get("/api/notifications", headers=MD_AM).json()
    # The new request itself was New for her (one notification), then the reminder (on top).
    assert bell["unread"] == 2 and bell["items"][0]["title"].endswith("waiting on you")
    assert bell["items"][1]["title"] == "New request from Ahmed Seif"
    assert rid in bell["items"][0]["requestIds"]
    assert detail(api, rid, NOHA)["events"][-1]["event"] == "reminder_sent"
    read = api.post("/api/notifications/read-all", headers=MD_AM).json()
    assert read["unread"] == 0
    assert api.get("/api/notifications", headers=AHMED).json()["unread"] == 0, "the sender gets nothing"


def test_setting_waiting_on_a_person_notifies_them_and_inactive_people_get_nothing(api):
    rid = ok(create(api, AHMED, submit=True, **{"clientId": "CL-0008", "brand": "teamup", "service": "team_building",
                                                "eventDatePrecision": "day", "eventDate": future(40), "requiredBy": future(10),
                                                "participants": 50, "requirementsSummary": "Offsite"}))["request"]["id"]
    v = detail(api, rid, MD_AM)["rowVersion"]
    ok(api.post(f"/api/proposal-requests/{rid}/waiting-on", headers=MD_AM,
                json={"team": "bd", "userId": "u-ahmed", "reason": "information_missing", "expectedRowVersion": v}))
    mine = api.get("/api/notifications", headers=AHMED).json()
    assert mine["unread"] == 1 and mine["items"][0]["kind"] == "waiting_on" and mine["items"][0]["link"] == f"/proposals/{rid}"
    assert timedelta(hours=reminders.REMIND_EVERY_HOURS) == timedelta(hours=24)


def test_api_operations_page_never_shows_prices_files_drafts_or_conversations(contract_api):
    karim = next(v for v in SCENARIOS["viewers"] if v["activeRole"] == "operations")
    body = contract_api.get("/api/events", headers=headers(karim)).json()
    expected = {c["id"] for c in E["pipeline"] if c["viewer"] == karim and c["expect"]}
    assert {p["id"] for p in body["pipeline"]} == expected and expected
    assert all(list(p) == events.PIPELINE_FIELDS for p in body["pipeline"]), "awareness fields only"
    assert not any(REQUESTS[p["id"]].status == "draft" for p in body["pipeline"])
    for p in body["pipeline"][:3]:  # a pipeline proposal itself stays closed: no detail, file or conversation
        assert contract_api.get(f"/api/events/{p['id']}", headers=headers(karim)).status_code == 404
        assert contract_api.get(f"/api/events/{p['id']}/file", headers=headers(karim)).status_code == 404
        assert contract_api.get(f"/api/proposal-requests/{p['id']}", headers=headers(karim)).status_code in (403, 404)
    initial = next(i for i in body["items"] if i["id"].endswith("0111"))
    assert initial["eventStatus"] == "initial" and initial["eventActions"] == [] and "finalPrice" not in initial
    postponed = next(i for i in body["items"] if i["id"].endswith("0112"))
    assert (postponed["eventStatus"], postponed["timing"], postponed["eventPostponeNote"]) == ("postponed", "postponed",
                                                                                            "Client moved the budget")
    r = contract_api.post(f"/api/events/{initial['id']}/confirm", headers=headers(karim),
                          json={"eventDate": initial["eventDate"], "expectedRowVersion": initial["rowVersion"]})
    assert r.status_code == 403, "Operations cannot change the event status"


def test_initially_confirmed_then_confirmed_postponed_and_operations_hears_each_change(api, session):
    from app.models import User, UserRole
    from app.database import utcnow
    karim = User(id="u-karim", name="Karim Adel", initials="KA", avatar_tone=1, active=True, email="karim@eventflow.example",
                 created_at=utcnow(), updated_at=utcnow())
    karim.roles = [UserRole(role="operations", position=0)]
    session.add(karim)
    session.commit()
    rid = shared(api)
    r = act(api, rid, "record_accepted", AHMED, eventDate=future(41), eventStatus="maybe")
    assert error(r)["fields"] == {"eventStatus": "Choose initially confirmed or confirmed."}
    ok(act(api, rid, "record_accepted", AHMED, eventDate=future(41), eventStatus="initial"))
    ops = as_user("u-karim", "operations")
    ev = api.get(f"/api/events/{rid}", headers=AHMED).json()
    assert (ev["eventStatus"], ev["eventActions"]) == ("initial", ["confirm", "postpone", "changeDate", "cancel"])
    seen = api.get("/api/events", headers=ops).json()
    assert rid in seen["newIds"]
    bell = api.get("/api/notifications", headers=ops).json()
    assert bell["items"][0]["kind"] == "event" and bell["items"][0]["title"].startswith("New initially confirmed event")
    assert api.get("/api/proposal-requests/new-count", headers=ops).json()["count"] == 1
    r = api.post(f"/api/events/{rid}/confirm", headers=AHMED, json={"expectedRowVersion": ev["rowVersion"]})
    assert error(r)["fields"] == {"eventDate": "Enter the event date."}
    done = ok(api.post(f"/api/events/{rid}/confirm", headers=AHMED,
                       json={"eventDate": future(42), "finalParticipants": 100, "venue": "Sahel",
                             "expectedRowVersion": ev["rowVersion"]}))["event"]
    assert (done["eventStatus"], done["eventDate"], done["venue"], done["eventActions"]) == (
        "confirmed", future(42), "Sahel", ["postpone", "changeDate", "cancel"])
    r = api.post(f"/api/events/{rid}/confirm", headers=AHMED, json={"eventDate": future(42), "expectedRowVersion": done["rowVersion"]})
    assert r.status_code == 409, "already confirmed"
    r = api.post(f"/api/events/{rid}/postpone", headers=AHMED, json={"reason": "other", "expectedRowVersion": done["rowVersion"]})
    assert error(r)["fields"] == {"note": 'Add a note when choosing "Other".'}
    held = ok(api.post(f"/api/events/{rid}/postpone", headers=AHMED,
                       json={"reason": "budget_not_approved", "expectedRowVersion": done["rowVersion"]}))["event"]
    assert (held["eventStatus"], held["timing"], held["eventActions"]) == ("postponed", "postponed", ["confirm", "changeDate", "cancel"])
    assert [c["event"] for c in held["changes"]] == ["event_status_set", "event_confirmed", "event_postponed"]
    titles = [n["title"] for n in api.get("/api/notifications", headers=ops).json()["items"]]
    assert [t.split(":")[0] for t in titles[:3]] == ["Event postponed", "Event confirmed", "New initially confirmed event"]
    assert api.post(f"/api/events/{rid}/read", headers=ops).status_code == 204
    assert api.get("/api/events", headers=ops).json()["newIds"] == []
