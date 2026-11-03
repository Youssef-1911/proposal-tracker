"""
Through the API (seeded demo database): "Set waiting on" end to end (Marketing sees it and clicks
Done; any status change clears it), the dropdown lists in Settings (never deleted), reasons on
actions, and Analytics scoped by the server (own numbers for BD / AM, anyone's for management).
"""

from app.models import ListOption, RequestEvent

from .conftest import AHMED, MD_AM, NOHA, as_user, pr
from .write_helpers import act, create, detail, error, future, ok, row_version

DOAA = as_user("u-doaa", "executive")


def full_request(**over):
    return {"clientId": "CL-0008", "brand": "teamup", "service": "team_building", "eventDatePrecision": "day",
            "eventDate": future(40), "requiredBy": future(10), "participants": 50, "requirementsSummary": "Offsite", **over}


def marketing(api):
    body = {"name": "Nada Salem", "email": "nada@eventflow.example", "jobTitle": "Designer", "roles": ["marketing"]}
    user = ok(api.post("/api/users", json=body, headers=NOHA))["user"]
    return as_user(user["id"], "marketing")


def set_waiting(api, rid, who, **body):
    return api.post(f"/api/proposal-requests/{rid}/waiting-on", headers=who,
                    json={**body, "expectedRowVersion": row_version(api, rid, who)})


def test_marketing_sees_what_waits_on_it_and_clicks_done(api, session):
    nada = marketing(api)
    rid = ok(create(api, AHMED, submit=True, **full_request()))["request"]["id"]
    ok(act(api, rid, "start_work", MD_AM))
    body = ok(set_waiting(api, rid, MD_AM, team="marketing", userId=nada["X-Dev-User"], reason="design",
                          expectedBy=future(3)))
    assert body["message"].startswith("Waiting on: Marketing — Nada Salem · Design / creative")
    assert detail(api, rid, AHMED)["waiting"]["team"] == "marketing"

    mine = api.get("/api/proposal-requests/waiting-on-me", headers=nada).json()["items"]
    assert [i["id"] for i in mine] == [rid]
    assert (mine[0]["backTo"], mine[0]["reasonLabel"], mine[0]["canOpen"]) == ("Mariam Dimitri", "Design / creative", False)
    assert api.get(f"/api/proposal-requests/{rid}", headers=nada).status_code == 404, "Marketing still sees no proposal data"
    done = api.post(f"/api/proposal-requests/{rid}/waiting-on/clear", headers=nada,
                    json={"expectedRowVersion": mine[0]["rowVersion"]})
    assert done.status_code == 200, done.text
    assert done.json()["request"] is None and done.json()["message"] == "Back to Mariam Dimitri."
    assert detail(api, rid, AHMED)["waiting"] is None
    events = [e.event for e in session.query(RequestEvent).filter_by(request_id=rid)]
    assert events == ["waiting_on_set", "waiting_on_cleared"]


def test_a_status_change_returns_it_to_automatic_and_reasons_are_kept(api):
    rid = ok(create(api, AHMED, submit=True, **full_request()))["request"]["id"]
    ok(act(api, rid, "start_work", MD_AM))
    ok(set_waiting(api, rid, MD_AM, team="operations", reason="supplier_prices"))
    r = act(api, rid, "request_bd_info", MD_AM, reasons=["budget", "nope"])
    assert error(r)["fields"] == {"reasons": "Choose from the list."}
    r = act(api, rid, "request_bd_info", MD_AM, reasons=["other"])
    assert error(r)["fields"] == {"note": 'Describe "Other" in the note.'}
    body = ok(act(api, rid, "request_bd_info", MD_AM, reasons=["budget", "venue"]))["request"]
    assert body["waiting"] is None, "the status moved on"
    assert body["history"][-1]["reasons"] == ["budget", "venue"]


def test_only_the_bd_owner_assigned_am_and_head_set_it(api):
    rid = ok(create(api, AHMED, submit=True, **full_request()))["request"]["id"]
    assert set_waiting(api, rid, DOAA, team="client", reason="awaiting_reply").status_code == 403
    r = set_waiting(api, rid, AHMED, team="client", reason="no_such_reason")
    assert error(r)["fields"] == {"reason": "Choose a reason from the list."}
    assert ok(set_waiting(api, rid, NOHA, team="client", reason="awaiting_reply"))["request"]["waiting"]["team"] == "client"
    listed = api.get("/api/proposal-requests", params={"waiting": "client", "pageSize": 100}, headers=NOHA).json()
    assert rid in [i["id"] for i in listed["items"]]


def test_lists_in_settings_are_added_renamed_hidden_never_deleted(api, session):
    r = api.post("/api/settings/lists/whatsMissing", json={"action": "add", "label": "Dress code"}, headers=AHMED)
    assert r.status_code == 403
    body = ok(api.post("/api/settings/lists/whatsMissing", json={"action": "add", "label": "Dress code"}, headers=NOHA))
    assert {"code": "dress_code", "label": "Dress code", "hidden": False} in body["lists"]["options"]["whatsMissing"]
    ok(api.post("/api/settings/lists/whatsMissing", json={"action": "hide", "code": "dress_code"}, headers=NOHA))
    cfg = api.get("/api/config", headers=AHMED).json()["lists"]["options"]["whatsMissing"]
    assert next(o for o in cfg if o["code"] == "dress_code")["hidden"] is True
    r = api.post("/api/settings/lists/whatsMissing", json={"action": "delete", "code": "dress_code"}, headers=NOHA)
    assert r.status_code == 422, "there is no delete"
    assert session.query(ListOption).count() == 1


def test_analytics_is_scoped_by_the_server(api):
    bd = api.get("/api/analytics", headers=AHMED).json()
    assert bd["scope"] == {"kind": "bd", "userId": "u-ahmed"} and bd["people"] == []
    assert {r["bdOwner"] for r in bd["requests"]} <= {"u-ahmed"}
    asked = api.get("/api/analytics", params={"person": "u-sherine", "as": "bd"}, headers=AHMED).json()
    assert asked["scope"]["userId"] == "u-ahmed", "a BD never gets someone else's numbers"
    am = api.get("/api/analytics", headers=MD_AM).json()
    assert am["scope"]["kind"] == "am" and {r["assignedAM"] for r in am["requests"]} <= {"u-mariam-dimitri"}
    company = api.get("/api/analytics", headers=NOHA).json()
    assert company["scope"]["kind"] == "company" and len(company["requests"]) > len(bd["requests"])
    assert {"id": "u-sherine", "name": "Sherine El Tabakh", "as": "bd", "active": True} in company["people"]
    one = api.get("/api/analytics", params={"person": "u-mariam-dimitri", "as": "am"}, headers=DOAA).json()
    assert one["scope"] == {"kind": "am", "userId": "u-mariam-dimitri"}
    r = api.get("/api/analytics", params={"person": "u-mariam-dimitri", "as": "bd"}, headers=NOHA)
    assert r.status_code == 422
    ops = marketing(api)
    assert api.get("/api/analytics", headers=ops).status_code == 403
