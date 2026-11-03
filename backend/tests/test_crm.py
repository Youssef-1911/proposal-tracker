"""
CRM 1 through the API (seeded demo database): create and edit clients, contacts and
opportunities; owner transfer (with and without moving open requests); manual stage moves;
stale writes; duplicates; archive; one transaction per write; append-only history.
"""

import pytest
from alembic import command
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import DatabaseError

from app.migrations_check import alembic_config
from app.models import Client, Opportunity, ProposalRequest, RequestEvent

from .conftest import AHMED, MD_AM, MK_AM, NOHA, SHERINE, as_user, pr, sqlite_url
from .write_helpers import create as create_request, error, future, ok

ABDELRAHMAN = as_user("u-abdelrahman", "business_development")


def new_client(api, who, **over):
    body = {"name": "Nile Valley Academy", "type": "school", "brands": ["grasshoppers"], "city": "Maadi", **over}
    return api.post("/api/clients", json=body, headers=who)


def get_client(api, cid, who=NOHA):
    r = api.get(f"/api/clients/{cid}", headers=who)
    assert r.status_code == 200, r.text
    return r.json()


def history(api, cid, who=NOHA):
    return api.get(f"/api/clients/{cid}/history", headers=who).json()["items"]


def get_opp(api, oid, who=NOHA):
    return api.get(f"/api/opportunities/{oid}", headers=who).json()


def new_opp(api, who, client_id, **over):
    body = {"clientId": client_id, "brand": "grasshoppers", "service": "school_trip", "estimatedValue": 150000,
            "participants": 80, "eventDate": future(45), "nextAction": "Send itinerary", "nextActionDate": future(2), **over}
    return api.post("/api/opportunities", json=body, headers=who)


# ---------------------------------------------------------------------------
# Acceptance path: BD creates client -> owner -> opportunity -> proposal request
# ---------------------------------------------------------------------------

def test_bd_creates_client_becomes_owner_then_opportunity_then_request(api):
    created = ok(new_client(api, AHMED, owner="u-sherine",  # an owner sent by a BD is ignored
                            contact={"name": "Hana Fouad", "title": "Principal", "phone": "0100 777 8899"}))
    c = created["client"]
    assert (c["id"], c["owner"], c["contact"]["name"]) == ("CL-0013", "u-ahmed", "Hana Fouad")
    assert c["permissions"]["edit"]["allowed"] is True and c["permissions"]["transfer"]["allowed"] is False
    assert [h["event"] for h in history(api, c["id"])] == ["created"]

    opp = ok(new_opp(api, AHMED, c["id"]))["opportunity"]
    assert (opp["id"], opp["owner"], opp["stage"], opp["clientId"]) == ("OPP-0019", "u-ahmed", "new_lead", c["id"])
    assert [h["event"] for h in history(api, c["id"])] == ["opportunity_added", "created"]

    # The request form sees both immediately, and the request can be submitted for them.
    assert c["id"] in [x["id"] for x in api.get("/api/clients", params={"creatable": True}, headers=AHMED).json()["items"]]
    req = ok(create_request(api, AHMED, submit=True, clientId=c["id"], brand="grasshoppers", service="school_trip",
                            opportunityId=opp["id"], eventDate=future(45), requiredBy=future(10), participants=80,
                            requirementsSummary="Grade 3 trip"))["request"]
    assert (req["status"], req["bdOwner"], req["opportunityId"]) == ("submitted", "u-ahmed", opp["id"])
    assert get_opp(api, opp["id"])["stage"] == "proposal_requested", "the existing request sync still applies"


