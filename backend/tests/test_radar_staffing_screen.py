"""
Repeat-client radar, HR staffing and the office screen:
- the radar and staffing rules match the contract (occasion window, repeat rhythm, an open request
  suppresses, "Not this time"; suggestion, totals, same-day clash, ratings, duplicates, who may);
- HR sees only initially confirmed / confirmed / done events, never prices, files, conversations or proposals;
- assigning warns (never blocks) on a same-day clash; adding a facilitator while assigning; ratings once per
  person per event, locked after 7 days, averages;
- the office screen shows no prices, contacts, drafts or conversations, and its account can open nothing else.
"""

from datetime import datetime, timedelta, timezone

from app.clock import get_now
from app.database import utcnow
from app.domain import radar, staffing
from app.domain.views import request_from_json, user_from_json
from app.identity import Actor
from app.models import FacilitatorRating, User, UserRole

from .conftest import AHMED, MD_AM, NOHA, as_user
from .contract_world import headers, load_scenarios
from .write_helpers import act, cl, create, detail, error, future, ok, sample_pdf, upload

SCENARIOS = load_scenarios()
RC, SC = SCENARIOS["radarCases"], SCENARIOS["staffingCases"]
USERS = {u["id"]: user_from_json(u) for u in SCENARIOS["world"]["users"]}
REQUESTS = {r["id"]: request_from_json(r) for r in SCENARIOS["world"]["requests"]}
CLARA = as_user("u-clara", "hr")
OPS = as_user("u-omar", "operations")
SCREEN = as_user("u-tv", "office_screen")


def actor(v):
    return Actor(v["userId"], v["activeRole"])


def test_radar_rules_match_the_contract():
    for run in RC["runs"]:
        got = radar.radar_items(RC["requests"], RC["periods"], run["dismissals"], RC["clients"], RC["today"])
        assert got == run["expect"], run["dismissals"]
    first = RC["runs"][0]["expect"]
    assert {(i["clientId"], i["signal"]) for i in first} == {("c-a", "occasion:1"), ("c-d", "rhythm"), ("c-c", "rhythm")}
    assert all(i["clientId"] != "c-b" for i in first), "an open request for the occasion suppresses it"
    assert ("c-a", "occasion:1") not in {(i["clientId"], i["signal"]) for i in RC["runs"][1]["expect"]}, "Not this time"


def test_staffing_rules_match_the_contract():
    for c in SC["suggested"]:
        assert staffing.suggested_needed(c["participants"], c["per"]) == c["expect"], c
    assert staffing.staffing_totals(SC["totals"]["events"]) == SC["totals"]["expect"]
    for c in SC["clashes"]:
        assert staffing.clashes(c["event"], c["others"]) == c["expect"], c
    for c in SC["ratings"]:
        assert staffing.validate_rating(c["input"]) == c["expect"], c
    for c in SC["records"]:
        assert staffing.facilitator_record(c["ratings"], c["done"]) == c["expect"], c
    for c in SC["duplicates"]:
        existing = [{"id": 1, "name": "Ahmed Samir", "phone": "+20 100 123 4567"}, {"id": 2, "name": "Mona", "phone": "0100-123-4567"}]
        assert staffing.possible_duplicates(c["input"], existing) == c["expect"], c
    am = type("R", (), {"assigned_am": "u-mariam-dimitri"})()
    for c in SC["permissions"]:
        a = actor(c["viewer"])
        assert (staffing.can_set_facilitators_needed(am, a), staffing.can_see_ratings(a), staffing.can_rate(a)) == (
            c["needed"], c["seeRatings"], c["rate"]), c


def test_hr_sees_only_confirmed_events_without_prices_files_or_conversations(contract_api):
    clara = {"userId": "u-clara", "activeRole": "hr"}
    body = contract_api.get("/api/events", headers=headers(clara)).json()
    expected = {c["id"] for c in SCENARIOS["eventCases"]["canSee"] if c["viewer"] == clara and c["expect"]}
    assert {i["id"] for i in body["items"]} == expected and expected
    assert all(REQUESTS[i].event_status in (None, "initial", "confirmed") for i in expected), "never postponed or cancelled"
    assert all("finalPrice" not in i for i in body["items"]) and body["pipeline"] == [], "no prices, no pipeline"
    ev = contract_api.get(f"/api/events/{next(iter(expected))}", headers=headers(clara)).json()
    assert (ev["file"], ev["comments"], ev["contact"], ev["canOpenRequest"]) == (None, [], None, False)
    assert contract_api.get("/api/proposal-requests", headers=headers(clara)).status_code == 403, "no proposals"
    assert contract_api.post(f"/api/events/{ev['id']}/comments", headers=headers(clara), json={"body": "hi"}).status_code == 403


