"""
My Work sections and personal to-dos:
- the sections (Your turn · Waiting on others: the team / the client) and "Stuck · N days" match the contract;
- to-dos validate like the frontend; they are private (only the owner lists, edits, ticks or deletes them,
  Noha included), soft-deleted, linkable only to a client, request or event the owner can see;
- ticked ones stay listed for 30 days ("Show completed"); deleted ones never come back.
"""

from datetime import datetime, timedelta

from app.clock import get_now
from app.database import utcnow
from app.domain import my_work
from app.domain.todos import validate_todo
from app.domain.views import request_from_json
from app.models import Todo

from .conftest import AHMED, MD_AM, NOHA, as_user
from .contract_world import load_scenarios
from .write_helpers import cl, error, ok

SCENARIOS = load_scenarios()
NOW = datetime.fromisoformat(SCENARIOS["now"].replace("Z", "+00:00"))
REQUESTS = [request_from_json(r) for r in SCENARIOS["world"]["requests"]]


def test_my_work_sections_and_stuck_match_the_contract():
    for case in SCENARIOS["myWorkCases"]:
        uid, role = case["viewer"]["userId"], case["viewer"]["activeRole"]
        sections = {r.id: s for r in REQUESTS if (s := my_work.my_work_section(r, uid, role, NOW))}
        stuck = {r.id: d for r in REQUESTS if (d := my_work.stuck_days(r, role, NOW)) is not None}
        assert sections == case["sections"], case["viewer"]
        assert stuck == case["stuck"], case["viewer"]
    noha = next(c for c in SCENARIOS["myWorkCases"] if c["viewer"]["userId"] == "u-noha")
    assert noha["stuck"] and set(noha["stuck"]) <= set(noha["sections"]), "stuck ones are inside Waiting on others"
    assert not any(c["stuck"] for c in SCENARIOS["myWorkCases"] if c["viewer"]["activeRole"] not in my_work.MANAGEMENT)


def test_todo_validation_matches_the_contract():
    for case in SCENARIOS["todoCases"]:
        errors, values = validate_todo(case["input"])
        assert {"errors": errors, "values": values} == case["expect"], case["input"]


def _add(api, headers, **body):
    return api.post("/api/todos", headers=headers, json=body)


def test_todos_are_private_soft_deleted_and_linked_only_to_what_the_owner_sees(api, session):
    t = ok(_add(api, AHMED, text="  Call before Thursday ", dueOn="2026-11-05", linkKind="client", linkId=cl(8)))
    assert (t["text"], t["dueOn"], t["linkKind"], t["linkId"]) == ("Call before Thursday", "2026-11-05", "client", cl(8))
    assert t["linkLabel"], "the client's name, for the line on its page"
    event_id = api.get("/api/events", headers=AHMED).json()["items"][0]["id"]
    ev = ok(_add(api, AHMED, text="Brief the venue", linkKind="event", linkId=event_id))
    plain = ok(_add(api, AHMED, text="Expenses"))
    assert [x["id"] for x in api.get("/api/todos", headers=AHMED).json()["items"]] == [t["id"], ev["id"], plain["id"]]

    # Private: nobody else lists, edits, ticks or deletes them, not even Noha (same answer as "no such to-do").
    assert api.get("/api/todos", headers=NOHA).json()["items"] == []
    assert api.patch(f"/api/todos/{t['id']}", headers=NOHA, json={"text": "Mine now"}).status_code == 404
    assert api.post(f"/api/todos/{t['id']}/done", headers=NOHA, json={"done": True}).status_code == 404
    assert api.post(f"/api/todos/{t['id']}/delete", headers=NOHA).status_code == 404
    # The same person in another role keeps the same to-dos.
    mk = ok(_add(api, as_user("u-mariam-elkhayat", "business_development"), text="Mine in both roles"))
    assert mk["id"] in {x["id"] for x in api.get("/api/todos", headers=as_user("u-mariam-elkhayat", "account_manager")).json()["items"]}

    # Validation and links: only a client, request or event the owner can see.
    r = _add(api, AHMED, text=" ", dueOn="2026-02-30", linkKind="opportunity", linkId="OPP-0001")
    assert r.status_code == 422 and set(error(r)["fields"]) == {"text", "dueOn", "link"}
    r = _add(api, AHMED, text="Ghost", linkKind="request", linkId="PR-2099-9999")
    assert r.status_code == 422 and "not available" in error(r)["fields"]["link"]
    hidden = next(c["id"] for c in api.get("/api/clients", headers=NOHA).json()["items"]
                  if c["id"] not in {x["id"] for x in api.get("/api/clients", headers=MD_AM).json()["items"]})
    assert _add(api, MD_AM, text="Other brand", linkKind="client", linkId=hidden).status_code == 422

    # Edit, tick, untick, delete (soft: the row stays, it never comes back).
    edited = ok(api.patch(f"/api/todos/{t['id']}", headers=AHMED, json={"text": "Call on Wednesday", "dueOn": None}))
    assert (edited["text"], edited["dueOn"], edited["linkKind"]) == ("Call on Wednesday", None, None)
    assert ok(api.post(f"/api/todos/{plain['id']}/done", headers=AHMED, json={"done": True}))["doneAt"]
    assert ok(api.post(f"/api/todos/{plain['id']}/done", headers=AHMED, json={"done": False}))["doneAt"] is None
    ok(api.post(f"/api/todos/{ev['id']}/delete", headers=AHMED))
    assert ev["id"] not in {x["id"] for x in api.get("/api/todos", headers=AHMED).json()["items"]}
    assert session.get(Todo, ev["id"]).deleted_at is not None, "soft delete"
    assert api.post(f"/api/todos/{ev['id']}/done", headers=AHMED, json={"done": True}).status_code == 404

    # Ticked ones stay listed for 30 days ("Show completed"), then drop off the list.
    ok(api.post(f"/api/todos/{plain['id']}/done", headers=AHMED, json={"done": True}))
    api.app.dependency_overrides[get_now] = lambda: utcnow() + timedelta(days=29)
    assert plain["id"] in {x["id"] for x in api.get("/api/todos", headers=AHMED).json()["items"]}
    api.app.dependency_overrides[get_now] = lambda: utcnow() + timedelta(days=40)
    assert plain["id"] not in {x["id"] for x in api.get("/api/todos", headers=AHMED).json()["items"]}
    api.app.dependency_overrides.pop(get_now, None)