def test_another_bd_can_view_but_not_edit(api):
    cid = ok(new_client(api, AHMED))["client"]["id"]
    seen = get_client(api, cid, SHERINE)
    assert seen["permissions"]["edit"] == {
        "allowed": False, "reason": "Only the relationship owner, Ahmed Seif, or the Commercial Head can do this."}
    version = seen["rowVersion"]
    for method, path, body in (
        ("patch", f"/api/clients/{cid}", {"expectedRowVersion": version, "city": "Giza"}),
        ("post", f"/api/clients/{cid}/contacts", {"expectedRowVersion": version, "name": "X"}),
        ("post", f"/api/clients/{cid}/archive", {"expectedRowVersion": version}),
    ):
        r = getattr(api, method)(path, json=body, headers=SHERINE)
        assert (r.status_code, error(r)["message"]) == (
            403, "Only the relationship owner, Ahmed Seif, or the Commercial Head can do this."), path
    r = new_opp(api, SHERINE, cid)
    assert r.status_code == 403
    assert create_request(api, SHERINE, clientId=cid, brand="grasshoppers", service="school_trip").status_code == 403


def test_head_creates_clients_for_a_chosen_bd_and_ams_cannot(api):
    assert error(new_client(api, NOHA))["fields"] == {"owner": "Choose the relationship owner."}
    c = ok(new_client(api, NOHA, owner="u-sherine"))["client"]
    assert c["owner"] == "u-sherine"
    r = new_client(api, MK_AM)
    assert r.status_code == 403 and "Switch your active role to Business Development" in error(r)["message"]
    assert new_client(api, MD_AM).status_code == 403
    assert api.get("/api/me", headers=MD_AM).json()["createClients"]["allowed"] is False


def test_server_set_fields_are_refused(api):
    for field, value in (("id", "CL-9999"), ("createdAt", "2020-01-01"), ("archivedAt", None), ("rowVersion", 1)):
        r = new_client(api, AHMED, **{field: value})
        assert r.status_code == 422 and field in error(r)["fields"], field


# ---------------------------------------------------------------------------
# Owner transfer
# ---------------------------------------------------------------------------

def _transfer(api, cid, who=NOHA, **body):
    version = get_client(api, cid)["rowVersion"]
    return api.post(f"/api/clients/{cid}/transfer", json={"expectedRowVersion": version, **body}, headers=who)


def test_transfer_moves_client_open_opportunities_and_open_requests(api, session):
    cid = "CL-0007"  # Papyrus Fintech, Abdelrahman: PR-0003 rejected, PR-0008 cancelled, PR-0017 submitted
    draft = ok(create_request(api, ABDELRAHMAN, clientId=cid, brand="teamup", service="family_day"))["request"]["id"]
    out = ok(_transfer(api, cid, toOwner="u-sherine", reason="Abdelrahman moves to agency accounts"))
    assert out["client"]["owner"] == "u-sherine"
    assert out["moved"]["requestIds"] == [pr(17)] and out["moved"]["opportunityIds"] == ["OPP-0006"]
    session.expire_all()
    owners = {r.id: r.bd_owner_id for r in session.scalars(select(ProposalRequest).where(ProposalRequest.client_id == cid))}
    assert owners[pr(17)] == "u-sherine", "open request moved"
    assert owners[pr(3)] == owners[pr(8)] == "u-abdelrahman", "closed requests keep their recorded owner"
    assert owners[draft] == "u-abdelrahman", "drafts stay with their creator"
    assert session.get(Opportunity, "OPP-0006").owner_id == "u-sherine"
    assert session.get(Opportunity, "OPP-0018").owner_id == "u-abdelrahman", "the Lost opportunity keeps its owner"

    event = api.get(f"/api/proposal-requests/{pr(17)}", headers=NOHA).json()["events"]
    assert [(e["event"], e["fromUser"], e["toUser"], e["note"]) for e in event] == [(
        "bd_owner_transferred", "u-abdelrahman", "u-sherine",
        "BD owner transferred from Abdelrahman Shams to Sherine El Tabakh by Noha El Kenawy — Abdelrahman moves to agency accounts")]
    h = history(api, cid)[0]
    assert (h["event"], h["reason"], h["details"]["from"], h["details"]["to"]) == (
        "owner_transferred", "Abdelrahman moves to agency accounts", "u-abdelrahman", "u-sherine")

    # The new owner can now create requests for the client; the old owner cannot.
    new = create_request(api, SHERINE, clientId=cid, brand="teamup", service="family_day")
    assert new.status_code == 201 and new.json()["request"]["bdOwner"] == "u-sherine"
    old = create_request(api, ABDELRAHMAN, clientId=cid, brand="teamup", service="family_day")
    assert (old.status_code, error(old)["message"]) == (403, "You can only create requests for clients you own.")
    # The moved request's BD steps now belong to the new owner.
    actions = api.get(f"/api/proposal-requests/{pr(17)}", headers=SHERINE).json()["allowedActions"]
    assert [a["action"] for a in actions if a["allowed"]] == ["cancel"]


