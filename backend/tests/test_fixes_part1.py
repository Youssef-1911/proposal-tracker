"""
Fixes from the test run (part 1). One test per bug so it cannot come back:
1a two roles: New and the bell are per person AND role; acting as BD is New for yourself as AM.
1b "Details changed" reaches the assigned AM: New and a bell notification.
1c anything marked New also notifies (e.g. "Proposal ready for you").
1e one source of truth for waiting-on: a manual waiting-on wins in every filter and in "Needs my action".
1g a team with no one named (Marketing) gets a bell notification when it is set as waiting on.
2  newest on top: Proposals and Clients list the most recent activity first by default.
"""

from app.database import utcnow
from app.models import Notification, User, UserRole

from .conftest import AHMED, MD_AM, MK_AM, MK_BD, NOHA, as_user
from .write_helpers import act, cl, create, detail, future, ok, sample_pdf, upload

NADA = as_user("u-nada", "marketing")


def teamup(**over):
    return {"clientId": "CL-0008", "brand": "teamup", "service": "team_building", "eventDatePrecision": "day",
            "eventDate": future(40), "requiredBy": future(10), "participants": 80, "requirementsSummary": "Offsite", **over}


def row_of(api, rid, who, **params):
    items = api.get("/api/proposal-requests", params={"pageSize": 100, **params}, headers=who).json()["items"]
    return next((i for i in items if i["id"] == rid), None)


def bell(api, who):
    return api.get("/api/notifications", headers=who).json()


def titles(api, who):
    return [n["title"] for n in bell(api, who)["items"]]


def test_1a_two_roles_own_actions_are_never_new_and_others_show_per_role(api):
    """Follow-up rule: a person's own action is never new for them, in either role; what someone else does
    shows in the role it concerns. Read state is per person and role."""
    rid = ok(create(api, MK_BD, submit=True, clientId=cl(1), brand="grasshoppers", service="explorers_league",
                    eventDate=future(30), requiredBy=future(7), participants=60, requirementsSummary="Term trip"))["request"]["id"]
    assert row_of(api, rid, MK_AM)["newForYou"] is None, "her own submission is not new for her as AM"
    assert row_of(api, rid, MK_BD)["newForYou"] is None
    assert "New request from Mariam El Khayat" not in titles(api, MK_AM) + titles(api, MK_BD), "no bell for her own action"
    ok(api.post(f"/api/proposal-requests/{rid}/comments", headers=NOHA, json={"body": "Please check @Mariam El Khayat"}))
    assert row_of(api, rid, MK_AM)["newForYou"] is not None and row_of(api, rid, MK_BD)["newForYou"] is not None
    assert api.post(f"/api/proposal-requests/{rid}/read", headers=MK_BD).status_code == 200
    assert row_of(api, rid, MK_AM)["newForYou"] is not None, "opening it as BD does not clear it for her as AM"
    ok(act(api, rid, "start_work", MK_AM))
    assert row_of(api, rid, MK_AM)["newForYou"] is None, "acting on it marks it read"


def test_1b_details_changed_reaches_the_assigned_am(api):
    rid = ok(create(api, AHMED, submit=True, **teamup()))["request"]["id"]
    api.post(f"/api/proposal-requests/{rid}/read", headers=MD_AM)
    v = detail(api, rid, AHMED)["rowVersion"]
    ok(api.patch(f"/api/proposal-requests/{rid}/details", headers=AHMED, json={"participants": 120, "expectedRowVersion": v}))
    assert row_of(api, rid, MD_AM)["newForYou"]["line"] == "Details changed by Ahmed Seif"
    note = bell(api, MD_AM)["items"][0]
    assert (note["title"], note["kind"]) == ("Details changed by Ahmed Seif", "activity")
    d = detail(api, rid, MD_AM)
    assert d["detailsChangedAt"] and not d["detailsSeenAt"], "the banner shows until the AM has seen it"


def test_1c_everything_new_also_notifies(api):
    rid = ok(create(api, AHMED, submit=True, **teamup()))["request"]["id"]
    assert titles(api, MD_AM)[0] == "New request from Ahmed Seif"
    ok(act(api, rid, "start_work", MD_AM))
    ok(upload(api, rid, MD_AM, data=sample_pdf()))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=90000))
    assert row_of(api, rid, AHMED)["newForYou"]["line"] == "Proposal ready for you"
    assert titles(api, AHMED)[0] == "Proposal ready for you", "New for him, so the bell too"
    assert "Proposal ready for you" not in titles(api, MD_AM), "never for the person who did it"


def add_marketing(session, uid="u-nada", name="Nada Samir"):
    user = User(id=uid, name=name, initials="NS", avatar_tone=1, active=True, email=f"{uid}@eventflow.example",
                created_at=utcnow(), updated_at=utcnow())
    user.roles = [UserRole(role="marketing", position=0)]
    session.add(user)
    session.commit()


def test_1e_and_1g_manual_waiting_on_is_the_one_truth_and_the_team_is_told(api, session):
    add_marketing(session)
    rid = ok(create(api, AHMED, submit=True, **teamup()))["request"]["id"]
    ok(act(api, rid, "start_work", MD_AM))
    v = detail(api, rid, MD_AM)["rowVersion"]
    ok(api.post(f"/api/proposal-requests/{rid}/waiting-on", headers=MD_AM,
                json={"team": "marketing", "userId": None, "reason": "design", "expectedRowVersion": v}))
    assert row_of(api, rid, NOHA, waiting="marketing") is not None
    assert row_of(api, rid, NOHA, waitingOn="am") is None, "not waiting on the AM any more (the manual one wins)"
    assert row_of(api, rid, MD_AM, tab="action") is None, "not the AM's action while it waits on Marketing"
    assert any(t.startswith("Waiting on you — set by Mariam Dimitri") for t in titles(api, NADA)), "Marketing gets the bell"
    note = bell(api, NADA)["items"][0]
    assert note["link"] == "/" and note["kind"] == "waiting_on", "Marketing cannot open the request; the link goes home"


def test_2_newest_activity_first_by_default(api):
    first = ok(create(api, AHMED, submit=True, **teamup()))["request"]["id"]
    second = ok(create(api, AHMED, submit=True, **teamup()))["request"]["id"]
    ids = [i["id"] for i in api.get("/api/proposal-requests", params={"pageSize": 100}, headers=AHMED).json()["items"]]
    assert ids.index(second) < ids.index(first)
    created = api.post("/api/clients", headers=AHMED, json={"name": "Newest Client Co", "type": "school", "city": "Maadi",
                                                         "brands": ["teamup"]})
    assert created.status_code == 201, created.text
    assert api.get("/api/clients", headers=AHMED).json()["items"][0]["name"] == "Newest Client Co"


def test_notifications_have_no_duplicates_for_one_change(api, session):
    rid = ok(create(api, AHMED, submit=True, **teamup()))["request"]["id"]
    ok(act(api, rid, "start_work", MD_AM))
    assert session.query(Notification).filter_by(user_id="u-mariam-dimitri", title="New request from Ahmed Seif").count() == 1
