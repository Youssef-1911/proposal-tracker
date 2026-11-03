"""
Accounts, roles and privileges: the contract file's accountCases (generated from the frontend's
access.js and accounts.js) checked against the Python rules AND the API, so both sides give
identical answers for visibility, pages, account checks, safeguards and routing.
"""

import pytest

from app.domain import access, accounts, tracker
from app.domain.views import request_from_json, user_from_json
from app.identity import Actor

from .contract_world import headers, load_scenarios

SCENARIOS = load_scenarios()
WORLD = SCENARIOS["world"]
A = SCENARIOS["accountCases"]
USERS = {u["id"]: user_from_json(u) for u in WORLD["users"]}
ROUTING = A["routing"]
CLIENTS = {c["id"]: c for c in WORLD["clients"]}
OPPS = {o["id"]: o for o in WORLD["opportunities"]}
REQUESTS = [request_from_json(r) for r in WORLD["requests"]]


def actor(viewer: dict) -> Actor:
    return Actor(viewer["userId"], viewer["activeRole"])


def with_values(target_id: str, data: dict, users=USERS) -> dict:
    return accounts.validate_account_fields(data, users, target_id)["values"]


def label(case) -> str:
    v = case.get("viewer")
    return f'{v["userId"]}/{v["activeRole"]}' if v else str(case)[:60]


# ---------------------------------------------------------------------------
# 1. Python rules == contract
# ---------------------------------------------------------------------------

def test_privilege_defaults_and_each_persons_switches():
    for c in A["defaults"]:
        assert access.default_privileges(c["roles"]) == c["expect"], c["roles"]
    for c in A["privileges"]:
        assert access.privileges_of(USERS[c["userId"]]) == c["expect"], c["userId"]


@pytest.mark.parametrize("case", A["perViewer"], ids=label)
def test_visibility_pages_and_scopes_per_viewer(case):
    a, user = actor(case["viewer"]), USERS[case["viewer"]["userId"]]
    assert {
        "seesProposalData": access.sees_proposal_data(a.active_role),
        "visibleBrands": access.visible_brands(a, user),
        "scopes": tracker.scopes_for(a.active_role, user),
        "pages": access.page_access(a, user),
        "analytics": access.can_see_analytics(user, a),
        "analyticsBrands": access.analytics_brands(a, user),
        "manageAccounts": accounts.can_manage_accounts(a, USERS),
    } == case["expect"]


def test_client_and_opportunity_visibility():
    for c in A["clientVisibility"]:
        assert access.can_see_client(CLIENTS[c["clientId"]]["brands"], actor(c["viewer"]), USERS) == c["expect"], c
    for c in A["opportunityVisibility"]:
        assert access.can_see_opportunity(OPPS[c["opportunityId"]]["brand"], actor(c["viewer"]), USERS) == c["expect"], c


def test_account_fields_ids_and_initials():
    for c in A["fields"]:
        assert accounts.validate_account_fields(c["input"], USERS, c["id"]) == c["expect"], c["input"]
    for c in A["ids"]:
        assert accounts.new_account_id(c["name"], c["existing"]) == c["expect"], c["name"]
    for c in A["initials"]:
        assert accounts.initials_for(c["name"]) == c["expect"], c["name"]


def test_safeguards():
    for c in A["updates"]:
        values = with_values(c["targetId"], c["input"])
        assert accounts.check_account_update(USERS[c["targetId"]], values, c["actorId"], USERS, ROUTING) == c["expect"], c
    two = {**USERS, "u-doaa": user_from_json({**next(u for u in WORLD["users"] if u["id"] == "u-doaa"),
                                              "privileges": {**USERS["u-doaa"].privileges, "manageAccounts": True}})}
    for c in A["updatesWithTwoManagers"]:
        noha = USERS[c["targetId"]]
        values = with_values(c["targetId"], {**accounts.account_fields(noha),
                                              "privileges": {**access.privileges_of(noha), "manageAccounts": False}}, two)
        assert accounts.check_account_update(noha, values, c["actorId"], two, ROUTING) == c["expect"]
    for c in A["deactivate"]:
        assert accounts.can_deactivate(USERS[c["targetId"]], c["actorId"], USERS, ROUTING) == c["expect"], c
    for c in A["reactivate"]:
        assert accounts.can_reactivate(USERS[c["userId"]]) == c["expect"], c


def test_deactivation_warnings_and_history_changes():
    for c in A["warnings"]:
        assert accounts.deactivation_warnings(c["userId"], WORLD["clients"], REQUESTS) == c["expect"], c["userId"]
    for c in A["changes"]:
        values = with_values(c["userId"], c["input"])
        assert accounts.account_changes(accounts.account_fields(USERS[c["userId"]]), values) == c["expect"], c["userId"]


def test_routing_choices_and_checks():
    for c in A["routingChoices"]:
        assert [u.id for u in accounts.routing_choices(c["brand"], USERS)] == c["expect"], c["brand"]
    for c in A["routingInputs"]:
        assert accounts.validate_routing(c["brand"], c["amId"], USERS, ROUTING) == c["expect"], c


# ---------------------------------------------------------------------------
# 2. The API == contract
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("case", A["perViewer"], ids=label)
def test_api_me_reports_the_same_pages_scopes_and_privileges(contract_api, case):
    body = contract_api.get("/api/me", headers=headers(case["viewer"])).json()
    assert body["pages"] == case["expect"]["pages"]
    assert body["scopes"] == case["expect"]["scopes"]
    assert body["privileges"] == access.privileges_of(USERS[case["viewer"]["userId"]])
    analytics = contract_api.get("/api/analytics", headers=headers(case["viewer"]))
    assert analytics.status_code == (200 if case["expect"]["analytics"]["allowed"] else 403)
    if analytics.status_code == 200:
        assert analytics.json()["brands"] == case["expect"]["analyticsBrands"]