def test_transfer_preview_counts_what_would_move_and_only_the_head_sees_it(api):
    create_request(api, ABDELRAHMAN, clientId="CL-0007", brand="teamup", service="family_day")  # a draft: not counted
    assert get_client(api, "CL-0007")["transferPreview"] == {"openOpportunityCount": 1, "openRequestCount": 1}
    assert "transferPreview" not in get_client(api, "CL-0007", who=ABDELRAHMAN)


def test_transfer_without_moving_requests(api, session):
    out = ok(_transfer(api, "CL-0007", toOwner="u-sherine", reason="Rebalance", moveRequests=False))
    assert out["moved"]["requestIds"] == [] and out["moved"]["opportunityIds"] == ["OPP-0006"]
    session.expire_all()
    assert session.get(ProposalRequest, pr(17)).bd_owner_id == "u-abdelrahman"
    assert session.get(Opportunity, "OPP-0006").owner_id == "u-sherine", "open opportunities always move"
    assert session.scalar(select(func.count()).select_from(RequestEvent)) == 0


def test_transfer_rules(api):
    r = _transfer(api, "CL-0007", who=ABDELRAHMAN, toOwner="u-sherine", reason="x")
    assert (r.status_code, error(r)["message"]) == (403, "Only the Commercial Head can transfer a client to another owner.")
    r = _transfer(api, "CL-0007", toOwner="u-abdelrahman")
    assert r.status_code == 422 and set(error(r)["fields"]) == {"toOwner", "reason"}


def test_transfer_is_one_transaction(api, session, monkeypatch):
    from app.services import clients as svc

    def boom(*args, **kwargs):
        raise RuntimeError("injected failure while writing client history")
    monkeypatch.setattr(svc, "_history", boom)
    with pytest.raises(RuntimeError, match="injected"):
        _transfer(api, "CL-0007", toOwner="u-sherine", reason="Rebalance")
    session.expire_all()
    assert session.get(Client, "CL-0007").owner_id == "u-abdelrahman"
    assert session.get(ProposalRequest, pr(17)).bd_owner_id == "u-abdelrahman"
    assert session.get(Opportunity, "OPP-0006").owner_id == "u-abdelrahman"
    assert session.scalar(select(func.count()).select_from(RequestEvent)) == 0


# ---------------------------------------------------------------------------
# Opportunities: edit, manual stage moves
# ---------------------------------------------------------------------------

def _move(api, oid, who=AHMED, **body):
    return api.post(f"/api/opportunities/{oid}/stage", json={"expectedRowVersion": get_opp(api, oid)["rowVersion"], **body},
                    headers=who)


def test_manual_lost_needs_a_reason_and_manual_won_is_never_offered(api):
    oid = "OPP-0004"  # Ahmed, Requirements Gathered
    assert "won" not in get_opp(api, oid, AHMED)["permissions"]["moveTargets"]
    r = _move(api, oid, stage="lost")
    assert (r.status_code, error(r)["fields"]) == (422, {"lostReason": "Choose why the opportunity was lost."})
    r = _move(api, oid, stage="won")
    assert (r.status_code, error(r)["code"]) == (409, "invalid_transition")
    out = ok(_move(api, oid, stage="lost", lostReason="budget_cancelled"))["opportunity"]
    last = out["history"][-1]
    assert (out["stage"], out["lostReason"], last["reasonCode"], last["lostReason"], last["changedBy"]) == (
        "lost", "budget_cancelled", "manual_change", "budget_cancelled", "u-ahmed")
    # Reopening a Lost opportunity needs a short note.
    r = _move(api, oid, stage="negotiation")
    assert error(r)["fields"] == {"note": "Add a short note on why the opportunity is reopened."}
    out = ok(_move(api, oid, stage="negotiation", note="Budget approved again"))["opportunity"]
    assert (out["stage"], out["lostReason"], out["history"][-1]["note"], out["history"][-1]["reasonCode"]) == (
        "negotiation", None, "Budget approved again", "manual_change")


