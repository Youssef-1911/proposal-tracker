"""
Communication between BD and AM, impossible to miss: the contract file's activityCases (generated from
the frontend's activity.js) against the Python rules, and the API end to end for every message type:
who is told (with the actual words, once), "New for you" on every row, the count, and opening clears it.
"""

from app.domain import activity, conversation
from app.domain.views import request_from_json, user_from_json
from app.identity import Actor
from app.models import Notification

from .conftest import AHMED, MD_AM, NOHA, as_user
from .contract_world import load_scenarios
from .write_helpers import act, create, detail, error, future, ok, sample_pdf, upload

SCENARIOS = load_scenarios()
A = SCENARIOS["activityCases"]
WORLD = SCENARIOS["world"]
USERS = {u["id"]: user_from_json(u) for u in WORLD["users"]}
RAW = {r["id"]: r for r in WORLD["requests"]}
REQUESTS = {k: request_from_json(v) for k, v in RAW.items()}
SHERINE = as_user("u-sherine", "business_development")


def test_rules_match_the_contract():
    for c in A["mentions"]:
        assert activity.find_mentions(c["body"], list(USERS.values())) == c["expect"], c["body"]
    convo = RAW[A["openChanges"]["id"]]
    messages = convo["comments"]
    for c in A["recipients"]:
        m = next(x for x in messages if x["id"] == c["messageId"])
        assert activity.message_recipients(m, REQUESTS[c["id"]], USERS, messages) == c["expect"], c
    for c in A["extraRecipients"]:
        assert activity.message_recipients(c["message"], REQUESTS[c["id"]], USERS, messages) == c["expect"], c
    assert conversation.open_change_ids(messages) == A["openChanges"]["expect"]
    for c in A["newForYou"]:
        viewer = Actor(c["viewer"]["userId"], c["viewer"]["activeRole"])
        got = activity.new_for_you(REQUESTS[c["id"]], viewer, c["lastReadAt"], USERS, RAW[c["id"]].get("comments") or [],
                                   RAW[c["id"]].get("events") or [])
        assert (got and {"line": got["line"], "count": got["count"]}) == c["expect"], c
    for c in A["newRecipients"]:
        raw = RAW[c["id"]]
        items = activity.activity_items(REQUESTS[c["id"]], USERS, raw.get("comments") or [], raw.get("events") or [])
        assert items[c["index"]]["line"] == c["line"] and activity.new_recipients(items[c["index"]], USERS) == c["expect"], c


def test_two_roles_own_actions_are_never_new():
    """Mariam El Khayat submits as BD and changes the details: nothing of her own is new for her, in either role."""
    rid = next(c["id"] for c in A["newForYou"] if c["id"].endswith("0113"))
    mine = [c for c in A["newForYou"] if c["id"] == rid and c["viewer"]["userId"] == "u-mariam-elkhayat"]
    assert mine and all(c["expect"] is None for c in mine)
    assert not any(c["expect"] for c in A["newRecipients"] if c["id"] == rid), "and no bell"


def full_request(**over):
    return {"clientId": "CL-0008", "brand": "teamup", "service": "team_building", "eventDatePrecision": "day",
            "eventDate": future(40), "requiredBy": future(10), "participants": 150, "requirementsSummary": "Offsite", **over}


def post(api, rid, who, **message):
    return api.post(f"/api/proposal-requests/{rid}/comments", json=message, headers=who)


def bell(api, who):
    return api.get("/api/notifications", headers=who).json()


def row_of(api, rid, who):
    items = api.get("/api/proposal-requests", params={"pageSize": 100}, headers=who).json()["items"]
    return next(i for i in items if i["id"] == rid)


