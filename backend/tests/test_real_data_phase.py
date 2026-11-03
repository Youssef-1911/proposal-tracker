"""
Real-data phase through the API (seeded demo database): "Brings in clients" (Noha and Doaa own
clients and requests without a BD role), Postponed, event date ranges and "Date not set yet",
and moving an Account Manager's open requests when they are deactivated.
"""

from sqlalchemy import select

from app.models import ProposalRequest, RequestEvent

from .conftest import AHMED, NOHA, as_user, pr
from .write_helpers import act, create, detail, error, future, ok, sample_pdf, upload

DOAA = as_user("u-doaa", "executive")
TONY = as_user("u-tony", "executive")
SHARE = {"confirmShared": True, "channel": "email"}


def new_client(api, who, **over):
    body = {"name": "Nile Valley Academy", "type": "school", "brands": ["teamup"], "city": "Maadi", **over}
    return api.post("/api/clients", json=body, headers=who)


def full_request(client_id, **over):
    return {"clientId": client_id, "brand": "teamup", "service": "team_building", "eventDatePrecision": "day",
            "eventDate": future(40), "requiredBy": future(10), "participants": 50, "requirementsSummary": "Offsite", **over}


def to_shared(api, rid):
    """Moves a submitted request on to Shared with Client (AM work, then the BD owner shares it)."""
    am = as_user(detail(api, rid, NOHA)["assignedAM"], "account_manager")
    ok(act(api, rid, "start_work", am))

    ok(upload(api, rid, am, data=sample_pdf()))
    ok(act(api, rid, "mark_ready", am, amPrice=95000))


def test_noha_and_doaa_create_a_client_and_submit_a_request_without_a_role_switch(api):
    for who, owner_id in ((NOHA, "u-noha"), (DOAA, "u-doaa")):
        body = {"owner": owner_id} if who is NOHA else {}  # the Head chooses (herself); Doaa always owns hers
        client = ok(new_client(api, who, name=f"Client of {owner_id}", **body))["client"]
        assert client["owner"] == owner_id
        me = api.get("/api/me", headers=who).json()
        assert me["createRequests"]["allowed"] and me["createClients"]["allowed"]
        assert me["privileges"]["bringsInClients"] is True
        req = ok(create(api, who, submit=True, **full_request(client["id"])))["request"]
        assert (req["status"], req["bdOwner"], req["createdBy"]) == ("submitted", owner_id, owner_id)
        assert req["history"][0]["role"] == who["X-Dev-Role"], "recorded in their own role, no switch"
    # Tony (Executive without the switch) cannot.
    assert new_client(api, TONY).status_code == 403
    assert create(api, TONY, **full_request("CL-0008")).status_code == 403


def test_doaa_does_the_bd_steps_on_her_own_requests_and_nothing_else(api):
    client = ok(new_client(api, DOAA, name="Delta Ventures"))["client"]
    rid = ok(create(api, DOAA, submit=True, **full_request(client["id"])))["request"]["id"]
    to_shared(api, rid)
    ok(act(api, rid, "share_with_client", DOAA, **SHARE))
    ok(act(api, rid, "record_accepted", DOAA, eventDate=future(30)))
    assert detail(api, rid, DOAA)["status"] == "accepted"
    # Someone else's request: read-only for her.
    r = act(api, pr(7), "record_accepted", DOAA, eventDate=future(30))
    assert r.status_code == 403
    assert api.patch(f"/api/clients/{'CL-0008'}", json={"city": "Giza", "expectedRowVersion": 1}, headers=DOAA).status_code == 403


def test_mariam_el_khayat_still_switches_role_for_bd_steps(api):
    me = api.get("/api/me", headers=as_user("u-mariam-elkhayat", "account_manager")).json()
    assert me["createRequests"]["allowed"] is False, "she has the BD role, so she switches to it"