def test_won_is_final(api):
    oid = "OPP-0016"  # Won
    assert get_opp(api, oid, NOHA)["permissions"]["moveTargets"] == []
    r = _move(api, oid, who=NOHA, stage="negotiation", note="x")
    assert (r.status_code, error(r)["message"]) == (409, "Confirmed is final: it is set only when a proposal is confirmed.")


def test_edit_opportunity_records_what_changed_and_blocks_past_dates(api):
    oid = "OPP-0004"
    v = get_opp(api, oid)["rowVersion"]
    r = api.patch(f"/api/opportunities/{oid}", json={"expectedRowVersion": v, "eventDate": future(-2)}, headers=AHMED)
    assert r.status_code == 422 and error(r)["fields"] == {"eventDate": "The event date cannot be in the past."}
    out = ok(api.patch(f"/api/opportunities/{oid}", json={"expectedRowVersion": v, "estimatedValue": 275000}, headers=AHMED))
    last = out["opportunity"]["history"][-1]
    assert (last["reasonCode"], last["details"]) == ("details_updated", {"estimatedValue": {"from": 260000, "to": 275000}})
    r = api.patch(f"/api/opportunities/{oid}", json={"expectedRowVersion": v, "participants": 10}, headers=AHMED)
    assert (r.status_code, error(r)["code"]) == (409, "stale")
    r = api.patch(f"/api/opportunities/{oid}", json={"expectedRowVersion": v + 1, "participants": 10}, headers=SHERINE)
    assert r.status_code == 403 and "Only the opportunity owner, Ahmed Seif" in error(r)["message"]


# ---------------------------------------------------------------------------
# Clients: edit, stale, contacts, duplicates, archive
# ---------------------------------------------------------------------------

def test_stale_client_edit_is_409_and_changes_are_recorded(api):
    c = get_client(api, "CL-0008", AHMED)
    ok(api.patch("/api/clients/CL-0008", json={"expectedRowVersion": c["rowVersion"], "city": "Smouha"}, headers=AHMED))
    r = api.patch("/api/clients/CL-0008", json={"expectedRowVersion": c["rowVersion"], "notes": "late"}, headers=NOHA)
    assert (r.status_code, error(r)) == (409, {"code": "stale",
                                               "message": "This client was changed by someone else. Reload it and try again."})
    h = history(api, "CL-0008")[0]
    assert (h["event"], h["changedBy"], h["details"]) == ("updated", "u-ahmed", {"city": {"from": c["city"], "to": "Smouha"}})


def test_contacts_add_primary_edit_archive(api):
    c = get_client(api, "CL-0008", AHMED)
    first = c["contacts"][0]
    out = ok(api.post("/api/clients/CL-0008/contacts", json={"expectedRowVersion": c["rowVersion"], "name": "Karim Adel",
                                                           "email": "k.adel@harbor.example", "isPrimary": True}, headers=AHMED))
    contacts = out["client"]["contacts"]
    assert [(x["name"], x["isPrimary"]) for x in contacts] == [(first["name"], False), ("Karim Adel", True)]
    assert out["client"]["contact"]["name"] == "Karim Adel", "the primary contact"
    karim = contacts[1]
    edited = ok(api.patch(f"/api/clients/CL-0008/contacts/{karim['id']}",
                          json={"expectedRowVersion": karim["rowVersion"], "title": "HR Director"}, headers=AHMED))
    assert edited["client"]["contacts"][1]["title"] == "HR Director"
    stale = api.patch(f"/api/clients/CL-0008/contacts/{karim['id']}",
                      json={"expectedRowVersion": karim["rowVersion"], "title": "x"}, headers=AHMED)
    assert stale.status_code == 409
    gone = ok(api.post(f"/api/clients/CL-0008/contacts/{karim['id']}/archive",
                       json={"expectedRowVersion": edited["client"]["contacts"][1]["rowVersion"]}, headers=AHMED))
    assert [x["name"] for x in gone["client"]["contacts"]] == [first["name"]]
    assert [h["event"] for h in history(api, "CL-0008")][:3] == ["contact_archived", "contact_updated", "contact_added"]


