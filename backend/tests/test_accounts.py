"""
Accounts, roles and privileges through the API (seeded demo database): creating Marketing and
Operations people, Executives (see everything, change nothing but comments), privileges enforced
on the server, the safeguards, deactivation, routing, stale writes, one transaction per change
and append-only history.
"""

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DatabaseError

from app.models import ProposalRequest, User, UserHistory

from .conftest import AHMED, MD_AM, NOHA, as_user, pr
from .write_helpers import create as create_request, error, future, ok, row_version
from .write_helpers import cl, sample_pdf, upload

DOAA = as_user("u-doaa", "executive")
TONY = as_user("u-tony", "executive")


def new_account(api, who=NOHA, **over):
    body = {"name": "Salma Nabil", "email": "salma@eventflow.example", "jobTitle": "Marketing Lead",
            "roles": ["marketing"], **over}
    return api.post("/api/users", json=body, headers=who)


def account(api, user_id, who=NOHA):
    r = api.get(f"/api/users/{user_id}", headers=who)
    assert r.status_code == 200, r.text
    return r.json()


def patch(api, user_id, who=NOHA, version=None, **fields):
    v = version if version is not None else account(api, user_id, who)["rowVersion"]
    return api.patch(f"/api/users/{user_id}", json={**fields, "expectedRowVersion": v}, headers=who)


def deactivate(api, user_id, who=NOHA, move_to=None):
    body = {"expectedRowVersion": account(api, user_id)["rowVersion"]}
    if move_to:
        body["moveRequestsTo"] = move_to
    return api.post(f"/api/users/{user_id}/deactivate", json=body, headers=who)


def me(api, who):
    r = api.get("/api/me", headers=who)
    assert r.status_code == 200, r.text
    return r.json()


def teamup_request(**over):
    return {"clientId": cl(8), "brand": "teamup", "service": "team_building", "eventDatePrecision": "day",
            "eventDate": future(40), "requiredBy": future(10), "participants": 120,
            "requirementsSummary": "Half-day team building", **over}


# ---------------------------------------------------------------------------
# Marketing and Operations
# ---------------------------------------------------------------------------

def test_noha_creates_marketing_and_operations_people_with_an_empty_home(api):
    mkt = ok(new_account(api))["user"]
    ops = ok(new_account(api, name="Omar Fawzy", email="Omar.Fawzy@EventFlow.example", jobTitle="Operations Lead",
                         roles=["operations"]))["user"]
    assert (mkt["id"], mkt["email"], mkt["initials"]) == ("u-salma-nabil", "salma@eventflow.example", "SN")
    assert ops["email"] == "omar.fawzy@eventflow.example", "stored lower-case"
    assert mkt["privileges"] == {"manageAccounts": False, "seeAnalytics": False, "sendReminders": False,
                                 "seeAllBrands": False, "bringsInClients": False}
    listed = {u["id"] for u in api.get("/api/users", headers=AHMED).json()["items"]}
    assert {mkt["id"], ops["id"]} <= listed, "they appear in the identity switcher"
    for who, staffing in ((as_user(mkt["id"], "marketing"), False), (as_user(ops["id"], "operations"), True)):
        body = me(api, who)
        assert body["pages"] == {"home": True, "queue": False, "proposals": False, "events": True, "clients": False,
                                 "dashboard": False, "myNumbers": False, "opportunities": False, "tasks": False,
                                 "analytics": False, "team": False, "settings": False,
                                 "staffing": staffing, "facilitators": staffing, "screen": False}
        assert body["scopes"] == []
        r = api.get("/api/proposal-requests", headers=who)
        assert (r.status_code, error(r)["message"]) == (403, "Your role has no access to proposal requests.")
        assert api.get("/api/clients", headers=who).json()["items"] == [], "no proposal data"
        assert api.get("/api/opportunities", headers=who).json()["items"] == []
        assert api.get(f"/api/proposal-requests/{pr(17)}", headers=who).status_code == 404
        assert api.get("/api/analytics", headers=who).status_code == 403
    assert [h["event"] for h in account(api, mkt["id"])["history"]] == ["created"]


def test_account_fields_are_checked_on_the_server(api):
    r = new_account(api, name="", email="NOHA@eventflow.example", roles=["account_manager"])
    assert r.status_code == 422
    assert error(r)["fields"] == {"name": "Enter the full name.", "email": "Another account already uses this email.",
                                  "brand": "Choose the brand this Account Manager works for."}
    for extra in ({"id": "u-me"}, {"initials": "XX"}, {"active": False}, {"createdAt": "2026-01-01T00:00:00Z"}):
        assert new_account(api, **extra).status_code == 422, extra
    assert ok(new_account(api, name="Doaa", email="doaa2@eventflow.example"))["user"]["id"] == "u-doaa-2"