def add_people(session):
    for uid, name, role in (("u-clara", "Clara Eshak", "hr"), ("u-omar", "Omar Ops", "operations"), ("u-tv", "Office TV", "office_screen")):
        u = User(id=uid, name=name, initials=name[:2].upper(), avatar_tone=1, active=True, email=f"{uid}@eventflow.example",
                 job_title="HR" if role == "hr" else None, created_at=utcnow(), updated_at=utcnow())
        u.roles = [UserRole(role=role, position=0)]
        session.add(u)
    session.commit()


def confirmed_event(api, day=5):
    rid = ok(create(api, AHMED, submit=True, clientId=cl(8), brand="teamup", service="team_building", eventDatePrecision="day",
                    eventDate=future(40), requiredBy=future(10), participants=60, requirementsSummary="Offsite"))["request"]["id"]
    ok(act(api, rid, "start_work", MD_AM))
    ok(upload(api, rid, MD_AM, data=sample_pdf()))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=90000))
    ok(act(api, rid, "share_with_client", AHMED, confirmShared=True, channel="email"))
    ok(act(api, rid, "record_accepted", AHMED, eventDate=future(day), finalParticipants=60))
    return rid


def test_staffing_assign_clash_ratings_and_who_sees_them(api, session):
    add_people(session)
    a, b = confirmed_event(api), confirmed_event(api)
    # Facilitators needed: Operations sets it, HR is told; HR cannot set it.
    ev = api.get(f"/api/events/{a}", headers=OPS).json()
    assert api.patch(f"/api/events/{a}/facilitators-needed", headers=CLARA, json={"value": 4}).status_code == 403
    ok(api.patch(f"/api/events/{a}/facilitators-needed", headers=OPS, json={"value": 4, "expectedRowVersion": ev["rowVersion"]}))
    assert api.get("/api/notifications", headers=CLARA).json()["items"][0]["title"].startswith("Facilitators needed: 4")
    # Add a facilitator while assigning (one step); a duplicate phone is caught; a same-day booking only warns.
    r = api.post(f"/api/events/{a}/facilitators", headers=CLARA,
                 json={"newFacilitator": {"name": "Ahmed Samir", "phone": "0100 123 4567", "skills": ["kids"], "brands": ["teamup"]}})
    fid = ok(r)["facilitator"]["id"]
    r = api.post(f"/api/events/{b}/facilitators", headers=CLARA, json={"newFacilitator": {"name": "A. Samir", "phone": "01001234567"}})
    assert r.status_code == 409 and error(r)["code"] == "possible_duplicate"
    out = ok(api.post(f"/api/events/{b}/facilitators", headers=CLARA, json={"facilitatorId": fid}))
    assert out["warnings"] and out["warnings"][0]["code"] == "same_day", "a warning, never a block"
    st = api.get(f"/api/events/{a}", headers=OPS).json()["staffing"]
    assert (st["needed"], st["assigned"], st["missing"]) == (4, 1, 3)
    assert not api.get(f"/api/events/{a}", headers=NOHA).json().get("staffing"), "Noha sees no staffing"
    totals = api.get("/api/staffing", headers=CLARA).json()["items"]
    assert {i["id"]: (i["facilitatorsNeeded"], i["assignedCount"]) for i in totals}[a] == (4, 1)
    # Ratings only once the event is done; once per person; locked after 7 days.
    assert api.post(f"/api/events/{a}/facilitators/{fid}/rating", headers=CLARA, json={"attended": True, "stars": 5}).status_code == 409
    later = datetime.now(timezone.utc) + timedelta(days=6)
    api.app.dependency_overrides[get_now] = lambda: later
    ok(api.post(f"/api/events/{a}/facilitators/{fid}/rating", headers=CLARA, json={"attended": True, "stars": 5, "feedback": "Great"}))
    ok(api.post(f"/api/events/{a}/facilitators/{fid}/rating", headers=OPS, json={"attended": True, "stars": 4}))
    ok(api.post(f"/api/events/{a}/facilitators/{fid}/rating", headers=CLARA, json={"attended": True, "stars": 4, "feedback": "Great"}))  # an edit
    assert session.query(FacilitatorRating).filter_by(request_id=a, facilitator_id=fid).count() == 2, "one per person"
    assert api.post(f"/api/events/{a}/facilitators/{fid}/rating", headers=AHMED, json={"attended": True, "stars": 1}).status_code == 403
    prof = api.get(f"/api/facilitators/{fid}", headers=CLARA).json()
    assert (prof["average"], prof["ratingCount"], prof["eventsAttended"]) == (4.0, 2, 1)
    assert prof["feedback"][0]["feedback"] == "Great" and prof["feedback"][0]["rater"] == "Clara Eshak"
    assert api.get(f"/api/facilitators/{fid}", headers=AHMED).status_code == 403, "BD never sees ratings"
    assert "staffing" not in api.get(f"/api/events/{a}", headers=AHMED).json(), "BD sees no staffing or ratings"
    api.app.dependency_overrides[get_now] = lambda: later + timedelta(days=8)
    r = api.post(f"/api/events/{a}/facilitators/{fid}/rating", headers=CLARA, json={"attended": True, "stars": 1})
    assert r.status_code == 409 and error(r)["code"] == "locked"
    api.app.dependency_overrides.pop(get_now)


