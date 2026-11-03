"""
The full walk (API level): a proposal from start to event, checked after EVERY step for the BD owner,
the assigned AM, Noha, Doaa, Operations and an unrelated BD:
  - status, stage, sub-label and "waiting on" are identical in every view for every viewer who sees it;
  - the request is in the right My Work section for each person (and gone from the wrong ones);
  - "New" and the bell reach only the people concerned, never the person who acted;
  - Events and Dashboard counts change by exactly the expected amount; history records who and role.
Then the same for Mariam El Khayat's self-routed case and a request Noha creates on behalf of a BD,
and persistence: after a restart against the same database file nothing has changed, and the mapping
command skips a request that was changed in the app.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.check_users import _as_json, _my_work
from app.clock import get_now
from app.database import utcnow
from app.domain.views import request_from_json
from app.main import create_app
from app.models import Notification, ProposalRequest, RequestRead, User, UserRole

MAIN_SECTIONS = ("Your turn", "Waiting on others · The team", "Waiting on others · The client")

from .conftest import AHMED, MD_AM, MK_AM, MK_BD, NOHA, SHERINE, as_user
from .write_helpers import act, cl, create, detail, edit, future, ok, sample_pdf, upload

DOAA = as_user("u-doaa", "executive")
OPS = as_user("u-omar", "operations")
NADA = as_user("u-nada", "marketing")
ABDELRAHMAN = as_user("u-abdelrahman", "business_development")


def add_people(session):
    for uid, name, role in (("u-omar", "Omar Ops", "operations"), ("u-nada", "Nada Samir", "marketing")):
        u = User(id=uid, name=name, initials=name[:2].upper(), avatar_tone=1, active=True,
                 email=f"{uid}@eventflow.example", created_at=utcnow(), updated_at=utcnow())
        u.roles = [UserRole(role=role, position=0)]
        session.add(u)
    session.commit()


class Walk:
    """Snapshots every viewer after each step and checks what changed."""

    def __init__(self, api, rid, viewers: dict):
        self.api, self.rid, self.viewers = api, rid, viewers
        self.bell = {k: self._unread(h) for k, h in viewers.items()}
        self.events = {k: self._events(h) for k, h in viewers.items()}
        self.log = []

    def _unread(self, h):
        return self.api.get("/api/notifications", headers=h).json()["unread"]

    def _events(self, h):
        r = self.api.get("/api/events", headers=h)
        return len(r.json()["items"]) if r.status_code == 200 else None

    def row(self, h):
        """This viewer's list row (any of their scopes), or None."""
        me = self.api.get("/api/me", headers=h).json()
        for scope in me["scopes"]:
            items = self.api.get("/api/proposal-requests", params={"scope": scope, "pageSize": 100, "include": "history"},
                                 headers=h).json()["items"]
            hit = next((i for i in items if i["id"] == self.rid), None)
            if hit:
                return hit
        return None

    def step(self, name, *, actor, told=(), sections=None, events_delta=0, status=None):
        """After one step: one look for everybody, then the checks."""
        looks = {}
        for k, h in self.viewers.items():
            d = self.api.get(f"/api/proposal-requests/{self.rid}", headers=h)
            looks[k] = (d.json() if d.status_code == 200 else None, self.row(h))
        # Identical everywhere (detail and list, every viewer who sees it).
        shapes = set()
        for k, (d, r) in looks.items():
            for x in (d, r):
                if x:
                    shapes.add((x["status"], x["stage"], x["subLabel"], str(request_from_json(_as_json(x)).waiting_team),
                                str((x.get("waiting") or {}).get("userId"))))
        assert len(shapes) == 1, f"{name}: the same request looks different: {shapes}"
        current = next(iter(shapes))
        if status:
            assert current[0] == status, f"{name}: status {current[0]}, expected {status}"
        # The bell: only the people concerned, never the person who acted.
        bell = {k: self._unread(h) for k, h in self.viewers.items()}
        rang = {k for k in bell if bell[k] > self.bell[k]}
        assert actor not in rang, f"{name}: the person who acted ({actor}) was notified"
        assert rang == set(told), f"{name}: notified {sorted(rang)}, expected {sorted(told)}"
        self.bell = bell
        # "New": never for the person who acted, in any role.
        own = looks[actor][1]
        assert own is None or own["newForYou"] is None, f"{name}: new for the person who acted"
        for k in told:
            r = looks[k][1]
            if r is not None:
                assert r["newForYou"] is not None, f"{name}: not new for {k}, who was told"
        # My Work sections, from the rows each person's screen loads.
        for k, expected in (sections or {}).items():
            r = looks[k][1]
            got = [t for t, pick in _my_work(self.viewers[k]["X-Dev-User"], self.viewers[k]["X-Dev-Role"], utcnow())
                   if t in MAIN_SECTIONS and r and pick(request_from_json(_as_json(r)))]
            assert got == ([expected] if expected else []), f"{name}: {k} sees it in {got}, expected {expected}"
        # Events: counts change by exactly the expected amount.
        ev = {k: self._events(h) for k, h in self.viewers.items()}
        for k in ev:
            if ev[k] is not None and self.events[k] is not None:
                seen_before = self.events[k]
                can_see = looks[k][0] is not None or k in ("ops", "mkt")  # Marketing and Operations see every event
                assert ev[k] - seen_before == (events_delta if can_see else 0), f"{name}: events count for {k}"
        self.events = ev
        # History: who and which role (the last entry is this step's, when it was a status step).
        d = looks["bd"][0] or looks["noha"][0]
        self.log.append(f"{name}: {current[0]} · told {sorted(told) or 'nobody'}")
        return d


