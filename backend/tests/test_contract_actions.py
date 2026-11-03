"""
Action outcomes from the shared contract (contracts/proposal-scenarios.json, actionCases):
every lifecycle action on every request, for allowed, denied and hidden viewers, valid and
invalid input, plus Won-with-other-open-requests, Lost-blocked, reopen and Won-stays cases.

1. The pure Python rules (domain.workflow.apply_action) give the same outcome as the frontend.
2. The API (POST /api/proposal-requests/{id}/actions) gives the same outcome AND stores it:
   each case runs on a fresh copy of the contract world, then the stored request, history
   and opportunity history are read back.
"""

import shutil

import pytest

from app.database import make_engine, make_sessionmaker
from app.domain.views import client_from_json, opportunity_from_json, parse_ts, request_from_json, user_from_json
from app.domain.workflow import apply_action
from app.identity import Actor
from app.models import ProposalRequest
from app.settings import Settings

from .conftest import sqlite_url

# Opportunity history is read as the Commercial Head (an AM may not see the other brand's opportunity).
HEAD = {"X-Dev-User": "u-noha", "X-Dev-Role": "commercial_head"}
from .contract_world import add_requests, contract_client, headers, load_scenarios, load_world

SCENARIOS = load_scenarios()
NOW = parse_ts(SCENARIOS["now"])
WORLD = SCENARIOS["world"]
USERS = {u["id"]: user_from_json(u) for u in WORLD["users"]}
CLIENTS = {c["id"]: client_from_json(c) for c in WORLD["clients"]}
OPPORTUNITIES = {o["id"]: opportunity_from_json(o) for o in WORLD["opportunities"]}
CASES = SCENARIOS["actionCases"]


def python_outcome(case) -> dict:
    requests = [request_from_json(r) for r in WORLD["requests"] + case.get("extraRequests", [])]
    request = next(r for r in requests if r.id == case["requestId"])
    viewer = Actor(case["viewer"]["userId"], case["viewer"]["activeRole"])
    return apply_action(request, case["action"], case["input"], viewer=viewer, users=USERS,
                        opportunities=OPPORTUNITIES, all_requests=requests, clients=CLIENTS, now=NOW)


def test_contract_has_action_outcomes_for_every_action():
    actions = {c["action"] for c in CASES if c["expect"]["ok"]}
    assert actions == {"submit", "start_work", "request_bd_info", "provide_bd_info", "mark_ready",
                       "share_with_client", "request_revision", "start_revision", "record_accepted",
                       "record_rejected", "postpone", "resume", "cancel", "request_changes", "take_back",
                       "set_outcome_confirmed", "set_outcome_lost"}
    codes = {c["expect"].get("code") for c in CASES if not c["expect"]["ok"]}
    assert codes == {"not_found", "unknown_action", "invalid_transition", "forbidden", "precondition", "validation"}


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_python_action_outcome_matches_contract(case):
    outcome = python_outcome(case)
    outcome.pop("confirmed", None)  # "Mark confirmed" details: kept on the request, not part of the contract outcome
    assert outcome == case["expect"]


# ---------------------------------------------------------------------------
# 2. The API, on a fresh copy of the contract world per case
# ---------------------------------------------------------------------------

HTTP = {"not_found": (404, "not_found"), "unknown_action": (422, "validation_error"),
        "invalid_transition": (409, "invalid_transition"), "forbidden": (403, "forbidden"),
        "precondition": (409, "precondition_failed"),
        "validation": (422, "validation_error")}
OPTIONAL_ENTRY_KEYS = ("onBehalfOf", "amPrice", "previousRequiredBy", "requiredBy", "lostReason", "channel")
INPUT_KEYS = ("note", "amPrice", "newRequiredBy", "confirmShared", "lostReason", "channel", "followUpOn", "reasons", "eventDate", "eventEndDate",
              "finalParticipants", "finalPrice", "venue", "teamNotes", "eventStatus")


