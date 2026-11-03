"""
1:1 port of frontend/tests/tracker.test.mjs (see tests/PORTING.md).
Runs against the API over the shared contract world (clock frozen), so it tests the
server end to end: SQL visibility, rules, serialisation.
"""

import pytest

from app.config_domain import PROPOSAL_STATUSES
from app.domain import tracker
from app.domain.views import parse_ts

from .contract_world import load_scenarios

S = load_scenarios()
Y = S["today"][:4]
REQ = {r["id"]: r for r in S["world"]["requests"]}
STATUS_CLOSED = {s["id"] for s in PROPOSAL_STATUSES if s["closed"]}  # Confirmed, Lost, Cancelled and the closed history

NOHA = {"X-Dev-User": "u-noha", "X-Dev-Role": "commercial_head"}
AHMED = {"X-Dev-User": "u-ahmed", "X-Dev-Role": "business_development"}
SHERINE = {"X-Dev-User": "u-sherine", "X-Dev-Role": "business_development"}
MK_BD = {"X-Dev-User": "u-mariam-elkhayat", "X-Dev-Role": "business_development"}
MK_AM = {"X-Dev-User": "u-mariam-elkhayat", "X-Dev-Role": "account_manager"}
MD_AM = {"X-Dev-User": "u-mariam-dimitri", "X-Dev-Role": "account_manager"}


def pr(n: int) -> str:
    return f"PR-{Y}-{n:04d}"


