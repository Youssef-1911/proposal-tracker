"""
Shared contract scenarios (contracts/proposal-scenarios.json, generated from the frontend
rules). The same file is checked by frontend/tests/contracts.test.mjs, so the Python rules,
the API and the JavaScript rules must all give identical answers.
"""

import pytest

from app.clock import iso_z
from app.domain import access, rules, tracker
from app.domain.views import parse_ts, request_from_json, user_from_json
from app.domain.proposal_files import can_see_replaced_files, upload_target, validate_comment
from app.domain.workflow import can_edit_draft, get_actions
from app import config_domain as cfg
from app.identity import Actor

from .contract_world import headers, load_scenarios

SCENARIOS = load_scenarios()
TODAY = SCENARIOS["today"]
NOW = parse_ts(SCENARIOS["now"])
WORLD = SCENARIOS["world"]
USERS = {u["id"]: user_from_json(u) for u in WORLD["users"]}
REQUESTS = {r["id"]: request_from_json(r) for r in WORLD["requests"]}
REQUEST_JSON = {r["id"]: r for r in WORLD["requests"]}
CLIENT_NAMES = {c["id"]: c["name"] for c in WORLD["clients"]}
ACTION_KEYS = ("action", "label", "to", "requires", "notePrompt", "confirm", "tone", "allowed", "reason")


def actor(viewer: dict) -> Actor:
    return Actor(viewer["userId"], viewer["activeRole"])


def pick(action: dict) -> dict:
    return {k: action[k] for k in ACTION_KEYS if k in action}


def timing_json(timing: dict) -> dict:
    return {k: iso_z(v) if hasattr(v, "tzinfo") else v for k, v in timing.items()}


def versions_json(view) -> list[dict]:
    return [{**v, "readyAt": iso_z(v["readyAt"])} for v in rules.proposal_versions(view)]


def tracker_query(case) -> tracker.TrackerQuery:
    f = case["state"]["filters"]
    return tracker.TrackerQuery(
        scope=case["state"]["scope"], tab=case["state"]["tab"], sort=case["state"]["sort"],
        filters=tracker.Filters(q=f.get("q", ""), brand=f.get("brand", ""), status=f.get("status", []),
                                stage=f.get("stage", []),
                                assigned_am=f.get("assignedAM", ""), bd_owner=f.get("bdOwner", ""),
                                deadline=f.get("deadline", ""), waiting_on=f.get("waitingOn", ""), open=f.get("open", False),
                                needs_review=f.get("needsReview", False), waiting=f.get("waiting", ""),
                                hide_events=f.get("hideEvents", False), bucket=f.get("bucket", "")),
    )


def case_id(case) -> str:
    v = case["viewer"]
    return f'{v["userId"]}/{v["activeRole"]}:{case["state"]["scope"]}:{case["state"]["tab"]}:{case["state"]["sort"]}:{case["state"]["filters"]}'


# ---------------------------------------------------------------------------
# 1. Python rules == contract
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("case", SCENARIOS["requestCases"], ids=lambda c: c["id"])
def test_python_request_rules_match_contract(case):
    r = REQUESTS[case["id"]]
    assert rules.is_open_request(r) == case["isOpen"]
    assert rules.is_closed(r) == case["isClosed"]
    assert rules.waiting_on(r) == case["waitingOn"]
    assert rules.is_deadline_pending(r) == case["deadlinePending"]
    assert rules.is_request_overdue(r, TODAY) == case["isOverdue"]
    assert tracker.deadline_state(r, TODAY) == case["deadlineState"]
    assert rules.responsible_for(r) == case["responsible"]
    assert versions_json(r) == case["versions"]
    assert rules.stage_of(r.status) == case["stage"]
    assert rules.sub_label(r.status, r.version) == case["subLabel"]
    assert rules.price_per_participant(r.am_price, r.participants) == case["amPricePerParticipant"]
    assert timing_json(rules.stage_timing(r, NOW)) == case["timing"]
    for p in case["perViewer"]:
        a = actor(p["viewer"])
        label = f'{case["id"]} as {p["viewer"]}'
        assert upload_target(r, a, USERS) == p["upload"], label
        assert can_see_replaced_files(r, a) == p["seesReplacedFiles"], label
        assert access.can_see_request(r, a, USERS) == p["canView"], label
        assert access.can_comment_on_request(r, a, USERS) == p["canComment"], label
        assert can_edit_draft(r, a, USERS) == p["canEditDraft"], label
        assert tracker.needs_my_action(r, a, USERS, NOW) == p["needsMyAction"], label
        assert [pick(x) for x in get_actions(r, a, USERS)] == p["actions"], label