def test_only_people_with_manage_accounts_change_accounts(api):
    for who in (AHMED, MD_AM, DOAA):
        r = new_account(api, who=who)
        assert (r.status_code, error(r)["message"]) == (403, 'Only people with "Manage accounts" can do this.'), who
        assert api.get("/api/users/u-ahmed", headers=who).status_code == 403
        assert api.get("/api/routing", headers=who).status_code == 403


# ---------------------------------------------------------------------------
# Executives
# ---------------------------------------------------------------------------

def test_executives_see_everything_and_change_nothing(api, session):
    head = api.get("/api/proposal-requests", params={"pageSize": 100}, headers=NOHA).json()
    non_draft = sorted(i["id"] for i in head["items"] if i["status"] != "draft")
    for who in (DOAA, TONY):
        body = me(api, who)
        assert body["pages"]["proposals"] and body["pages"]["analytics"] and not body["pages"]["team"]
        assert body["scopes"] == ["company"]
        seen = api.get("/api/proposal-requests", params={"pageSize": 100}, headers=who).json()["items"]
        assert sorted(i["id"] for i in seen) == non_draft, "every request except private drafts"
        assert len(api.get("/api/clients", headers=who).json()["items"]) == 12
        assert len(api.get("/api/opportunities", headers=who).json()["items"]) == 18
        assert api.get("/api/analytics", headers=who).status_code == 200
        assert api.get(f"/api/proposal-requests/{pr(19)}", headers=who).status_code == 404, "someone's draft"
        assert all(not a["allowed"] for a in api.get(f"/api/proposal-requests/{pr(17)}", headers=who).json()["allowedActions"])

    before = session.scalar(select(func.count()).select_from(ProposalRequest))
    attempts = [
        api.post("/api/clients", json={"name": "X", "type": "school", "brands": ["teamup"]}, headers=TONY),
        api.patch(f"/api/clients/{cl(8)}", json={"city": "Giza", "expectedRowVersion": 1}, headers=DOAA),
        api.post(f"/api/clients/{cl(8)}/transfer", json={"toOwner": "u-sherine", "reason": "x", "expectedRowVersion": 1},
                 headers=DOAA),
        api.post("/api/opportunities", json={"clientId": cl(8), "brand": "teamup", "service": "family_day"}, headers=DOAA),
        api.post("/api/opportunities/OPP-0004/stage", json={"stage": "contacted", "expectedRowVersion": 1}, headers=DOAA),
        create_request(api, DOAA, **teamup_request()),
        api.post(f"/api/proposal-requests/{pr(17)}/actions",
                 json={"action": "cancel", "note": "x", "expectedRowVersion": row_version(api, pr(17), NOHA)}, headers=DOAA),
        api.post(f"/api/proposal-requests/{pr(7)}/actions",  # Mark won (shared with the client)
                 json={"action": "record_accepted", "expectedRowVersion": row_version(api, pr(7), NOHA)}, headers=DOAA),
        upload(api, pr(14), DOAA, data=sample_pdf()),
        new_account(api, who=DOAA),
        api.patch("/api/routing/teamup", json={"amUserId": "u-mariam-dimitri", "expectedRowVersion": 1}, headers=DOAA),
    ]
    assert [r.status_code for r in attempts] == [403] * len(attempts), [r.text for r in attempts]
    assert session.scalar(select(func.count()).select_from(ProposalRequest)) == before

    r = api.post(f"/api/proposal-requests/{pr(17)}/comments", json={"body": "Looks good."}, headers=DOAA)
    assert r.status_code == 201 and r.json()["comment"]["role"] == "executive", "Executives may comment"


# ---------------------------------------------------------------------------
# Privileges
# ---------------------------------------------------------------------------

def test_turning_off_see_analytics_removes_analytics_and_the_server_refuses_it(api):
    assert me(api, DOAA)["pages"]["analytics"] is True
    ok(patch(api, "u-doaa", privileges={"seeAnalytics": False}))
    body = me(api, DOAA)
    assert body["pages"]["analytics"] is False
    assert body["privileges"]["seeAllBrands"] is True, "switches not sent keep their value"
    r = api.get("/api/analytics", headers=DOAA)
    assert (r.status_code, error(r)["message"]) == (403, 'Only people with "See analytics" can open Analytics.')
    change = account(api, "u-doaa")["history"][0]
    assert (change["event"], change["changedBy"], change["details"]) == (
        "updated", "u-noha", {"privileges.seeAnalytics": {"from": True, "to": False}})