def query(api, headers, **params):
    r = api.get("/api/proposal-requests", params={"pageSize": 100, **params}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def ids(api, headers, **params):
    return [i["id"] for i in query(api, headers, **params)["items"]]


def is_draft(rid):
    return REQ[rid]["status"] == "draft"


# ---------- Scopes & visibility ----------

def test_bd_scopes_mine_and_company_do_not_overlap(contract_api):
    """JS: BD scopes: Mine = my requests + my drafts; Company = other owners' non-draft requests; no overlap"""
    mine = ids(contract_api, AHMED, scope="mine")
    company = ids(contract_api, AHMED, scope="company")
    assert pr(19) in mine, "Ahmed's own draft"
    assert all(REQ[i]["bdOwner"] == "u-ahmed" for i in mine)
    assert all(REQ[i]["bdOwner"] != "u-ahmed" and not is_draft(i) for i in company)
    assert not set(mine) & set(company)
    non_draft = [r for r in REQ.values() if r["status"] != "draft"]
    assert len([i for i in mine if not is_draft(i)]) + len(company) == len(non_draft)


def test_am_scopes_my_brand_and_other_brand_only(contract_api):
    """JS: AM scopes: My brand = my brand's non-draft requests; Company = the other brand, only with 'See all brands'"""
    mine = ids(contract_api, MD_AM, scope="my_brand")
    assert mine and all(REQ[i]["brand"] == "teamup" and not is_draft(i) for i in mine)
    r = contract_api.get("/api/proposal-requests", params={"scope": "company"}, headers=MD_AM)
    assert r.status_code == 422, "no other-brand scope without See all brands"
    # Hana (contract world): a Team Up AM with "See all brands".
    other = ids(contract_api, {"X-Dev-User": "u-hana", "X-Dev-Role": "account_manager"}, scope="company")
    assert other and all(REQ[i]["brand"] == "grasshoppers" and not is_draft(i) for i in other)


def test_mariam_follows_her_active_role(contract_api):
    """JS: Mariam El Khayat follows her active role: her drafts only in BD mode, Grasshoppers queue in AM mode"""
    bd = ids(contract_api, MK_BD, scope="mine")
    am = ids(contract_api, MK_AM, scope="my_brand")
    assert pr(18) in bd
    assert pr(18) not in am, "a draft is not AM work"
    assert pr(16) in am, "her own BD request appears in her AM queue (routed to herself)"
    assert pr(14) in am, "another BD's Grasshoppers request"
    r = contract_api.get("/api/proposal-requests", params={"scope": "mine"}, headers=MK_AM)
    assert r.status_code == 422 and "scope" in r.json()["error"]["fields"], "no BD scope while acting as AM"


def test_head_sees_every_non_draft_plus_own_drafts_only(contract_api):
    """JS: Head sees every non-draft request plus her own drafts, never another person's draft"""
    all_ids = ids(contract_api, NOHA, scope="company")
    assert pr(90) in all_ids, "her own draft"
    for other_draft in (pr(18), pr(19), pr(91)):
        assert other_draft not in all_ids
    assert len(all_ids) == len([r for r in REQ.values() if r["status"] != "draft"]) + 1


def test_private_drafts_never_leak(contract_api):
    """JS: private drafts cannot leak through search, filters, tab counts or empty states"""
    by_id = query(contract_api, NOHA, q=pr(18))
    assert by_id["items"] == [] and by_id["counts"] == {"all": 0, "action": 0, "overdue": 0, "closed": 0}
    no_match = query(contract_api, NOHA, q="zzz-no-such-request")
    assert (by_id["counts"], by_id["total"]) == (no_match["counts"], no_match["total"]), "looks exactly like no match"
    client = query(contract_api, NOHA, q="Crescent Valley")["items"]
    assert client and all(i["status"] != "draft" or i["createdBy"] == "u-noha" for i in client)
    assert ids(contract_api, NOHA, status="draft") == [pr(90)], "only her own draft"
    for scope in ("mine", "company"):
        assert ids(contract_api, SHERINE, scope=scope, q="0018") == []
    assert contract_api.get(f"/api/proposal-requests/{pr(18)}", headers=NOHA).status_code == 404


def test_every_row_in_every_scope_is_viewable(contract_api):
    """JS: every row in every scope is viewable by its viewer"""
    for viewer in (NOHA, AHMED, SHERINE, MK_BD, MK_AM, MD_AM):
        for scope in tracker.scopes_for(viewer["X-Dev-Role"]):
            for rid in ids(contract_api, viewer, scope=scope):
                assert contract_api.get(f"/api/proposal-requests/{rid}", headers=viewer).status_code == 200


# ---------- Search & filters ----------

def test_search_by_id_and_client_name(contract_api):
    """JS: search by request ID (partial, case-insensitive) and by client name"""
    assert ids(contract_api, NOHA, q=pr(7).lower()) == [pr(7)]
    assert pr(7) in ids(contract_api, NOHA, q="0007")
    harbor = ids(contract_api, NOHA, q="harbor line")
    assert harbor and all(REQ[i]["clientId"] == "c-08" for i in harbor)


@pytest.mark.parametrize("params,check", [
    ({"brand": "grasshoppers"}, lambda r: r["brand"] == "grasshoppers"),
    ({"status": "submitted"}, lambda r: r["status"] == "submitted"),
    ({"status": "submitted,in_progress"}, lambda r: r["status"] in ("submitted", "in_progress")),
    ({"assignedAM": "u-mariam-dimitri"}, lambda r: r["assignedAM"] == "u-mariam-dimitri"),
    ({"bdOwner": "u-sherine"}, lambda r: r["bdOwner"] == "u-sherine"),
    ({"waitingOn": "am"}, lambda r: r["status"] in ("submitted", "in_progress", "revision_requested")),
    ({"open": "true"}, lambda r: r["status"] not in STATUS_CLOSED | {"draft"}),
])
def test_each_filter_narrows_correctly(contract_api, params, check):
    """JS: each filter narrows correctly: brand, status, assigned AM, BD owner, waiting on, open"""
    out = ids(contract_api, NOHA, **params)
    assert out and all(check(REQ[i]) for i in out)


def test_deadline_state_filter_uses_existing_rules(contract_api):
    """JS: deadline-state filter uses the existing deadline rules"""
    for state in tracker.DEADLINE_STATES:
        for item in query(contract_api, NOHA, deadline=state)["items"]:
            assert item["deadlineState"] == state
    overdue = ids(contract_api, NOHA, deadline="overdue")
    assert overdue == [i["id"] for i in query(contract_api, NOHA)["items"] if i["isOverdue"]]
    shared = query(contract_api, NOHA, q=pr(7))["items"][0]
    assert shared["status"] == "shared_with_client" and shared["deadlineState"] == "none", "AM has delivered"


def test_combined_filters_intersect_and_clearing_restores(contract_api):
    """JS: combined filters intersect; clearing filters restores the full scope"""
    everything = query(contract_api, NOHA)["total"]
    combo = query(contract_api, NOHA, brand="teamup", waitingOn="am", bdOwner="u-abdelrahman")["items"]
    assert all(i["brand"] == "teamup" and i["bdOwner"] == "u-abdelrahman" for i in combo)
    assert query(contract_api, NOHA)["total"] == everything, "no filters = full scope"


# ---------- Tabs ----------

def test_tabs_needs_action_overdue_closed(contract_api):
    """JS: tabs: Needs my action follows waitingOn + responsibility; Overdue; Closed"""
    mk_bd = ids(contract_api, MK_BD, tab="action")
    assert pr(18) in mk_bd and pr(11) in mk_bd
    assert pr(16) not in mk_bd, "Submitted waits on the AM, not on her as BD"
    mk_am = ids(contract_api, MK_AM, tab="action")
    assert pr(16) in mk_am and pr(14) in mk_am
    assert pr(11) not in mk_am, "Ready for BD waits on BD"
    head = query(contract_api, NOHA, tab="action")["items"]
    assert head and all(i["needsMyAction"] for i in head)
    assert all(i["isOverdue"] for i in query(contract_api, NOHA, tab="overdue")["items"])
    closed = query(contract_api, NOHA, tab="closed")["items"]
    assert closed and all(i["status"] in STATUS_CLOSED for i in closed)
    body = query(contract_api, NOHA)
    assert body["counts"]["all"] == body["total"]


# ---------- Sorting ----------

def test_default_sort_groups_and_undated_last(contract_api):
    """JS: the deadline sort (no longer the default): active deadlines first (overdue on top), then other open/drafts, closed last; undated never invented"""
    for viewer, scope in ((AHMED, "mine"), (NOHA, "company")):
        items = query(contract_api, viewer, scope=scope, sort="deadline")["items"]
        group = [2 if i["status"] in STATUS_CLOSED else 0 if i["deadlineActive"] else 1 for i in items]
        assert group == sorted(group)
        for g in (0, 1):
            dated = [i["requiredBy"] for i, gi in zip(items, group) if gi == g and i["requiredBy"]]
            assert dated == sorted(dated)
        if any(i["isOverdue"] for i in items):
            assert items[0]["isOverdue"]
    ahmed = query(contract_api, AHMED, scope="mine", sort="deadline")["items"]
    open_or_draft = [i for i in ahmed if i["status"] not in STATUS_CLOSED]
    assert open_or_draft[-1]["id"] == pr(91) and open_or_draft[-1]["requiredBy"] is None


def test_other_sorts(contract_api):
    """JS: other sorts: last updated (newest first) and event date (month-only uses the 1st)"""
    updated = [parse_ts(i["lastUpdated"]) for i in query(contract_api, NOHA, sort="updated")["items"]]
    assert updated == sorted(updated, reverse=True)
    items = [i for i in query(contract_api, NOHA, sort="event")["items"] if i["status"] not in STATUS_CLOSED]
    starts = [f'{i["eventDate"]}-01' if i["eventDatePrecision"] == "month" else i["eventDate"] for i in items if i["eventDate"]]
    assert starts == sorted(starts)


# ---------- Rows, navigation, Ready vs Shared ----------

def test_rows_say_whether_a_draft_opens_the_editor(contract_api):
    """JS: rows link to the detail page; own drafts open the editor when editable (server: canEditDraft)"""
    by_id = {i["id"]: i for i in query(contract_api, AHMED, scope="mine")["items"]}
    assert by_id[pr(13)]["canEditDraft"] is False
    assert by_id[pr(19)]["canEditDraft"] is True
    assert contract_api.get(f"/api/proposal-requests/{pr(18)}", headers=MK_AM).json()["canEditDraft"] is False


def test_ready_for_bd_and_shared_with_client_are_distinct(contract_api):
    """JS: Ready for BD and Shared with Client are shown distinctly"""
    ready = ids(contract_api, NOHA, status="ready_for_bd")
    shared = ids(contract_api, NOHA, status="shared_with_client")
    assert ready and shared and not set(ready) & set(shared)
    assert all(REQ[i]["status"] == "ready_for_bd" for i in ready)
    assert all(i["waitingOn"]["role"] == "business_development" for i in query(contract_api, NOHA, status="ready_for_bd")["items"])


def test_rows_waiting_on_month_only_dates_and_missing_dates(contract_api):
    """JS: rows show waiting-on, month-only event dates as "Mon YYYY", and missing dates as a dash"""
    items = {i["id"]: i for i in query(contract_api, NOHA)["items"]}
    month = items[pr(93)]
    assert month["eventDatePrecision"] == "month" and len(month["eventDate"]) == 7, "YYYY-MM; the UI formats it"
    submitted = items[pr(17)]
    assert submitted["waitingOn"] == {"userId": submitted["assignedAM"], "role": "account_manager"}
    assert items[pr(2)]["waitingOn"] is None, "closed"
    undated = {i["id"]: i for i in query(contract_api, AHMED, scope="mine")["items"]}[pr(91)]
    assert undated["eventDate"] is None and undated["requiredBy"] is None


# ---------- Empty states ----------

def test_empty_results_are_distinct_from_an_empty_scope(contract_api):
    """JS: empty results are reported separately from an empty scope"""
    none = query(contract_api, AHMED, scope="mine", brand="grasshoppers", status="revision_requested")
    assert none["total"] == 0 and none["scopeSize"] > 0


# ---------- URL parameters ----------

def test_accepts_the_existing_dashboard_link_parameters(contract_api):
    """JS: reads the existing dashboard links"""
    bd = query(contract_api, AHMED, bdOwner="u-ahmed", waitingOn="am")
    assert bd["scope"] == "mine" and all(i["bdOwner"] == "u-ahmed" for i in bd["items"])
    am = query(contract_api, MD_AM, brand="teamup", status="submitted,in_progress")
    assert am["scope"] == "my_brand" and all(i["status"] in ("submitted", "in_progress") for i in am["items"])
    head = query(contract_api, NOHA, deadline="overdue", brand="teamup")
    assert all(i["brand"] == "teamup" and i["isOverdue"] for i in head["items"])
    wl = query(contract_api, NOHA, assignedAM="u-mariam-dimitri", open="true")
    assert all(i["assignedAM"] == "u-mariam-dimitri" for i in wl["items"])


@pytest.mark.parametrize("params", [
    {"scope": "my_brand"}, {"tab": "nope"}, {"brand": "x"}, {"deadline": "soon"}, {"sort": "zzz"},
    {"status": "submitted,not_a_status"}, {"waitingOn": "ops"}, {"pageSize": 500}, {"page": 0},
])
def test_invalid_values_are_rejected_with_422(contract_api, params):
    """JS: invalid or not-allowed URL values fall back to defaults; state round-trips through the URL
    (server difference: the API rejects invalid values with 422 instead of silently ignoring them;
     the frontend keeps its URL fallback behaviour)"""
    r = contract_api.get("/api/proposal-requests", params=params, headers=NOHA)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"