def test_question_answer_and_new_for_you_then_opening_clears_it(api, session):
    rid = ok(create(api, AHMED, submit=True, **full_request()))["request"]["id"]
    assert row_of(api, rid, MD_AM)["newForYou"]["line"] == "New request from Ahmed Seif"
    ok(act(api, rid, "start_work", MD_AM))
    ok(post(api, rid, MD_AM, kind="question", body="Is the 150 participants final?"))
    assert bell(api, AHMED)["items"][0]["title"] == 'Mariam Dimitri asked: "Is the 150 participants final?"'
    assert bell(api, NOHA)["unread"] == 0, "Noha is told only when mentioned or for a change"
    assert row_of(api, rid, AHMED)["newForYou"]["line"] == "New question from Mariam Dimitri"
    count = api.get("/api/proposal-requests/new-count", headers=AHMED).json()["count"]
    assert count >= 1
    assert api.post(f"/api/proposal-requests/{rid}/read", headers=AHMED).status_code == 200
    assert row_of(api, rid, AHMED)["newForYou"] is None, "opening it clears it for him"
    assert api.get("/api/proposal-requests/new-count", headers=AHMED).json()["count"] == count - 1
    assert detail(api, rid, AHMED)["lastReadAt"] is not None
    q = detail(api, rid, AHMED)["comments"][0]
    ok(post(api, rid, AHMED, kind="answer", body="Yes, final.", parentId=q["id"]))
    assert bell(api, MD_AM)["items"][0]["title"] == "Ahmed Seif answered your question"
    assert row_of(api, rid, MD_AM)["newForYou"]["line"] == "Ahmed Seif answered your question"
    assert session.query(Notification).filter_by(user_id="u-ahmed", kind="message").count() == 1, "no duplicates"


def test_a_message_with_a_mention_reaches_the_mentioned_person(api):
    rid = ok(create(api, AHMED, submit=True, **full_request()))["request"]["id"]
    ok(post(api, rid, MD_AM, body="Draft ready — @Noha El Kenawy please look"))
    assert bell(api, NOHA)["items"][0]["title"].startswith('Mariam Dimitri: "Draft ready')
    assert bell(api, AHMED)["unread"] == 1


def test_change_needed_before_sharing_is_an_internal_change_and_the_am_picks_it_up(api):
    rid = ok(create(api, AHMED, submit=True, **full_request()))["request"]["id"]
    ok(act(api, rid, "start_work", MD_AM))
    ok(upload(api, rid, MD_AM, data=sample_pdf()))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=95000))
    assert post(api, rid, MD_AM, kind="change", reasons=["price"], about="internal").status_code == 403
    r = post(api, rid, AHMED, kind="change", reasons=[], about="client")
    assert error(r)["fields"] == {"reasons": "Choose what should change."}
    ok(post(api, rid, AHMED, kind="change", reasons=["price", "design"], about="internal", body="Too expensive"))
    d = detail(api, rid, MD_AM)
    assert d["status"] == "revision_requested", "back to the AM as an internal change, in the same transaction"
    assert bell(api, MD_AM)["items"][0]["title"] == "Change needed (internal): price, design"
    assert bell(api, NOHA)["items"][0]["title"] == "Change needed (internal): price, design", "Noha is told about changes"
    change = next(c for c in d["comments"] if c["kind"] == "change")
    assert post(api, rid, AHMED, kind="picked_up", parentId=change["id"]).status_code == 403
    ok(post(api, rid, MD_AM, kind="picked_up", parentId=change["id"]))
    r = post(api, rid, MD_AM, kind="picked_up", parentId=change["id"])
    assert error(r)["fields"] == {"parentId": "This change is already picked up."}


def test_change_needed_after_sharing_is_a_client_revision_with_a_new_deadline(api):
    rid = ok(create(api, AHMED, submit=True, **full_request()))["request"]["id"]
    ok(act(api, rid, "start_work", MD_AM))
    ok(upload(api, rid, MD_AM, data=sample_pdf()))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=95000))
    ok(act(api, rid, "share_with_client", AHMED, confirmShared=True, channel="email"))
    r = post(api, rid, AHMED, kind="change", reasons=["date"], about="client", body="They moved the date")
    assert r.status_code == 422 and "newRequiredBy" in error(r)["fields"], "nothing saved without the new deadline"
    assert all(c["kind"] != "change" for c in detail(api, rid, AHMED)["comments"])
    ok(post(api, rid, AHMED, kind="change", reasons=["date"], about="client", body="They moved the date",
            newRequiredBy=future(5)))
    d = detail(api, rid, AHMED)
    assert (d["status"], d["requiredBy"]) == ("revision_requested", future(5))