def test_see_all_brands_widens_what_an_account_manager_sees(api):
    grasshoppers = pr(14)
    assert api.get(f"/api/proposal-requests/{grasshoppers}", headers=MD_AM).status_code == 404
    assert me(api, MD_AM)["scopes"] == ["my_brand"]
    ok(patch(api, "u-mariam-dimitri", privileges={"seeAllBrands": True}))
    assert me(api, MD_AM)["scopes"] == ["my_brand", "company"]
    seen = api.get(f"/api/proposal-requests/{grasshoppers}", headers=MD_AM).json()
    assert not any(a["allowed"] for a in seen["allowedActions"]), "seeing never allows acting"
    own = api.get("/api/analytics", headers=MD_AM).json()  # an AM always has their own scorecard
    assert own["scope"]["kind"] == "am" and {r["assignedAM"] for r in own["requests"]} == {"u-mariam-dimitri"},         "See all brands never widens Analytics beyond their own requests"


def test_analytics_data_follows_the_brands_seen(api):
    ok(patch(api, "u-mariam-dimitri", privileges={"seeAnalytics": True}))
    body = api.get("/api/analytics", headers=MD_AM).json()
    assert body["brands"] == ["teamup"]
    assert body["requests"] and all(r["brand"] == "teamup" for r in body["requests"])
    assert all(o["brand"] == "teamup" for o in body["opportunities"])
    head = api.get("/api/analytics", headers=NOHA).json()
    assert head["brands"] is None and {r["brand"] for r in head["requests"]} == {"grasshoppers", "teamup"}
    assert all(r["status"] != "draft" or r["createdBy"] == "u-noha" for r in head["requests"])


# ---------------------------------------------------------------------------
# Safeguards and deactivation
# ---------------------------------------------------------------------------

def test_noha_cannot_deactivate_herself_or_remove_her_own_manage_accounts(api):
    r = deactivate(api, "u-noha")
    assert (r.status_code, error(r)["message"]) == (403, "You cannot deactivate your own account.")
    r = patch(api, "u-noha", privileges={"manageAccounts": False})
    assert r.status_code == 422
    assert error(r)["fields"] == {"privileges": 'You cannot remove your own "Manage accounts".'}
    assert account(api, "u-noha")["permissions"]["deactivate"] == {
        "allowed": False, "reason": "You cannot deactivate your own account."}


def test_with_a_second_manager_the_first_can_be_changed_but_someone_always_keeps_it(api):
    ok(patch(api, "u-doaa", privileges={"manageAccounts": True}))
    ok(patch(api, "u-noha", who=DOAA, privileges={"manageAccounts": False}))  # Doaa now the only manager
    assert new_account(api, who=NOHA).status_code == 403
    r = patch(api, "u-doaa", who=DOAA, privileges={"manageAccounts": False})
    assert error(r)["fields"] == {"privileges": 'You cannot remove your own "Manage accounts".'}


def test_the_routed_account_manager_cannot_be_deactivated_or_moved_until_routing_changes(api):
    r = deactivate(api, "u-mariam-dimitri")
    assert (r.status_code, error(r)["message"]) == (403, "Change routing for Team Up first.")
    r = patch(api, "u-mariam-dimitri", brand="grasshoppers")
    assert error(r)["fields"] == {"brand": "Change routing for Team Up first."}
    r = patch(api, "u-mariam-elkhayat", roles=["business_development"])
    assert error(r)["fields"] == {"roles": "Change routing for Grasshoppers first."}


def test_deactivating_a_bd_who_owns_clients_warns_and_keeps_history(api, session):
    owned = account(api, "u-ahmed")["owns"]
    assert owned["clients"] > 0 and owned["openRequests"] > 0, "shown as a warning before deactivating"
    ok(deactivate(api, "u-ahmed"))
    assert "u-ahmed" not in {u["id"] for u in api.get("/api/users", headers=NOHA).json()["items"]}
    everyone = api.get("/api/users", params={"includeInactive": True}, headers=NOHA).json()["items"]
    assert next(u for u in everyone if u["id"] == "u-ahmed")["active"] is False
    assert api.get("/api/me", headers=AHMED).status_code == 401, "cannot be used any more"
    assert api.get(f"/api/clients/{cl(8)}", headers=NOHA).json()["owner"] == "u-ahmed", "history and ownership stay"
    hist = account(api, "u-ahmed")["history"][0]
    assert (hist["event"], hist["details"]) == ("deactivated", {"owned": owned})
    ok(api.post("/api/users/u-ahmed/reactivate", json={"expectedRowVersion": account(api, "u-ahmed")["rowVersion"]},
                headers=NOHA))
    assert me(api, AHMED)["user"]["active"] is True