def test_office_screen_privacy_and_its_account_opens_nothing_else(api, session):
    add_people(session)
    confirmed_event(api, day=2)
    ok(create(api, AHMED, clientId=cl(8), brand="teamup", service="team_building"))  # a draft: never on the screen
    body = api.get("/api/screen", headers=SCREEN)
    assert body.status_code == 200
    text = body.text.lower()
    assert "price" not in text and "contact" not in text and "phone" not in text and "comment" not in text
    data = body.json()
    assert data["week"] and data["confirmations"] and "count" in data["preparing"]
    assert set(data["month"]) == {"confirmed", "decided", "received"}
    for path in ("/api/proposal-requests", "/api/events", "/api/analytics", "/api/notifications", "/api/facilitators"):
        assert api.get(path, headers=SCREEN).status_code == 403, path
    assert api.post("/api/proposal-requests", headers=SCREEN, json={}).status_code == 403
    assert api.get("/api/clients", headers=SCREEN).json()["items"] == [], "the app can start, but sees no client"
    assert api.get("/api/screen", headers=NOHA).status_code == 200
    assert api.get("/api/screen", headers=AHMED).status_code == 403
    assert detail(api, data["confirmations"][0]["id"], NOHA)["status"] == "accepted"


def test_radar_api_occasion_dates_tag_dismiss_and_counts(api, session):
    from app.models import Occasion, ProposalRequest
    from datetime import date
    ramadan = session.query(Occasion).filter_by(name="Ramadan").one()
    assert api.post(f"/api/occasions/{ramadan.id}/periods", headers=AHMED, json={"startsOn": future(20), "endsOn": future(50)}).status_code == 403
    ok(api.post(f"/api/occasions/{ramadan.id}/periods", headers=NOHA, json={"startsOn": future(-330), "endsOn": future(-300)}))
    ok(api.post(f"/api/occasions/{ramadan.id}/periods", headers=NOHA, json={"startsOn": future(35), "endsOn": future(64)}))
    rid = confirmed_event(api)
    row = session.get(ProposalRequest, rid)
    row.occasion_id, row.submitted_at = ramadan.id, datetime(2025, 11, 1, tzinfo=timezone.utc)
    row.event_date = date.fromisoformat(future(-310))
    session.commit()
    items = api.get("/api/radar", headers=AHMED).json()["items"]
    mine = [i for i in items if i["signal"] == f"occasion:{ramadan.id}"]
    assert mine and "Ramadan starts in about 5 weeks. No request yet." in mine[0]["sentence"]
    assert api.get("/api/radar", headers=MD_AM).json()["items"] == [], "the radar is for BD and management"
    ok(api.post("/api/radar/dismiss", headers=AHMED, json={"clientId": mine[0]["clientId"], "signal": mine[0]["signal"],
                                                          "reason": "They told us not this year"}))
    assert not [i for i in api.get("/api/radar", headers=AHMED).json()["items"] if i["signal"] == mine[0]["signal"]]
    # "Create request from previous": the new request remembers the occasion and that it came from the radar.
    new = ok(create(api, AHMED, clientId=cl(8), brand="teamup", service="team_building", occasionId=ramadan.id, fromRadar=True))
    assert new["request"]["occasionId"] == ramadan.id
    assert api.get("/api/radar", headers=NOHA).json()["turnedIntoRequests"] == 1