@pytest.mark.parametrize("viewer", SCENARIOS["viewers"], ids=lambda v: f'{v["userId"]}/{v["activeRole"]}')
def test_api_lists_only_the_clients_and_opportunities_the_contract_says(contract_api, viewer):
    h = headers(viewer)
    clients = {c["id"] for c in contract_api.get("/api/clients", headers=h).json()["items"]}
    opps = {o["id"] for o in contract_api.get("/api/opportunities", headers=h).json()["items"]}
    expect_clients = {c["clientId"] for c in A["clientVisibility"] if c["viewer"] == viewer and c["expect"]}
    expect_opps = {c["opportunityId"] for c in A["opportunityVisibility"] if c["viewer"] == viewer and c["expect"]}
    assert clients == expect_clients
    assert opps == expect_opps
    hidden = next((c["clientId"] for c in A["clientVisibility"] if c["viewer"] == viewer and not c["expect"]), None)
    if hidden:
        assert contract_api.get(f"/api/clients/{hidden}", headers=h).status_code == 404


# ---------------------------------------------------------------------------
# 3. Real-data phase: "Brings in clients", moving an AM's requests, event dates, follow-ups
# ---------------------------------------------------------------------------

def test_brings_in_clients_and_who_may_own_clients():
    for c in A["actsAsBD"]:
        assert access.acts_as_business_development(actor(c["viewer"]), USERS[c["viewer"]["userId"]]) == c["expect"], c
    for c in A["canOwnClients"]:
        assert access.can_own_clients(USERS[c["userId"]]) == c["expect"], c["userId"]


def test_deactivating_an_account_manager_moves_their_requests():
    for c in A["deactivationMoves"]:
        assert accounts.deactivation_move(USERS[c["userId"]], USERS, REQUESTS) == c["expect"], c["userId"]
    for c in A["deactivationMoveInputs"]:
        assert accounts.validate_deactivation_move(USERS[c["userId"]], c["input"], USERS, REQUESTS) == c["expect"], c
    assert accounts.assigned_am_change_note("Mariam Dimitri", "Hana Wahba", "Noha El Kenawy") == A["amChangeNote"]


def test_event_date_ranges_not_set_yet_and_follow_ups():
    from app.domain import crm, request_form
    from app.domain.views import client_from_json, opportunity_from_json, parse_ts
    R = SCENARIOS["realDataCases"]
    clients = {c["id"]: client_from_json(c) for c in WORLD["clients"]}
    opps = {o["id"]: opportunity_from_json(o) for o in WORLD["opportunities"]}
    for c in R["requestFields"]:
        errors, values = request_form.validate_request_fields(c["input"], mode=c["mode"], today=SCENARIOS["today"],
                                                              clients=clients, opportunities=opps)
        assert {"errors": errors, "values": values} == c["expect"], c["input"]
    for c in R["opportunityFields"]:
        assert crm.validate_opportunity_fields(c["input"], today=SCENARIOS["today"], current=None) == c["expect"], c["input"]
    by_id = {r.id: r for r in REQUESTS}
    for c in R["followUpDue"]:
        assert tracker.follow_up_due(by_id[c["id"]], parse_ts(SCENARIOS["now"])) == c["expect"], c["id"]


def test_event_names_client_search_and_event_timing():
    from app.domain import crm, events, request_form
    from app.domain.views import client_from_json, opportunity_from_json
    R = SCENARIOS["realDataCases"]
    clients = {c["id"]: client_from_json(c) for c in WORLD["clients"]}
    opps = {o["id"]: opportunity_from_json(o) for o in WORLD["opportunities"]}
    for c in R["eventNameFields"]:
        errors, values = request_form.validate_request_fields(c["input"], mode=c["mode"], today=SCENARIOS["today"],
                                                              clients=clients, opportunities=opps)
        assert {"errors": errors, "values": values} == c["expect"], c["input"]
    for c in R["opportunityEventNames"]:
        assert crm.validate_opportunity_fields(c["input"], today=SCENARIOS["today"], current=None) == c["expect"], c["input"]
    for c in R["clientSearch"]:
        assert crm.search_clients(c["query"], WORLD["clients"]) == c["expect"], c["query"]
    for c in R["didYouMean"]:
        assert crm.did_you_mean(c["name"], WORLD["clients"]) == c["expect"], c["name"]
    by_id = {r["id"]: r for r in WORLD["requests"]}
    for c in R["eventTiming"]:
        assert events.event_timing(by_id[c["id"]], SCENARIOS["today"]) == c["expect"], c["id"]


def test_api_request_list_gives_the_same_event_tabs(contract_api):
    """The Events page is built from the request list: its rows carry what the rule needs."""
    from app.domain import events
    noha = next(v for v in SCENARIOS["viewers"] if v["activeRole"] == "commercial_head")
    rows = contract_api.get("/api/proposal-requests", headers=headers(noha)).json()["items"]
    expect = {c["id"]: c["expect"] for c in SCENARIOS["realDataCases"]["eventTiming"]}
    seen = {r["id"]: events.event_timing(r, SCENARIOS["today"]) for r in rows}
    assert seen == {k: v for k, v in expect.items() if k in seen}
    assert {k for k, v in expect.items() if v} <= set(seen)
    named = next(r for r in rows if r["id"] == "PR-2026-0103")
    assert named["eventName"] == "Summer team day"
