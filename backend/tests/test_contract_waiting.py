"""
"Where is it / Waiting on", the dropdown lists and brief tags: the contract file's waitingCases
(generated from the frontend's waiting.js, lists.js and workflow.js) checked against the Python
rules and the API.
"""

import pytest

from app.domain import lists, request_form, waiting
from app.domain.views import client_from_json, opportunity_from_json, request_from_json, user_from_json
from app.identity import Actor

from .contract_world import headers, load_scenarios

SCENARIOS = load_scenarios()
W = SCENARIOS["waitingCases"]
WORLD = SCENARIOS["world"]
USERS = {u["id"]: user_from_json(u) for u in WORLD["users"]}
REQUESTS = {r["id"]: request_from_json(r) for r in WORLD["requests"]}
DEFAULTS = lists.effective_lists()


def actor(v):
    return Actor(v["userId"], v["activeRole"])


def pick(w):
    return None if w is None else {k: w[k] for k in ("kind", "team", "userId", "reason", "expectedBy")}


def test_the_lists_are_the_same():
    assert W["lists"] == {"definitions": lists.LIST_DEFS, "defaults": lists.DEFAULT_LISTS}
    assert lists.effective_lists(W["overrides"]["rows"]) == W["overrides"]["expect"]
    for c in W["listChanges"]:
        assert lists.validate_list_change(DEFAULTS, c["listId"], c["input"]) == c["expect"], c


def test_effective_waiting_for_every_request():
    for c in W["effective"]:
        assert pick(waiting.effective_waiting(REQUESTS[c["id"]])) == c["expect"], c["id"]


def test_who_may_set_and_clear():
    for c in W["canSet"]:
        assert waiting.can_set_waiting_on(REQUESTS[c["id"]], actor(c["viewer"]), USERS) == c["expect"], c
    for c in W["canClear"]:
        assert waiting.can_clear_waiting_on(REQUESTS[c["id"]], actor(c["viewer"]), USERS) == c["expect"], c


def test_validation():
    for c in W["validate"]:
        assert waiting.validate_waiting_on(c["input"], lists=DEFAULTS, users=USERS, today=SCENARIOS["today"]) == c["expect"], c


def test_brief_tags():
    clients = {c["id"]: client_from_json(c) for c in WORLD["clients"]}
    opps = {o["id"]: opportunity_from_json(o) for o in WORLD["opportunities"]}
    for c in W["briefTagFields"]:
        errors, values = request_form.validate_request_fields(c["input"], mode=c["mode"], today=SCENARIOS["today"],
                                                              clients=clients, opportunities=opps)
        assert {"errors": errors, "values": values} == c["expect"], c["input"]


@pytest.mark.parametrize("case", [c for c in W["canSet"] if c["expect"]["allowed"]][:6],
                         ids=lambda c: f'{c["id"]}/{c["viewer"]["userId"]}')
def test_api_set_then_clear(contract_api, case):
    """The API applies the same permission, records the change, and Clear returns it to automatic."""
    h = headers(case["viewer"])
    detail = contract_api.get(f"/api/proposal-requests/{case['id']}", headers=h).json()
    assert detail["waitingPermissions"]["set"] == case["expect"]
    r = contract_api.post(f"/api/proposal-requests/{case['id']}/waiting-on", headers=h, json={
        "team": "client", "reason": "final_numbers", "expectedRowVersion": detail["rowVersion"]})
    assert r.status_code == 200, r.text
    body = r.json()["request"]
    assert body["waiting"]["team"] == "client" and body["waiting"]["reason"] == "final_numbers"
    assert body["events"][-1]["event"] == "waiting_on_set"
    r = contract_api.post(f"/api/proposal-requests/{case['id']}/waiting-on/clear", headers=h,
                          json={"expectedRowVersion": body["rowVersion"]})
    assert r.status_code == 200, r.text
    assert r.json()["request"]["waiting"] is None


def test_api_refuses_people_who_may_not_set_it(contract_api):
    case = next(c for c in W["canSet"] if not c["expect"]["allowed"] and c["viewer"]["activeRole"] != "executive"
                and c["expect"]["reason"].startswith("Only"))
    h = headers(case["viewer"])
    got = contract_api.get(f"/api/proposal-requests/{case['id']}", headers=h)
    version = got.json()["rowVersion"] if got.status_code == 200 else 1
    r = contract_api.post(f"/api/proposal-requests/{case['id']}/waiting-on", headers=h,
                          json={"team": "client", "reason": "final_numbers", "expectedRowVersion": version})
    assert r.status_code in (403, 404)