def test_walk_a_new_proposal_from_start_to_event(api, session):
    add_people(session)
    viewers = {"bd": AHMED, "am": MD_AM, "noha": NOHA, "doaa": DOAA, "ops": OPS, "other": SHERINE, "mkt": NADA}
    rid = ok(create(api, AHMED, clientId=cl(8), brand="teamup", service="team_building", eventDatePrecision="day",
                    eventDate=future(40), requiredBy=future(10), participants=120, requirementsSummary="Offsite"))["request"]["id"]
    w = Walk(api, rid, viewers)
    assert api.get(f"/api/proposal-requests/{rid}", headers=MD_AM).status_code == 404, "a draft is private"

    ok(edit(api, rid, AHMED, submit=True))
    w.step("submit", actor="bd", told={"am"}, status="submitted",
           sections={"am": "Your turn", "bd": "Waiting on others · The team", "noha": "Waiting on others · The team"})
    # Mariam Dimitri opens it: no longer new for her.
    api.post(f"/api/proposal-requests/{rid}/read", headers=MD_AM)
    assert w.row(MD_AM)["newForYou"] is None
    ok(upload(api, rid, MD_AM, data=sample_pdf()))
    w.step("AM uploads (auto Preparing)", actor="am", told=set(), status="in_progress", sections={"am": "Your turn"})
    ok(act(api, rid, "request_bd_info", MD_AM, note="Which venue?"))
    w.step("AM asks BD and pauses", actor="am", told={"bd"}, status="awaiting_bd_info",
           sections={"bd": "Your turn", "am": "Waiting on others · The team"})
    ok(act(api, rid, "provide_bd_info", AHMED, note="The garden venue"))
    w.step("BD answers", actor="bd", told={"am"}, status="submitted", sections={"am": "Your turn"})
    ok(act(api, rid, "start_work", MD_AM))
    w.step("AM starts again", actor="am", status="in_progress")
    v = detail(api, rid, MD_AM)["rowVersion"]
    ok(api.post(f"/api/proposal-requests/{rid}/waiting-on", headers=MD_AM,
                json={"team": "marketing", "userId": "u-nada", "reason": "design", "expectedRowVersion": v}))
    w.step("set waiting on Marketing", actor="am", told={"mkt"}, status="in_progress",
           sections={"am": "Waiting on others · The team", "bd": "Waiting on others · The team"})
    v = detail(api, rid, NOHA)["rowVersion"]
    ok(api.post(f"/api/proposal-requests/{rid}/waiting-on/clear", headers=NADA, json={"expectedRowVersion": v}))
    w.step("Marketing: task done", actor="mkt", status="in_progress", sections={"am": "Your turn"})
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=95000))
    w.step("ready for BD", actor="am", told={"bd"}, status="ready_for_bd", sections={"bd": "Your turn", "am": "Waiting on others · The team"})
    # Ahmed asks a question: new for Mariam once; she answers: not new for her.
    ok(api.post(f"/api/proposal-requests/{rid}/comments", headers=AHMED, json={"kind": "question", "body": "Is the bus included?"}))
    w.step("BD asks a question", actor="bd", told={"am"}, status="ready_for_bd")
    q = next(c for c in detail(api, rid, MD_AM)["comments"] if c["kind"] == "question")
    ok(api.post(f"/api/proposal-requests/{rid}/comments", headers=MD_AM, json={"kind": "answer", "body": "Yes", "parentId": q["id"]}))
    w.step("AM answers", actor="am", told={"bd"}, status="ready_for_bd")
    ok(api.post(f"/api/proposal-requests/{rid}/comments", headers=AHMED,
                json={"kind": "change", "about": "internal", "reasons": ["price"], "body": "Too high"}))
    w.step("BD: change needed", actor="bd", told={"am", "noha"}, status="revision_requested", sections={"am": "Your turn"})
    ok(act(api, rid, "start_revision", MD_AM))
    ok(upload(api, rid, MD_AM, data=sample_pdf("v2")))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=90000, note="Cheaper buses"))
    w.step("ready again", actor="am", told={"bd"}, status="ready_for_bd")
    ok(act(api, rid, "share_with_client", AHMED, confirmShared=True, channel="email"))
    w.step("share with client", actor="bd", status="shared_with_client", sections={"bd": "Waiting on others · The client", "am": "Waiting on others · The client"})
    ok(act(api, rid, "postpone", AHMED, followUpOn=future(5), reasons=["budget_not_approved"]))
    w.step("postpone", actor="bd", status="postponed", sections={"bd": "Waiting on others · The client"})
    ok(act(api, rid, "resume", AHMED))
    w.step("back with client", actor="bd", status="shared_with_client")
    ok(act(api, rid, "record_accepted", AHMED, eventDate=future(1), eventStatus="initial"))
    d = w.step("initially confirmed", actor="bd", told={"am", "ops"}, status="accepted", events_delta=1)
    assert d["history"][-1]["changedBy"] == "u-ahmed" and d["history"][-1]["role"] == "business_development"
    ev = api.get(f"/api/events/{rid}", headers=AHMED).json()
    ok(api.post(f"/api/events/{rid}/confirm", headers=AHMED, json={"eventDate": future(1), "expectedRowVersion": ev["rowVersion"]}))
    w.step("confirm event", actor="bd", told={"ops"}, status="accepted")
    ops_view = api.get(f"/api/events/{rid}", headers=OPS).json()
    assert ops_view["eventStatus"] == "confirmed" and "finalPrice" not in ops_view, "Operations: no price"
    # The event is done once its date has passed.
    api.app.dependency_overrides[get_now] = lambda: datetime.now(timezone.utc) + timedelta(days=3)
    assert api.get(f"/api/events/{rid}", headers=NOHA).json()["timing"] == "done"
    api.app.dependency_overrides.pop(get_now)
    # "Correct status" jumps: no one is told.
    v = detail(api, rid, NOHA)["rowVersion"]
    ok(api.post(f"/api/proposal-requests/{rid}/correct-status", headers=NOHA,
                json={"target": "with_client", "expectedRowVersion": v}))
    w.step("correct: Confirmed -> With client", actor="noha", status="shared_with_client", events_delta=-1)
    v = detail(api, rid, NOHA)["rowVersion"]
    ok(api.post(f"/api/proposal-requests/{rid}/correct-status", headers=NOHA,
                json={"target": "lost", "lostReason": "price", "expectedRowVersion": v}))
    w.step("correct: With client -> Lost", actor="noha", status="rejected")
    v = detail(api, rid, NOHA)["rowVersion"]
    ok(api.post(f"/api/proposal-requests/{rid}/correct-status", headers=NOHA,
                json={"target": "confirmed", "eventDate": future(20), "expectedRowVersion": v}))
    w.step("correct: Lost -> Confirmed", actor="noha", status="accepted", events_delta=1)
    last = detail(api, rid, NOHA)["history"][-1]
    assert (last["corrected"], last["changedBy"], last["role"]) == (True, "u-noha", "commercial_head")