def test_duplicate_warnings_never_block(api):
    out = ok(new_client(api, AHMED, name="Harbor Line Logistics LLC", type="corporate", brands=["teamup"]))
    assert out["warnings"][0]["code"] == "possible_duplicate_client"
    assert out["warnings"][0]["clients"] == [{"id": "CL-0008", "name": "Harbor Line Logistics", "matches": ["name"]}]
    phone = get_client(api, "CL-0006")["contact"]["phone"]  # "+20 100 555 0106"
    local = "0" + phone.replace("+20 ", "").replace(" ", "-")
    out = ok(new_client(api, AHMED, name="Completely Different", contact={"name": "A", "phone": local}))
    assert [(d["id"], d["matches"]) for d in out["warnings"][0]["clients"]] == [("CL-0006", ["phone"])]


def test_archived_clients_are_hidden_from_lists_and_the_request_form(api):
    cid = ok(new_client(api, AHMED))["client"]["id"]
    ok(api.post(f"/api/clients/{cid}/archive", json={"expectedRowVersion": get_client(api, cid)["rowVersion"]}, headers=AHMED))
    assert cid not in [c["id"] for c in api.get("/api/clients", headers=NOHA).json()["items"]]
    assert cid not in [c["id"] for c in api.get("/api/clients", params={"creatable": True}, headers=AHMED).json()["items"]]
    r = create_request(api, AHMED, clientId=cid, brand="grasshoppers", service="school_trip")
    assert r.status_code == 422 and error(r)["fields"]["clientId"] == "Choose a client from the list."
    assert get_client(api, cid)["permissions"]["edit"]["reason"] == "This client is archived."


def test_crm_history_is_append_only_in_the_database(api, engine):
    ok(new_client(api, AHMED))
    ok(_transfer(api, "CL-0007", toOwner="u-sherine", reason="Rebalance"))  # writes request_events rows
    for sql in ("UPDATE client_history SET reason = 'x'", "DELETE FROM client_history",
                "UPDATE request_events SET note = 'x'", "DELETE FROM request_events"):
        with engine.connect() as conn:
            with pytest.raises(DatabaseError, match="append-only"):
                conn.execute(text(sql))
            conn.rollback()


def test_migration_copies_each_clients_contact_into_contact_people(tmp_path):
    url = sqlite_url(tmp_path / "m.db")
    config = alembic_config(url)
    command.upgrade(config, "0004")
    eng = create_engine(url)
    with eng.begin() as conn:
        conn.execute(text("INSERT INTO users (id, name, initials, avatar_tone, active, row_version, created_at, updated_at) "
                          "VALUES ('u-x', 'X', 'X', 1, 1, 1, '2026-01-01', '2026-01-01')"))
        conn.execute(text("INSERT INTO clients (id, name, client_type, owner_id, contact_name, contact_title, contact_phone, "
                          "contact_email, row_version, created_at, updated_at) VALUES ('CL-0001', 'A', 'school', 'u-x', "
                          "'Mona', 'Head', '+20 100', 'm@a.example', 1, '2026-01-01', '2026-01-01')"))
    command.upgrade(config, "head")
    with eng.connect() as conn:
        rows = conn.execute(text("SELECT client_id, name, title, phone, email, is_primary FROM client_contacts")).all()
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(clients)"))]
    assert [tuple(r) for r in rows] == [("CL-0001", "Mona", "Head", "+20 100", "m@a.example", 1)]
    assert "contact_name" not in cols
    command.downgrade(config, "0004")
    with eng.connect() as conn:
        back = conn.execute(text("SELECT contact_name, contact_email FROM clients")).all()
    assert [tuple(r) for r in back] == [("Mona", "m@a.example")], "downgrade restores the primary contact"
    eng.dispose()