def test_postponed_needs_a_follow_up_date_and_can_go_back_won_or_lost(api):
    rid = ok(create(api, AHMED, submit=True, **full_request("CL-0008")))["request"]["id"]
    to_shared(api, rid)
    ok(act(api, rid, "share_with_client", AHMED, **SHARE))
    r = act(api, rid, "postpone", AHMED, followUpOn=future(-1))
    assert error(r)["fields"] == {"followUpOn": "The follow-up date cannot be in the past."}
    body = ok(act(api, rid, "postpone", AHMED, followUpOn=future(7), note="After their budget review"))["request"]
    assert (body["status"], body["subLabel"], body["followUpOn"]) == ("postponed", "Postponed", future(7))
    assert body["history"][-1]["followUpOn"] == future(7)
    assert body["needsMyAction"] is False, "waiting on purpose until the follow-up date"
    back = ok(act(api, rid, "resume", AHMED))["request"]
    assert (back["status"], back["followUpOn"]) == ("shared_with_client", None)
    ok(act(api, rid, "postpone", AHMED, followUpOn=future(3)))
    assert ok(act(api, rid, "record_accepted", AHMED, eventDate=future(30)))["request"]["status"] == "accepted"


def test_event_date_ranges_and_date_not_set_yet(api):
    ranged = ok(create(api, AHMED, submit=True, **full_request("CL-0008", eventEndDate=future(42))))["request"]
    assert (ranged["eventDate"], ranged["eventEndDate"]) == (future(40), future(42))
    unset = ok(create(api, AHMED, submit=True, **full_request("CL-0008", eventDatePrecision="unset", eventDate=None,
                                                             service="family_day")))["request"]
    assert (unset["eventDatePrecision"], unset["eventDate"]) == ("unset", None)
    r = create(api, AHMED, submit=True, **full_request("CL-0008", eventDate=None, service="corporate_event"))
    assert error(r)["fields"]["eventDate"] == 'Enter the event date, or choose "Not set yet".'
    r = create(api, AHMED, **full_request("CL-0008", eventEndDate=future(39), service="event_activation"))
    assert error(r)["fields"] == {"eventEndDate": "The end date cannot be before the start date."}


def test_new_grasshoppers_services(api):
    for service in ("activation", "family_day"):
        r = create(api, as_user("u-mariam-elkhayat", "business_development"), clientId="CL-0001", brand="grasshoppers",
                   service=service)
        assert r.status_code == 201, r.text


def test_deactivating_an_account_manager_moves_their_open_requests(api, session):
    hana = ok(api.post("/api/users", json={"name": "Hana Wahba", "email": "hana@eventflow.example",
                                           "roles": ["account_manager"], "brand": "teamup"}, headers=NOHA))["user"]
    routing = next(i for i in api.get("/api/routing", headers=NOHA).json()["items"] if i["brand"] == "teamup")
    ok(api.patch("/api/routing/teamup", json={"amUserId": hana["id"], "expectedRowVersion": routing["rowVersion"]}, headers=NOHA))

    page = api.get("/api/users/u-mariam-dimitri", headers=NOHA).json()
    plan = page["deactivation"]
    assert plan["count"] > 0 and plan["choices"] == [hana["id"]]
    version = page["rowVersion"]
    r = api.post("/api/users/u-mariam-dimitri/deactivate", json={"expectedRowVersion": version}, headers=NOHA)
    assert error(r)["fields"] == {"moveTo": f"Choose who takes over Mariam Dimitri's {plan['count']} open requests."}
    body = ok(api.post("/api/users/u-mariam-dimitri/deactivate",
                       json={"expectedRowVersion": version, "moveRequestsTo": hana["id"]}, headers=NOHA))
    assert body["message"] == f"Mariam Dimitri is deactivated. Their history stays. {plan['count']} open requests moved to Hana Wahba."
    # Drafts move too (they are private, so they are checked in the database, not through Noha's view).
    session.expire_all()
    for rid in plan["requestIds"]:
        assert session.get(ProposalRequest, rid).assigned_am_id == hana["id"], rid
        events = session.scalars(select(RequestEvent).where(RequestEvent.request_id == rid)).all()
        assert [(e.event, e.note) for e in events] == [
            ("assigned_am_changed", "Assigned AM changed from Mariam Dimitri to Hana Wahba by Noha El Kenawy — deactivation")]
    assert len(session.scalars(select(RequestEvent).where(RequestEvent.event == "assigned_am_changed")).all()) == plan["count"]
    closed = [r for r in api.get("/api/proposal-requests", params={"pageSize": 100, "tab": "closed"}, headers=NOHA).json()["items"]
              if r["brand"] == "teamup"]
    assert all(r["assignedAM"] == "u-mariam-dimitri" for r in closed), "closed requests keep their AM"