def test_walk_self_routed_and_on_behalf(api, session):
    add_people(session)
    # Mariam El Khayat: BD owner and the Grasshoppers AM. Her own steps are never new for her, in either role.
    rid = ok(create(api, MK_BD, submit=True, clientId=cl(1), brand="grasshoppers", service="explorers_league",
                    eventDate=future(30), requiredBy=future(7), participants=60, requirementsSummary="Term trip"))["request"]["id"]
    w = Walk(api, rid, {"bd": MK_BD, "am": MK_AM, "noha": NOHA, "ops": OPS, "other": SHERINE})
    w.step("self-routed submit", actor="bd", status="submitted")
    assert w.row(MK_AM)["newForYou"] is None, "her own submission is not new for her as AM"
    ok(act(api, rid, "start_work", MK_AM))
    w.step("she starts as AM", actor="am", status="in_progress")
    ok(api.post(f"/api/proposal-requests/{rid}/comments", headers=NOHA, json={"body": "Looks good @Mariam El Khayat"}))
    w.step("Noha writes", actor="noha", told={"bd", "am"}, status="in_progress")

    # Noha creates on behalf of a BD: the BD owner and the AM are told on submit, never Noha.
    rid2 = ok(create(api, NOHA, clientId=cl(7), brand="teamup", service="corporate_event"))["request"]["id"]
    w2 = Walk(api, rid2, {"bd": ABDELRAHMAN, "am": MD_AM, "noha": NOHA, "other": SHERINE})
    ok(edit(api, rid2, NOHA, submit=True, eventDate=future(60), requiredBy=future(12), participants=250,
            requirementsSummary="Annual gathering"))
    d = w2.step("submit on behalf", actor="noha", told={"am"}, status="submitted", sections={"am": "Your turn"})
    assert d["bdOwner"] == "u-abdelrahman" and d["history"][-1]["onBehalfOf"] == "u-abdelrahman"