@pytest.fixture(scope="module")
def contract_template(tmp_path_factory, migrated_template):
    path = tmp_path_factory.mktemp("contract-actions") / "world.db"
    shutil.copy(migrated_template, path)
    eng = make_engine(sqlite_url(path))
    with make_sessionmaker(eng)() as session:
        load_world(session, SCENARIOS)
    eng.dispose()
    return path


@pytest.fixture
def world_for(contract_template, tmp_path):
    """Returns (client, sessionmaker) over a fresh copy of the contract world (+ the case's extra requests)."""
    engines = []

    def make(case):
        path = tmp_path / "case.db"
        shutil.copy(contract_template, path)
        url = sqlite_url(path)
        eng = make_engine(url)
        engines.append(eng)
        maker = make_sessionmaker(eng)
        if case.get("extraRequests"):
            with maker() as session:
                add_requests(session, case["extraRequests"])
                session.commit()
        client = contract_client(Settings(env="development", dev_identity=True, database_url=url), eng, SCENARIOS)
        return client, maker

    yield make
    for eng in engines:
        eng.dispose()


def _stored(maker, request_id):
    with maker() as s:
        row = s.get(ProposalRequest, request_id)
        return row.row_version, len(row.history), row.status


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_api_action_outcome_matches_contract_and_is_stored(world_for, case):
    client, maker = world_for(case)
    h = headers(case["viewer"])
    row_version, history_len, status = _stored(maker, case["requestId"])
    opp_id = next((r.get("opportunityId") for r in WORLD["requests"] + case.get("extraRequests", [])
                   if r["id"] == case["requestId"]), None)
    opp_history_before = len(client.get(f"/api/opportunities/{opp_id}", headers=HEAD).json()["history"]) if opp_id else 0

    body = {"action": case["action"], "expectedRowVersion": row_version,
            **{k: v for k, v in case["input"].items() if k in INPUT_KEYS}}
    r = client.post(f"/api/proposal-requests/{case['requestId']}/actions", json=body, headers=h)
    expect = case["expect"]

    if not expect["ok"]:
        status_code, code = HTTP[expect["code"]]
        assert (r.status_code, r.json()["error"]["code"]) == (status_code, code), r.text
        if expect["code"] != "not_found":  # the API's 404 text is shared with GET for missing requests
            assert r.json()["error"]["message"] == expect["error"]
        assert r.json()["error"].get("fields", {}) == expect["errors"]
        assert _stored(maker, case["requestId"]) == (row_version, history_len, status), "nothing saved"
        return

    assert r.status_code == 200, r.text
    out = r.json()
    assert out["message"] == expect["message"]
    assert out["warnings"] == expect["warnings"]
    req = out["request"]
    for key in ("status", "stage", "subLabel", "version", "amPrice", "requiredBy", "submittedBy", "submittedAt",
                "lastUpdated"):
        assert req[key] == expect[key], key
    assert len(req["history"]) == expect["historyLength"]
    entry = req["history"][-1]
    for key, value in expect["entry"].items():
        assert entry[key] == value, key
    for key in OPTIONAL_ENTRY_KEYS:
        if key not in expect["entry"]:
            assert entry[key] is None, key
    assert req["rowVersion"] == row_version + 1
    assert client.get(f"/api/proposal-requests/{case['requestId']}", headers=h).json() == req, "stored as returned"

    change = expect["opportunityChange"]
    if opp_id:
        opp = client.get(f"/api/opportunities/{opp_id}", headers=HEAD).json()
        if change:
            assert (opp["stage"], opp["lostReason"]) == (change["to"], change["lostReason"])
            last = opp["history"][-1]
            assert len(opp["history"]) == opp_history_before + 1
            assert (last["fromStage"], last["toStage"], last["reasonCode"], last["sourceRequestId"], last["changedBy"],
                    last["role"]) == (change["from"], change["to"], change["reasonCode"], case["requestId"],
                                      case["viewer"]["userId"], case["viewer"]["activeRole"])
            assert last["note"] == (expect["entry"]["note"] if change["to"] == "lost" else None)
            assert last["lostReason"] == change["lostReason"], "the opportunity's own history keeps the reason"
        else:
            assert len(opp["history"]) == opp_history_before, "opportunity untouched"
    else:
        assert change is None
