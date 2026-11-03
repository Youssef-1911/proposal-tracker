"""CRM 1 rules (domain/crm.py) against the shared contract (crmCases, generated from frontend/src/domain/crm.js)."""

import pytest

from app.domain import crm
from app.domain.views import request_from_json, user_from_json
from app.identity import Actor

from .contract_world import load_scenarios

SCENARIOS = load_scenarios()
CASES = SCENARIOS["crmCases"]
WORLD = SCENARIOS["world"]
USERS = {u["id"]: user_from_json(u) for u in WORLD["users"]}
CLIENTS = [{**c, "contacts": c.get("contacts", [c["contact"]])} for c in WORLD["clients"]]
ARCHIVED = {**next(c for c in CLIENTS if c["id"] == "c-08"), "id": "c-99", "archivedAt": SCENARIOS["now"]}
CLIENT = {c["id"]: c for c in [*CLIENTS, ARCHIVED]}
OPPS = {o["id"]: o for o in WORLD["opportunities"]}
REQUESTS = [request_from_json(r) for r in WORLD["requests"]]


def actor(v):
    return Actor(v["userId"], v["activeRole"])


def test_permissions_match_contract():
    for c in CASES["clientPermissions"]:
        assert crm.client_permissions(CLIENT[c["clientId"]], actor(c["viewer"]), USERS) == c["expect"], c
    for c in CASES["createClient"]:
        assert crm.can_create_client(actor(c["viewer"]), USERS) == c["expect"], c
    for c in CASES["newClientOwner"]:
        assert crm.new_client_owner(actor(c["viewer"]), c["requested"], USERS) == c["expect"], c
    for c in CASES["opportunityPermissions"]:
        o = OPPS[c["opportunityId"]]
        got = {"edit": crm.can_edit_opportunity(o, actor(c["viewer"]), USERS), "targets": crm.manual_stage_targets(o)}
        assert got == c["expect"], c


@pytest.mark.parametrize("case", CASES["stageMoves"], ids=lambda c: f'{c["opportunityId"]}:{c["input"]}')
def test_stage_moves_match_contract(case):
    assert crm.validate_stage_move(OPPS[case["opportunityId"]], case["input"]) == case["expect"]


def test_field_validation_matches_contract():
    for c in CASES["clientFields"]:
        assert crm.validate_client_fields(c["input"]) == c["expect"], c["input"]
    for c in CASES["contactFields"]:
        assert crm.validate_contact_fields(c["input"]) == c["expect"], c["input"]
    for c in CASES["opportunityFields"]:
        got = crm.validate_opportunity_fields(c["input"], today=SCENARIOS["today"], current=c["current"])
        assert got == c["expect"], c["input"]
    for c in CASES["transferInputs"]:
        assert crm.validate_transfer(CLIENT[c["clientId"]], c["input"], USERS) == c["expect"], c["input"]


def test_duplicates_and_phones_match_contract():
    for c in CASES["phones"]:
        assert crm.normalize_phone(c["phone"]) == c["expect"], c["phone"]
    for c in CASES["duplicates"]:
        assert crm.find_possible_duplicate_clients(c["candidate"], CLIENTS) == c["expect"], c["candidate"]


def test_transfer_plans_match_contract():
    for c in CASES["transfers"]:
        got = crm.transfer_plan(CLIENT[c["clientId"]], opportunities=list(OPPS.values()), requests=REQUESTS,
                                move_requests=c["moveRequests"])
        assert got == c["expect"], c