def test_stale_account_edits_are_409(api):
    v = account(api, "u-sherine")["rowVersion"]
    ok(patch(api, "u-sherine", version=v, jobTitle="Senior BD"))
    r = patch(api, "u-sherine", version=v, jobTitle="Lead BD")
    assert (r.status_code, error(r)["code"]) == (409, "stale")
    assert account(api, "u-sherine")["jobTitle"] == "Senior BD"


def test_an_edit_is_one_transaction(api, session, monkeypatch):
    from app.services import accounts as svc

    def boom(*args, **kwargs):
        raise RuntimeError("injected failure while writing user history")
    monkeypatch.setattr(svc, "_history", boom)
    with pytest.raises(RuntimeError, match="injected"):
        new_account(api)
    with pytest.raises(RuntimeError, match="injected"):
        patch(api, "u-sherine", jobTitle="Changed")
    session.expire_all()
    assert session.get(User, "u-salma-nabil") is None
    assert session.get(User, "u-sherine").job_title == "Business Development Executive"


def test_user_and_routing_history_are_append_only(api, engine):
    ok(new_account(api))
    ok(new_account(api, name="Hana Wahba", email="hana@eventflow.example", roles=["account_manager"], brand="teamup"))
    ok(api.patch("/api/routing/teamup", json={"amUserId": "u-hana-wahba", "expectedRowVersion": 1}, headers=NOHA))
    for table in ("user_history", "routing_history"):
        for sql in (f"UPDATE {table} SET role = 'marketing'", f"DELETE FROM {table}"):
            with engine.begin() as conn, pytest.raises(DatabaseError, match="append-only"):
                conn.execute(text(sql))


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def test_changing_routing_sends_the_next_new_request_to_the_new_am(api, session):
    old = ok(create_request(api, AHMED, submit=True, **teamup_request()))["request"]
    assert old["assignedAM"] == "u-mariam-dimitri"
    hana = ok(new_account(api, name="Hana Wahba", email="hana@eventflow.example", roles=["account_manager"],
                          brand="teamup"))["user"]
    routing = api.get("/api/routing", headers=NOHA).json()
    teamup = next(i for i in routing["items"] if i["brand"] == "teamup")
    assert teamup["choices"] == ["u-mariam-dimitri", hana["id"]]
    r = api.patch("/api/routing/teamup", json={"amUserId": "u-ahmed", "expectedRowVersion": teamup["rowVersion"]},
                  headers=NOHA)
    assert error(r)["fields"] == {"amId": "Choose an active Account Manager for Team Up."}
    body = ok(api.patch("/api/routing/teamup", json={"amUserId": hana["id"], "expectedRowVersion": teamup["rowVersion"]},
                        headers=NOHA))
    assert body["message"] == ("New Team Up requests now go to Hana Wahba. Existing requests keep their Account Manager.")
    assert (body["history"][0]["fromUser"], body["history"][0]["toUser"], body["history"][0]["changedBy"]) == (
        "u-mariam-dimitri", hana["id"], "u-noha")
    stale = api.patch("/api/routing/teamup", json={"amUserId": "u-mariam-dimitri", "expectedRowVersion": teamup["rowVersion"]},
                      headers=NOHA)
    assert stale.status_code == 409

    new = ok(create_request(api, AHMED, submit=True, **teamup_request(service="family_day")))["request"]
    assert new["assignedAM"] == hana["id"], "the next new request goes to the new AM"
    assert api.get(f"/api/proposal-requests/{old['id']}", headers=NOHA).json()["assignedAM"] == "u-mariam-dimitri"
    assert api.get("/api/config", headers=AHMED).json()["routing"]["teamup"] == hana["id"]
    # Mariam Dimitri is no longer routed, so she can now be deactivated.
    ok(deactivate(api, "u-mariam-dimitri", move_to=hana["id"]))  # her open requests move to Hana
    assert session.scalar(select(func.count()).select_from(UserHistory)) == 2