@pytest.mark.parametrize("case", SCENARIOS["trackerCases"], ids=case_id)
def test_python_tracker_matches_contract(case):
    a = actor(case["viewer"])
    out = tracker.query_tracker(list(REQUESTS.values()), tracker_query(case), viewer=a, users=USERS,
                                client_names=CLIENT_NAMES, today=TODAY, now=NOW)
    assert [r.id for r in out["rows"]] == case["expect"]["ids"]
    assert out["counts"] == case["expect"]["counts"]
    assert out["bucketCounts"] == case["expect"]["bucketCounts"]
    assert len(out["scoped"]) == case["expect"]["scopeSize"]


# ---------------------------------------------------------------------------
# 2. The API (SQL visibility + Python rules + serialisation) == contract
# ---------------------------------------------------------------------------

def api_params(case) -> dict:
    f, s = case["state"]["filters"], case["state"]
    params = {"scope": s["scope"], "tab": s["tab"], "sort": s["sort"], "pageSize": 100}
    for key in ("q", "brand", "assignedAM", "bdOwner", "deadline", "waitingOn", "waiting"):
        if f.get(key):
            params[key] = f[key]
    if f.get("status"):
        params["status"] = ",".join(f["status"])
    if f.get("stage"):
        params["stage"] = ",".join(f["stage"])
    if f.get("open"):
        params["open"] = "true"
    if f.get("needsReview"):
        params["needsReview"] = "true"
    if f.get("hideEvents"):
        params["hideEvents"] = "true"
    if f.get("bucket"):
        params["bucket"] = f["bucket"]
    return params


@pytest.mark.parametrize("case", SCENARIOS["trackerCases"], ids=case_id)
def test_api_tracker_matches_contract(contract_api, case):
    r = contract_api.get("/api/proposal-requests", params=api_params(case), headers=headers(case["viewer"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert [i["id"] for i in body["items"]] == case["expect"]["ids"]
    assert body["counts"] == case["expect"]["counts"]
    assert body["bucketCounts"] == case["expect"]["bucketCounts"]
    assert body["total"] == len(case["expect"]["ids"])
    assert body["scopeSize"] == case["expect"]["scopeSize"]


@pytest.mark.parametrize("case", SCENARIOS["requestCases"], ids=lambda c: c["id"])
def test_api_detail_and_allowed_actions_match_contract(contract_api, case):
    for p in case["perViewer"]:
        r = contract_api.get(f'/api/proposal-requests/{case["id"]}', headers=headers(p["viewer"]))
        label = f'{case["id"]} as {p["viewer"]}'
        if not p["canView"]:
            assert r.status_code == 404, label  # hidden draft or unseen brand: indistinguishable from "not found"
            assert r.json()["error"]["code"] == "not_found"
            continue
        assert r.status_code == 200, label
        body = r.json()
        assert [pick(a) for a in body["allowedActions"]] == p["actions"], label
        assert body["canEditDraft"] == p["canEditDraft"], label
        assert body["needsMyAction"] == p["needsMyAction"], label
        assert body["deadlineState"] == case["deadlineState"], label
        assert body["isOverdue"] == case["isOverdue"], label
        assert body["waitingOn"] == case["responsible"], label
        assert body["versions"] == case["versions"], label
        assert (body["stage"], body["subLabel"]) == (case["stage"], case["subLabel"]), label
        assert body["amPricePerParticipant"] == case["amPricePerParticipant"], label
        assert {k: body[k] for k in case["timing"]} == case["timing"], label
        assert body["upload"] == p["upload"], label
        assert sorted({f["version"] for f in body["files"]}) == sorted({f["version"] for f in REQUEST_JSON[case["id"]]["files"]})


# ---------------------------------------------------------------------------
# 3. Proposal file settings and comment validation
# ---------------------------------------------------------------------------

def test_file_settings_and_comment_limit_match_contract():
    assert SCENARIOS["proposalFiles"] == {"types": cfg.PROPOSAL_FILE_TYPES, "maxBytes": cfg.PROPOSAL_FILE_MAX_BYTES,
                                          "uploadStatuses": cfg.UPLOAD_STATUSES}
    assert SCENARIOS["commentMaxLength"] == cfg.COMMENT_MAX_LENGTH


@pytest.mark.parametrize("case", SCENARIOS["commentCases"], ids=lambda c: repr(c["body"])[:30])
def test_comment_validation_matches_contract(case):
    assert validate_comment(case["body"]) == case["expect"]
