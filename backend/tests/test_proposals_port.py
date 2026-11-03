"""
1:1 port of frontend/tests/proposals.test.mjs (see tests/PORTING.md).
Runs against the API over the SEEDED demo database (the one-to-one port of the frontend seed).
"""

from sqlalchemy import select

from app.config_domain import BRAND_AM_ROUTING, PROPOSAL_STATUSES, ROLES
from app.models import Client, ProposalRequest, RequestStatusHistory

from .conftest import AHMED, MK_AM, MK_BD, NOHA, SHERINE, as_user, pr

ALL_VIEWERS = [NOHA, AHMED, SHERINE, MK_BD, MK_AM, as_user("u-mariam-dimitri", "account_manager"),
               as_user("u-abdelrahman", "business_development")]


def all_visible(api, headers):
    """Every request this viewer can see in any of their scopes."""
    role = headers["X-Dev-Role"]
    scopes = {"business_development": ["mine", "company"], "account_manager": ["my_brand", "company"],
              "commercial_head": ["company"]}[role]
    out = {}
    for scope in scopes:
        for item in api.get("/api/proposal-requests", params={"scope": scope, "pageSize": 100}, headers=headers).json()["items"]:
            out[item["id"]] = item
    return out


def detail(api, rid, headers=NOHA):
    r = api.get(f"/api/proposal-requests/{rid}", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def test_requested_by_is_gone_and_bd_owner_is_the_client_owner(api, session):
    """JS: requestedBy is gone; bdOwner is the client relationship owner"""
    for r in session.scalars(select(ProposalRequest)).all():
        assert r.bd_owner_id == session.get(Client, r.client_id).owner_id, r.id
    item = detail(api, pr(1))
    assert "requestedBy" not in item and item["bdOwner"] == "u-ahmed"


def test_assigned_am_always_follows_brand_routing(api, session):
    """JS: assignedAM always follows the brand routing rule"""
    for r in session.scalars(select(ProposalRequest)).all():
        assert r.assigned_am_id == BRAND_AM_ROUTING[r.brand], r.id


def test_created_by_and_last_updated(api, session):
    """JS: every request has createdBy and lastUpdated = latest history timestamp"""
    for rid in all_visible(api, NOHA):
        d = detail(api, rid)
        assert d["createdBy"]
        assert d["lastUpdated"] == d["history"][-1]["changedAt"], rid


def test_history_roles_and_versions(api, session):
    """JS: history entries carry a valid role and version; current version matches history"""
    for r in session.scalars(select(ProposalRequest)).all():
        entries = sorted(r.history, key=lambda e: e.seq)
        assert all(e.role in ROLES and e.version >= 1 for e in entries), r.id
        assert r.version == entries[-1].version, r.id


def test_head_created_request_keeps_both_people(api):
    """JS: a request created by the Commercial Head on behalf of a BD keeps both people"""
    d = detail(api, pr(17))
    assert d["createdBy"] == "u-noha" and d["bdOwner"] == "u-abdelrahman" and d["submittedBy"] == "u-noha"
    first = d["history"][0]
    assert (first["changedBy"], first["role"], first["onBehalfOf"]) == ("u-noha", "commercial_head", "u-abdelrahman")


def test_mariam_self_assigned_records_separate_roles(api):
    """JS: Mariam El Khayat's self-assigned requests record AM and BD steps in separate roles"""
    checked = 0
    for rid, item in all_visible(api, MK_BD).items():
        if item["bdOwner"] == item["assignedAM"] == "u-mariam-elkhayat":
            d = detail(api, rid, MK_BD)
            if len(d["history"]) <= 2:
                continue
            checked += 1
            for e in d["history"]:
                am_step = e["status"] in ("in_progress", "awaiting_bd_info", "ready_for_bd")
                assert e["role"] == ("account_manager" if am_step else "business_development"), (rid, e["status"])
    assert checked >= 1


def test_revised_request_keeps_both_versions_and_never_invents_v1_price(api):
    """JS: revised request keeps both versions; the unrecorded v1 price stays null (not invented)"""
    d = detail(api, pr(2))
    assert [(v["version"], v["amPrice"], v["isCurrent"]) for v in d["versions"]] == [(2, 372000, True), (1, None, False)]


def test_no_versions_before_work_and_pending_version_without_price(api):
    """JS: no versions before the AM has started; a started version shows as pending without a price"""
    assert detail(api, pr(16))["versions"] == []  # Submitted
    [v] = detail(api, pr(14))["versions"]  # In Progress
    assert v["isPending"] is True and v["amPrice"] is None


def test_only_ready_for_bd_entries_carry_a_price(api, session):
    """JS: only Ready for BD history entries carry a price (also a database CHECK)"""
    for e in session.scalars(select(RequestStatusHistory)).all():
        if e.status != "ready_for_bd":
            assert e.am_price is None
    priced = session.scalars(select(RequestStatusHistory).where(RequestStatusHistory.am_price.is_not(None))).all()
    assert priced and all(e.status == "ready_for_bd" for e in priced)


def test_open_statuses_wait_on_someone_and_closed_ones_do_not(api):
    """JS: every open/draft status has a nextStep; closed statuses have none
    (server: the rule part — waitingOn; the next-step wording is display text kept in the frontend)"""
    for s in PROPOSAL_STATUSES:
        assert (s["waitingOn"] == "none") == s["closed"], s["id"]


def test_responsible_person_follows_waiting_on(api):
    """JS: responsible person follows waitingOn: AM steps -> assigned AM, BD steps -> BD owner, draft -> creator"""
    wait = {s["id"]: s["waitingOn"] for s in PROPOSAL_STATUSES}
    for rid in all_visible(api, NOHA):
        d = detail(api, rid)
        who = wait[d["status"]]
        if who == "am":
            assert d["waitingOn"] == {"userId": d["assignedAM"], "role": "account_manager"}
        elif who == "bd" and d["status"] == "draft":
            assert d["waitingOn"] == {"userId": d["createdBy"], "role": None}
        elif who == "bd":
            assert d["waitingOn"] == {"userId": d["bdOwner"], "role": "business_development"}
        else:
            assert d["waitingOn"] is None


def test_drafts_visible_only_to_their_creator(api):
    """JS: drafts are visible only to their creator (not even the Commercial Head); others are visible to all"""
    for draft, creator in ((pr(18), MK_BD), (pr(19), AHMED)):
        for viewer in ALL_VIEWERS:
            code = api.get(f"/api/proposal-requests/{draft}", headers=viewer).status_code
            assert code == (200 if viewer["X-Dev-User"] == creator["X-Dev-User"] else 404), (draft, viewer)
    # A submitted request: every role that sees its brand (the other brand's AM does not, without "See all brands").
    brand = api.get(f"/api/proposal-requests/{pr(7)}", headers=NOHA).json()["brand"]
    for viewer in ALL_VIEWERS:
        other_brand_am = viewer["X-Dev-Role"] == "account_manager" and viewer["X-Dev-User"] != {"grasshoppers": "u-mariam-elkhayat", "teamup": "u-mariam-dimitri"}[brand]
        assert api.get(f"/api/proposal-requests/{pr(7)}", headers=viewer).status_code == (404 if other_brand_am else 200), viewer


def test_draft_created_for_a_bd_by_someone_else_is_not_in_their_list(contract_api):
    """JS: a draft someone else created for a BD is not on that BD's dashboard (contract world: Noha's draft for Ahmed)"""
    from .contract_world import load_scenarios
    noha_draft = f'PR-{load_scenarios()["today"][:4]}-0090'
    mine = contract_api.get("/api/proposal-requests", params={"scope": "mine", "pageSize": 100}, headers=AHMED).json()
    assert noha_draft not in [i["id"] for i in mine["items"]]
    assert contract_api.get(f"/api/proposal-requests/{noha_draft}", headers=AHMED).status_code == 404


def test_totals_reconcile(api):
    """JS: dashboard totals still reconcile after the field rename"""
    head = api.get("/api/proposal-requests", params={"open": "true", "pageSize": 100}, headers=NOHA).json()["total"]
    g = api.get("/api/proposal-requests", params={"open": "true", "scope": "my_brand", "pageSize": 100}, headers=MK_AM).json()["total"]
    t = api.get("/api/proposal-requests", params={"open": "true", "scope": "my_brand", "pageSize": 100},
                headers=as_user("u-mariam-dimitri", "account_manager")).json()["total"]
    assert (head, g, t) == (11, 5, 6)
    opps = api.get("/api/opportunities", params={"open": "true"}, headers=NOHA).json()["items"]
    by_bd = {}
    for o in opps:
        by_bd[o["owner"]] = by_bd.get(o["owner"], 0) + (o["estimatedValue"] or 0)
    assert sum(o["estimatedValue"] or 0 for o in opps) == sum(by_bd.values()) == 3_345_000


def test_history_is_ordered_with_a_single_origin(api):
    """JS: timeline is newest first and marks exactly one origin entry (the oldest)
    (server: history is returned oldest-first with seq 1..n; the UI reverses it for display)"""
    for rid in all_visible(api, NOHA):
        h = detail(api, rid)["history"]
        assert [e["seq"] for e in h] == list(range(1, len(h) + 1)), rid
        times = [e["changedAt"] for e in h]
        assert times == sorted(times), rid


def test_month_only_event_dates_are_kept_as_year_month(api):
    """JS: event dates: month-only shows "Mar 2027", full dates show "14 Mar 2027"
    (server: returns "YYYY-MM" for month-only and "YYYY-MM-DD" otherwise; the wording is UI formatting)"""
    items = all_visible(api, NOHA).values()
    month = [i for i in items if i["eventDatePrecision"] == "month"]
    assert month and all(len(i["eventDate"]) == 7 for i in month)
    assert all(len(i["eventDate"]) == 10 for i in items if i["eventDatePrecision"] == "day" and i["eventDate"])