def test_persistence_after_a_restart_and_the_mapping_skips_app_work(dev_settings, engine, seeded, session):
    first = TestClient(create_app(dev_settings, engine=engine), client=("127.0.0.1", 50000))
    with first as api:
        rid = ok(create(api, AHMED, submit=True, clientId=cl(8), brand="teamup", service="team_building",
                        eventDatePrecision="day", eventDate=future(40), requiredBy=future(10), participants=80,
                        requirementsSummary="Offsite"))["request"]["id"]
        ok(upload(api, rid, MD_AM, data=sample_pdf()))
        ok(api.post(f"/api/proposal-requests/{rid}/comments", headers=AHMED, json={"body": "Thanks"}))
        api.post(f"/api/proposal-requests/{rid}/read", headers=MD_AM)
        before = {who: (api.get(f"/api/proposal-requests/{rid}", headers=h).json(),
                        api.get("/api/notifications", headers=h).json())
                  for who, h in (("bd", AHMED), ("am", MD_AM), ("noha", NOHA))}
    # A new server process on the same database file.
    with TestClient(create_app(dev_settings, engine=engine), client=("127.0.0.1", 50000)) as api:
        for who, h in (("bd", AHMED), ("am", MD_AM), ("noha", NOHA)):
            d, bell = api.get(f"/api/proposal-requests/{rid}", headers=h).json(), api.get("/api/notifications", headers=h).json()
            assert (d["status"], d["comments"], d["files"], d["lastReadAt"]) == (
                before[who][0]["status"], before[who][0]["comments"], before[who][0]["files"], before[who][0]["lastReadAt"]), who
            assert bell == before[who][1], f"{who}: notifications changed after a restart"
    assert session.scalar(select(RequestRead.read_at).where(RequestRead.user_id == "u-mariam-dimitri",
                                                            RequestRead.request_id == rid)) is not None
    # Pretend it came from the sheet: the mapping must skip it (it was changed in the app).
    row = session.get(ProposalRequest, rid)
    row.import_row, row.imported, row.original_status = 999, True, "Pending"
    session.commit()
    from app.apply_tracker_mapping import plan
    from datetime import date
    change = next(c for c in plan(session, None, date.today()) if c.row.id == rid)
    assert change.kind == "kept"
