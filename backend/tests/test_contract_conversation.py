"""
Questions & changes: the contract file's conversationCases (generated from the frontend's
conversation.js) checked against the Python rules, and the API end to end (a question answered,
details updated with the AM's banner, BD requesting changes before sharing, the AM taking back).
"""

from app.domain import conversation, lists
from app.domain.views import request_from_json, user_from_json
from app.identity import Actor

from .conftest import AHMED, MD_AM, NOHA, as_user
from .contract_world import load_scenarios
from .write_helpers import act, create, detail, error, future, ok, row_version, sample_pdf, upload

SCENARIOS = load_scenarios()
C = SCENARIOS["conversationCases"]
WORLD = SCENARIOS["world"]
USERS = {u["id"]: user_from_json(u) for u in WORLD["users"]}
REQUESTS = {r["id"]: request_from_json(r) for r in WORLD["requests"]}
DEFAULTS = lists.effective_lists()
DOAA = as_user("u-doaa", "executive")


def actor(v):
    return Actor(v["userId"], v["activeRole"])


def test_rules_match_the_contract():
    for c in C["canAsk"]:
        assert conversation.can_ask_question(REQUESTS[c["id"]], actor(c["viewer"]), USERS) == c["expect"], c
    for c in C["canPost"]:
        assert conversation.can_post_message(c["kind"], REQUESTS[c["id"]], actor(c["viewer"]), USERS) == c["expect"], c
    for c in C["canUpdateDetails"]:
        assert conversation.can_update_details(REQUESTS[c["id"]], actor(c["viewer"]), USERS) == c["expect"], c
    assert conversation.open_question_ids(C["openQuestions"]["messages"]) == C["openQuestions"]["expect"]
    for c in C["messages"]:
        got = conversation.validate_message(c["input"], lists=DEFAULTS, messages=C["openQuestions"]["messages"])
        assert got == c["expect"], c["input"]
    for c in C["details"]:
        got = conversation.validate_details_update(REQUESTS[c["id"]], c["input"], today=SCENARIOS["today"], lists=DEFAULTS)
        assert got == c["expect"], c
    for c in C["changeKind"]:
        assert conversation.change_kind(REQUESTS[c["id"]], c["version"]) == c["expect"], c


def full_request(**over):
    return {"clientId": "CL-0008", "brand": "teamup", "service": "team_building", "eventDatePrecision": "day",
            "eventDate": future(40), "requiredBy": future(10), "participants": 120, "requirementsSummary": "Offsite", **over}


def post(api, rid, who, **message):
    return api.post(f"/api/proposal-requests/{rid}/comments", json=message, headers=who)


def ready(api):
    rid = ok(create(api, AHMED, submit=True, **full_request()))["request"]["id"]
    ok(act(api, rid, "start_work", MD_AM))
    ok(upload(api, rid, MD_AM, data=sample_pdf()))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=95000))
    return rid


def test_a_question_is_open_until_answered_and_never_changes_the_status(api):
    rid = ok(create(api, AHMED, submit=True, **full_request()))["request"]["id"]
    ok(act(api, rid, "start_work", MD_AM))
    q = ok(post(api, rid, MD_AM, kind="question", body="Indoor or outdoor?", about="venue"))["comment"]
    body = detail(api, rid, AHMED)
    assert (body["status"], body["openQuestions"]) == ("in_progress", 1)
    assert post(api, rid, DOAA, kind="question", body="Can I ask?").status_code == 403, "Executives comment only"
    assert ok(post(api, rid, DOAA, body="Looks good"))["comment"]["kind"] == "comment"
    ok(post(api, rid, AHMED, kind="answer", body="Outdoor, in the garden", parentId=q["id"]))
    assert detail(api, rid, MD_AM)["openQuestions"] == 0
    r = post(api, rid, AHMED, kind="answered", parentId=q["id"])
    assert error(r)["fields"] == {"parentId": "This question is already answered."}


def test_bd_updates_details_and_the_am_sees_what_changed(api):
    rid = ready(api)
    r = api.patch(f"/api/proposal-requests/{rid}/details", headers=MD_AM,
                  json={"participants": 150, "expectedRowVersion": row_version(api, rid, MD_AM)})
    assert r.status_code == 403
    body = ok(api.patch(f"/api/proposal-requests/{rid}/details", headers=AHMED,
                        json={"participants": 150, "note": "They confirmed more people",
                              "expectedRowVersion": row_version(api, rid, AHMED)}))["request"]
    assert body["participants"] == 150 and body["status"] == "ready_for_bd"
    event = body["events"][-1]
    assert event["event"] == "details_updated"
    assert event["details"]["changes"] == [{"field": "participants", "label": "Participants", "from": 120, "to": 150}]
    am = detail(api, rid, MD_AM)
    assert am["detailsChangedAt"] and am["detailsSeenAt"] is None
    seen = ok(api.post(f"/api/proposal-requests/{rid}/details/seen", headers=MD_AM,
                       json={"expectedRowVersion": am["rowVersion"]}))["request"]
    assert seen["detailsSeenAt"] >= seen["detailsChangedAt"]
    r = api.patch(f"/api/proposal-requests/{rid}/details", headers=AHMED,
                  json={"participants": 150, "expectedRowVersion": row_version(api, rid, AHMED)})
    assert error(r)["message"] == "Nothing changed."


def test_bd_requests_changes_before_sharing_an_internal_change(api):
    rid = ready(api)
    body = ok(act(api, rid, "request_changes", AHMED, reasons=["price", "design"]))["request"]
    assert (body["status"], body["version"]) == ("revision_requested", 1)
    body = ok(act(api, rid, "start_revision", MD_AM))["request"]
    assert (body["status"], body["version"]) == ("in_progress", 2), "v1 and its file stay in the history"


def test_the_am_takes_a_ready_proposal_back_but_not_after_sharing(api):
    rid = ready(api)
    body = ok(act(api, rid, "take_back", MD_AM, note="Fix the transport"))["request"]
    assert (body["status"], body["version"], body["amPrice"]) == ("in_progress", 2, None)
    ok(upload(api, rid, MD_AM, data=sample_pdf("v2")))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=90000, note="Cheaper buses"))
    ok(act(api, rid, "share_with_client", AHMED, confirmShared=True, channel="email"))
    assert act(api, rid, "take_back", MD_AM).status_code == 409


def test_a_bd_question_while_ready_blocks_nothing(api):
    rid = ready(api)
    ok(post(api, rid, AHMED, kind="question", body="Can we add a photographer?", about="activities"))
    assert detail(api, rid, MD_AM)["openQuestions"] == 1
    ok(act(api, rid, "share_with_client", AHMED, confirmShared=True, channel="email"))
    assert detail(api, rid, NOHA)["status"] == "shared_with_client"