# ---------- event names; adding a client from the request / opportunity form ----------

def client_names(api, who=NOHA) -> set[str]:
    return {c["name"] for c in api.get("/api/clients", headers=who).json()["items"]}


def test_event_name_is_saved_shown_in_lists_and_limited_to_80(api):
    req = ok(create(api, AHMED, submit=True, **full_request("CL-0008", eventName="  Summer team day ")))["request"]
    assert req["eventName"] == "Summer team day"
    row = next(r for r in api.get("/api/proposal-requests", headers=AHMED).json()["items"] if r["id"] == req["id"])
    assert row["eventName"] == "Summer team day"
    r = create(api, AHMED, **full_request("CL-0008", eventName="x" * 81))
    assert error(r)["fields"] == {"eventName": "Use at most 80 characters."}
    opp = ok(api.post("/api/opportunities", json={"clientId": "CL-0008", "brand": "teamup", "service": "family_day",
                                                  "eventName": "Staff day"}, headers=AHMED))["opportunity"]
    assert opp["eventName"] == "Staff day"


def test_a_new_client_typed_in_the_request_form_is_created_with_the_request(api):
    body = full_request(None, eventName="Kick-off", newClient={"name": "Saqqara Labs", "type": "corporate",
                                                                 "contactName": "Laila", "contactPhone": "0100 123 4567"})
    req = ok(create(api, AHMED, submit=True, **body))["request"]
    client = ok(api.get(f"/api/clients/{req['clientId']}", headers=AHMED))
    client = client.get("client", client)
    assert (client["name"], client["owner"], client["brands"]) == ("Saqqara Labs", "u-ahmed", ["teamup"])
    assert [c["name"] for c in client["contacts"]] == ["Laila"]
    assert req["bdOwner"] == "u-ahmed"
    # The Head chooses the owner; the request follows the client's owner.
    req = ok(create(api, NOHA, submit=True, **full_request(None, newClient={
        "name": "Giza Robotics", "type": "corporate", "owner": "u-sherine"})))["request"]
    assert req["bdOwner"] == "u-sherine"


def test_one_transaction_a_failed_request_creates_no_client(api):
    before = client_names(api)
    r = create(api, AHMED, **full_request(None, service="not_a_service", newClient={"name": "Ghost Co", "type": "other"}))
    assert r.status_code == 422 and "service" in error(r)["fields"]
    r = create(api, AHMED, **full_request(None, newClient={"name": "  ", "type": "other"}))
    assert "newClient.name" in error(r)["fields"]
    r = api.post("/api/opportunities", json={"brand": "teamup", "service": "nope",
                                             "newClient": {"name": "Ghost Two", "type": "other"}}, headers=AHMED)
    assert r.status_code == 422
    assert client_names(api) == before


def test_only_people_who_bring_in_clients_can_add_one_from_the_form(api):
    before = client_names(api)
    r = create(api, TONY, **full_request(None, newClient={"name": "Tony Co", "type": "other"}))
    assert r.status_code == 403
    assert client_names(api) == before
    opp = ok(api.post("/api/opportunities", json={"brand": "grasshoppers", "service": "activation",
                                                  "newClient": {"name": "Cairo Kids Club", "type": "other"}},
                      headers=AHMED))["opportunity"]
    assert opp["owner"] == "u-ahmed"
    assert "Cairo Kids Club" in client_names(api)
