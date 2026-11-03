"""
1:1 port of frontend/tests/workflow.test.mjs (see tests/PORTING.md).
Runs through the WRITE API over the seeded demo database (the one-to-one port of the frontend
seed); the frontend test name is in each docstring.
"""

from datetime import datetime, timedelta

from sqlalchemy import select

from app.clock import get_now
from app.config_domain import BRAND_AM_ROUTING, PROPOSAL_STATUSES
from app.domain.rules import open_status_ids
from app.domain.workflow import TRANSITIONS, apply_action
from app.domain.views import parse_ts
from app.models import ProposalRequest

from .conftest import AHMED, MD_AM, MK_AM, MK_BD, NOHA, SHERINE, as_user, pr
from .write_helpers import act, cl, create, detail, error, future, ok, opportunity, upload

ABDELRAHMAN = as_user("u-abdelrahman", "business_development")
STATUS_IDS = {s["id"] for s in PROPOSAL_STATUSES}
SHARE = {"confirmShared": True, "channel": "whatsapp"}


def allowed(api, rid, headers):
    return [a["action"] for a in detail(api, rid, headers)["allowedActions"] if a["allowed"]]


def stored(session, rid):
    session.expire_all()
    row = session.get(ProposalRequest, rid)
    return row.status, row.row_version, len(row.history)


# ---------- table ----------

def test_transition_table_and_cancel_from_open_statuses_only(api):
    """JS: transition table only uses statuses from STATUS_CONFIG; cancel starts only from open statuses"""
    for t in TRANSITIONS:
        assert t["to"] in STATUS_IDS and set(t["from"]) <= STATUS_IDS, t["action"]
    cancel = next(t for t in TRANSITIONS if t["action"] == "cancel")
    assert sorted(cancel["from"]) == sorted(open_status_ids())
    assert "draft" not in cancel["from"]
    assert "cancel" not in [a["action"] for a in detail(api, pr(19), AHMED)["allowedActions"]], "drafts: no cancel"


# ---------- full lifecycle ----------

def test_end_to_end_lifecycle(api):
    """JS: end to end: create -> submit -> info loop -> ready -> share -> revision v2 -> ready -> share -> accepted"""
    opp = opportunity(api, "OPP-0004", NOHA)
    created = ok(create(api, AHMED, clientId=cl(8), brand="teamup", service="family_day", opportunityId="OPP-0004",
                        eventDate=opp["eventDate"], eventDatePrecision=opp["eventDatePrecision"], participants=300,
                        requiredBy=future(5), requirementsSummary="Family day for 300 people"))["request"]
    rid = created["id"]
    assert rid == pr(20)
    assert created["assignedAM"] == BRAND_AM_ROUTING["teamup"]

    ok(act(api, rid, "submit", AHMED))
    assert opportunity(api, "OPP-0004", NOHA)["stage"] == "proposal_requested", "submit advances the opportunity"
    ok(act(api, rid, "start_work", MD_AM))
    ok(act(api, rid, "request_bd_info", MD_AM, note="Need venue capacity"))
    assert detail(api, rid, NOHA)["status"] == "awaiting_bd_info"
    ok(act(api, rid, "provide_bd_info", AHMED, note="350 seated"))
    assert detail(api, rid, NOHA)["status"] == "submitted", "the answer hands the request back to the AM"
    ok(act(api, rid, "start_work", MD_AM))
    ok(upload(api, rid, MD_AM))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=250000))
    ok(act(api, rid, "share_with_client", AHMED, **SHARE))
    assert opportunity(api, "OPP-0004", NOHA)["stage"] == "negotiation", "sharing advances the opportunity"
    new_deadline = future(4)
    ok(act(api, rid, "request_revision", AHMED, note="Half-day option", newRequiredBy=new_deadline))
    assert detail(api, rid, NOHA)["requiredBy"] == new_deadline
    ok(act(api, rid, "start_revision", MD_AM))
    assert detail(api, rid, NOHA)["version"] == 2
    assert detail(api, rid, NOHA)["amPrice"] is None, "new version has no price until it is ready"
    ok(upload(api, rid, MD_AM))
    ok(act(api, rid, "mark_ready", MD_AM, amPrice=210000, note="Half day, price down EGP 40,000"))
    ok(act(api, rid, "share_with_client", AHMED, **SHARE))
    done = ok(act(api, rid, "record_accepted", AHMED, eventDate=future(30)))
    assert "OPP-0004 marked Confirmed" in done["message"]

    r = detail(api, rid, NOHA)
    assert r["status"] == "accepted"
    assert opportunity(api, "OPP-0004", NOHA)["stage"] == "won"
    assert len(r["history"]) == 13  # draft + 12 actions
    assert [(v["version"], v["amPrice"]) for v in r["versions"]] == [(2, 210000), (1, 250000)], "v1 price preserved"
    assert r["lastUpdated"] == r["history"][-1]["changedAt"]
    for e in r["history"]:
        am_step = e["status"] in ("in_progress", "awaiting_bd_info", "ready_for_bd")
        assert e["role"] == ("account_manager" if am_step else "business_development"), e["status"]
        assert e["changedBy"] == ("u-mariam-dimitri" if am_step else "u-ahmed"), e["status"]
    revision = next(e for e in r["history"] if e["status"] == "revision_requested")
    assert revision["requiredBy"] == new_deadline
    assert revision["previousRequiredBy"]
    # Server-side addition: the opportunity history records why each stage changed.
    reasons = [h["reasonCode"] for h in opportunity(api, "OPP-0004", NOHA)["history"][1:]]
    assert reasons == ["proposal_requested", "proposal_shared", "proposal_accepted"]


# ---------- who may act ----------

def test_am_steps_only_the_assigned_am_as_am(api, session):
    """JS: AM steps: only the assigned AM, acting as AM"""
    rid = pr(17)  # Team Up, submitted
    assert allowed(api, rid, MD_AM) == ["start_work"], "the AM may start work but not cancel"
    for viewer in (NOHA, ABDELRAHMAN):
        r = act(api, rid, "start_work", viewer)
        assert r.status_code == 403
        assert "Only the assigned Account Manager, Mariam Dimitri" in error(r)["message"]
    assert act(api, rid, "start_work", MK_AM).status_code == 404, "the Grasshoppers AM does not see Team Up requests"
    assert stored(session, rid)[0] == "submitted", "rejected attempts change nothing"


def test_bd_steps_only_the_bd_owner_as_bd(api):
    """JS: BD steps: only the BD owner, acting as BD (not other BDs, not the Head, not the AM)"""
    rid = pr(10)  # Ready for BD, owner Abdelrahman
    for viewer in (AHMED, SHERINE, NOHA, MD_AM):
        r = act(api, rid, "share_with_client", viewer, **SHARE)
        assert (r.status_code, error(r)["message"]) == (403, "Only the BD owner, Abdelrahman Shams, can do this.")
    ok(act(api, rid, "share_with_client", ABDELRAHMAN, **SHARE))


def test_mariam_actions_follow_her_active_role(api):
    """JS: Mariam El Khayat's actions follow her active role on her self-assigned requests"""
    submitted = pr(16)
    d = detail(api, submitted, NOHA)
    assert d["bdOwner"] == d["assignedAM"]
    as_bd = act(api, submitted, "start_work", MK_BD)
    assert as_bd.status_code == 403 and "Switch your active role to Account Manager — Grasshoppers" in error(as_bd)["message"]
    assert ok(act(api, submitted, "start_work", MK_AM))["request"]["history"][-1]["role"] == "account_manager"

    ready = pr(11)
    as_am = act(api, ready, "share_with_client", MK_AM, **SHARE)
    assert as_am.status_code == 403 and "Switch your active role to Business Development" in error(as_am)["message"]
    assert ok(act(api, ready, "share_with_client", MK_BD, **SHARE))["request"]["history"][-1]["role"] == "business_development"


def test_actions_for_the_current_status_with_allowed_and_reason(api):
    """JS: getActions lists only actions for the current status, each with allowed/reason"""
    actions = detail(api, pr(7), SHERINE)["allowedActions"]  # shared with client
    assert sorted(a["action"] for a in actions) == sorted(["cancel", "postpone", "record_accepted", "record_rejected", "request_revision"])
    assert all(a["allowed"] for a in actions)
    assert all(not a["allowed"] and a["reason"] for a in detail(api, pr(7), AHMED)["allowedActions"])
    assert allowed(api, pr(7), NOHA) == ["cancel"]


# ---------- invalid transitions & validation ----------

def test_actions_not_valid_for_the_current_status_are_rejected(api):
    """JS: actions not valid for the current status are rejected"""
    r = act(api, pr(17), "share_with_client", ABDELRAHMAN, **SHARE)  # still Submitted
    assert r.status_code == 409 and "not possible while the request is Submitted" in error(r)["message"]
    assert act(api, pr(17), "teleport", NOHA).status_code == 422
    for rid in (pr(2), pr(1), pr(4)):  # accepted, rejected, cancelled
        assert detail(api, rid, NOHA)["allowedActions"] == [], f"{rid} is closed"


def test_required_inputs_are_validated_and_failures_change_nothing(api, session):
    """JS: required inputs are validated and failures leave the record untouched"""
    ok(upload(api, pr(14), MK_AM))  # the file is there, so the inputs themselves are checked
    before = stored(session, pr(14))  # In Progress, Grasshoppers
    for price in ("", None, "abc", 0, -5, 12.5):
        r = act(api, pr(14), "mark_ready", MK_AM, amPrice=price)
        assert r.status_code == 422 and "amPrice" in error(r)["fields"], price
    assert "note" in error(act(api, pr(14), "request_bd_info", MK_AM, note="   "))["fields"]
    assert stored(session, pr(14)) == before

    shared = pr(7)
    assert "newRequiredBy" in error(act(api, shared, "request_revision", SHERINE, note="x"))["fields"]
    assert "newRequiredBy" in error(act(api, shared, "request_revision", SHERINE, note="x", newRequiredBy=future(-1)))["fields"]
    assert "lostReason" in error(act(api, shared, "record_rejected", SHERINE))["fields"], "a lost reason must be chosen"
    assert "confirmShared" in error(act(api, pr(11), "share_with_client", MK_BD))["fields"]


def test_apply_action_is_pure_and_a_refused_action_changes_nothing(api, session):
    """JS: applyAction is pure: it never mutates the request it receives"""
    from app.domain.views import request_from_orm, user_from_orm
    from app.identity import Actor
    from app.models import User
    row = session.get(ProposalRequest, pr(17))
    view = request_from_orm(row)
    users = {u.id: user_from_orm(u) for u in session.scalars(select(User)).all()}
    args = dict(viewer=Actor("u-mariam-dimitri", "account_manager"), users=users, opportunities={},
                all_requests=[view], clients={}, now=datetime.now().astimezone())
    first = apply_action(view, "start_work", {}, **args)
    assert first["ok"] and view.status == "submitted" and len(view.history) == 2, "input untouched"
    assert stored(session, pr(17))[0] == "submitted", "nothing written by the pure rules"


# ---------- drafts, creation, on-behalf ----------

def test_head_creates_and_submits_on_behalf_draft_private_until_submitted(api):
    """JS: Commercial Head creates and submits on behalf of the BD owner; draft private until submitted"""
    opp = opportunity(api, "OPP-0002", NOHA)
    r = ok(create(api, NOHA, clientId=cl(5), brand="grasshoppers", service="school_trip", opportunityId="OPP-0002",
                  eventDate=opp["eventDate"], eventDatePrecision=opp["eventDatePrecision"], participants=80,
                  requiredBy=future(6), requirementsSummary="Grade 4 trip"))["request"]
    assert (r["createdBy"], r["bdOwner"], r["assignedAM"]) == ("u-noha", "u-ahmed", BRAND_AM_ROUTING["grasshoppers"])
    assert r["history"][0]["onBehalfOf"] == "u-ahmed"

    assert api.get(f"/api/proposal-requests/{r['id']}", headers=AHMED).status_code == 404, "BD owner cannot see the Head's draft"
    assert act(api, r["id"], "submit", AHMED).status_code == 404

    ok(act(api, r["id"], "submit", NOHA))
    after = detail(api, r["id"], AHMED)  # visible to everyone once submitted
    assert after["submittedBy"] == "u-noha"
    assert (after["history"][-1]["onBehalfOf"], after["history"][-1]["role"]) == ("u-ahmed", "commercial_head")
    assert allowed(api, r["id"], AHMED) == ["cancel"], "BD owner can now act on BD steps (cancel)"


def test_bd_creates_only_for_own_clients_and_am_cannot_create(api):
    """JS: a BD can create only for clients they own; an AM cannot create"""
    data = {"clientId": cl(8), "brand": "teamup", "service": "family_day", "requiredBy": future(5),
            "requirementsSummary": "x"}  # owner Ahmed
    assert create(api, SHERINE, **data).status_code == 403
    assert create(api, MD_AM, **data).status_code == 403
    bad = create(api, AHMED, **{**data, "requirementsSummary": " ", "requiredBy": future(-2)})
    assert bad.status_code == 422
    assert "requiredBy" in error(bad)["fields"], "past deadline rejected even in a draft"
    assert "requirementsSummary" not in error(bad)["fields"], "brief is optional for a draft (required on submit)"


def test_bd_submits_own_draft_mariam_must_be_in_bd_mode(api):
    """JS: a BD submits their own draft; Mariam El Khayat must be in BD mode to submit hers"""
    assert act(api, pr(18), "submit", MK_AM).status_code == 403
    r = ok(act(api, pr(18), "submit", MK_BD))["request"]
    assert r["submittedBy"] == "u-mariam-elkhayat"
    assert r["history"][-1]["onBehalfOf"] is None
    assert r["assignedAM"] == "u-mariam-elkhayat", "routes to herself as Grasshoppers AM"


# ---------- cancel ----------

def test_cancel_rules(api):
    """JS: cancel: BD owner or Commercial Head with a reason; never the AM; never drafts or closed requests"""
    assert act(api, pr(13), "cancel", MD_AM, note="x").status_code == 403
    assert "note" in error(act(api, pr(13), "cancel", AHMED))["fields"]
    ok(act(api, pr(13), "cancel", AHMED, note="Client postponed"))
    ok(act(api, pr(15), "cancel", NOHA, note="Duplicate"))
    assert act(api, pr(19), "cancel", AHMED, note="x").status_code == 409, "draft"
    assert act(api, pr(2), "cancel", NOHA, note="x").status_code == 409, "already accepted"


# ---------- opportunity effects ----------

def test_rejected_sets_lost_only_when_no_other_request_is_open(api):
    """JS: rejected sets the opportunity Lost only when no other request for it is open"""
    res = ok(act(api, pr(7), "record_rejected", SHERINE, lostReason="budget_cancelled"))  # OPP-0013, only request
    assert opportunity(api, "OPP-0013", NOHA)["stage"] == "lost"
    assert "marked Lost" in res["message"]

    # Another open request on the same opportunity keeps it alive.
    other = ok(create(api, MK_BD, submit=True, clientId=cl(12), brand="teamup", service="family_day",
                      opportunityId="OPP-0014", eventDate=future(50), requiredBy=future(9), participants=150,
                      requirementsSummary="Second option"))["request"]["id"]
    res2 = ok(act(api, pr(9), "record_rejected", MK_BD, lostReason="price", note="Too expensive"))
    assert opportunity(api, "OPP-0014", NOHA)["stage"] == "negotiation", "unchanged"
    assert f"stays Negotiation: {other} is still open" in res2["message"]


def test_forward_only_stage_sync(api, session):
    """JS: forward-only stage sync never moves an opportunity backward or reopens it"""
    before = len(opportunity(api, "OPP-0010", NOHA)["history"])
    ok(act(api, pr(13), "provide_bd_info", AHMED, note="Guidelines attached"))
    opp = opportunity(api, "OPP-0010", NOHA)
    assert (opp["stage"], len(opp["history"])) == ("proposal_requested", before)
    # A won opportunity is not reopened by sharing another proposal for it. (The frontend test adds a
    # fake request; here an existing Ready request is linked to the Won opportunity directly.)
    row = session.get(ProposalRequest, pr(11))
    row.opportunity_id = "OPP-0016"
    session.commit()
    ok(act(api, pr(11), "share_with_client", MK_BD, **SHARE))
    assert opportunity(api, "OPP-0016", NOHA)["stage"] == "won"


# ---------- metrics stay consistent ----------

def test_submitting_a_draft_adds_one_open_request(api):
    """JS: dashboard metrics follow the shared record: submitting a draft adds one open request"""
    def open_count():
        return api.get("/api/proposal-requests", params={"open": "true", "pageSize": 100}, headers=NOHA).json()["total"]
    before = open_count()
    ok(act(api, pr(19), "submit", AHMED))
    assert open_count() == before + 1


def test_turnaround_excludes_time_awaiting_bd_information(api):
    """JS: turnaround still excludes time awaiting BD information after a live info loop"""
    rid = pr(16)  # Submitted, Grasshoppers
    t0 = parse_ts(next(e for e in detail(api, rid, NOHA)["history"] if e["status"] == "submitted")["changedAt"])

    def run(action, viewer, hours, **inputs):
        api.app.dependency_overrides[get_now] = lambda: t0 + timedelta(hours=hours)
        try:
            ok(act(api, rid, action, viewer, **inputs))
        finally:
            api.app.dependency_overrides.pop(get_now)

    run("start_work", MK_AM, 24)
    run("request_bd_info", MK_AM, 48, note="Headcount?")
    run("provide_bd_info", MK_BD, 96, note="60")  # waited 2 days on BD
    run("start_work", MK_AM, 120)
    ok(upload(api, rid, MK_AM))
    run("mark_ready", MK_AM, 144, amPrice=90000)  # +6 days gross
    # The server records every step at the clock's time; amTurnaroundDays (a dashboard metric that
    # stays in the frontend until Phase 4) applied to the stored history gives 4 days.
    h = detail(api, rid, NOHA)["history"]
    t = [parse_ts(e["changedAt"]) for e in h]
    start = next(i for i, e in enumerate(h) if e["status"] == "submitted")
    end = next(i for i, e in enumerate(h) if i > start and e["status"] == "ready_for_bd")
    gross = t[end] - t[start]
    waiting = sum((t[i + 1] - t[i] for i in range(start, end) if h[i]["status"] == "awaiting_bd_info"), timedelta())
    assert (gross - waiting) / timedelta(days=1) == 4, "6 days gross minus 2 days awaiting BD"


def test_denial_reason_names_bd_owner_or_head_for_cancel(api):
    """JS: denial reasons name who can act, e.g. BD owner or Commercial Head for cancel"""
    r = act(api, pr(7), "cancel", ABDELRAHMAN, note="x")
    assert error(r)["message"] == "Only the BD owner, Sherine El Tabakh, or the Commercial Head can do this."


# ---------- lost reasons ----------

def test_mark_lost_needs_a_listed_reason_note_only_for_other(api, session):
    """JS: Mark lost needs a reason from the fixed list; a note is required only for "Other\""""
    labels = {a["action"]: a["label"] for a in detail(api, pr(7), SHERINE)["allowedActions"]}
    assert (labels["record_rejected"], labels["record_accepted"]) == ("Mark lost", "Mark confirmed")

    assert "lostReason" in error(act(api, pr(7), "record_rejected", SHERINE, lostReason="cheaper"))["fields"], "unknown reason"
    assert "note" in error(act(api, pr(7), "record_rejected", SHERINE, lostReason="other", note="  "))["fields"]
    assert stored(session, pr(7))[0] == "shared_with_client", "failed attempts change nothing"

    entry = ok(act(api, pr(7), "record_rejected", SHERINE, lostReason="competitor"))["request"]["history"][-1]
    assert (entry["status"], entry["lostReason"], entry["note"]) == ("rejected", "competitor", None)
    opp = opportunity(api, "OPP-0013", NOHA)
    assert (opp["stage"], opp["lostReason"]) == ("lost", "competitor"), "stored as the opportunity's lost reason"


def test_other_with_a_description_is_stored_with_its_note(api):
    """JS: "Other" with a description is stored with its note"""
    entry = ok(act(api, pr(7), "record_rejected", SHERINE, lostReason="other", note="School changed principal"))["request"]["history"][-1]
    assert (entry["lostReason"], entry["note"]) == ("other", "School changed principal")


# ---------- Phase 3A ----------

def test_sharing_records_the_channel(api):
    """JS: sharing records the channel from the fixed list (WhatsApp, Email, In person, Other)"""
    r = act(api, pr(10), "share_with_client", ABDELRAHMAN, confirmShared=True)
    assert r.status_code == 422 and "channel" in error(r)["fields"]
    assert "channel" in error(act(api, pr(10), "share_with_client", ABDELRAHMAN, confirmShared=True, channel="fax"))["fields"]
    out = ok(act(api, pr(10), "share_with_client", ABDELRAHMAN, confirmShared=True, channel="email"))
    assert out["request"]["history"][-1]["channel"] == "email"
    last = opportunity(api, "OPP-0012", NOHA)["history"][-1]
    assert (last["fromStage"], last["toStage"], last["reasonCode"]) == ("proposal_requested", "negotiation", "proposal_shared")


def test_mark_won_with_other_open_requests_warns(api):
    """JS: Mark won with other open requests: opportunity Won, the others untouched, and a warning lists them"""
    other = ok(create(api, MK_BD, submit=True, clientId=cl(12), brand="teamup", service="family_day",
                      opportunityId="OPP-0014", eventDate=future(50), requiredBy=future(9), participants=150,
                      requirementsSummary="Second option"))["request"]["id"]
    res = ok(act(api, pr(9), "record_accepted", MK_BD, eventDate=future(30)))
    assert opportunity(api, "OPP-0014", NOHA)["stage"] == "won"
    assert detail(api, other, NOHA)["status"] == "submitted", "nothing is cancelled automatically"
    assert [w["code"] for w in res["warnings"]] == ["other_open_requests"]
    assert res["warnings"][0]["requests"] == [{"id": other, "status": "submitted", "bdOwner": "u-mariam-elkhayat"}]
    assert ok(act(api, pr(7), "record_accepted", SHERINE, eventDate=future(30)))["warnings"] == [], "no warning when nothing else is open"


def test_mark_won_reopening_a_lost_opportunity_is_recorded(api, session):
    """JS: opportunity reason codes: a Lost opportunity reopened by Mark won is recorded as reopened_after_acceptance"""
    row = session.get(ProposalRequest, pr(7))  # shared with client; linked to the Lost OPP-0018 for this test
    row.opportunity_id = "OPP-0018"
    session.commit()
    ok(act(api, pr(7), "record_accepted", SHERINE, eventDate=future(30)))
    opp = opportunity(api, "OPP-0018", NOHA)
    assert (opp["stage"], opp["lostReason"]) == ("won", None)
    last = opp["history"][-1]
    assert (last["fromStage"], last["toStage"], last["reasonCode"]) == ("lost", "won", "reopened_after_acceptance")


def test_mark_lost_on_a_won_opportunity_keeps_it_won(api, session):
    """JS: Mark lost when the opportunity is already Won: it stays Won, the reason stays on the request"""
    row = session.get(ProposalRequest, pr(7))  # shared with client; linked to the Won OPP-0016 for this test
    row.opportunity_id = "OPP-0016"
    session.commit()
    before = len(opportunity(api, "OPP-0016", NOHA)["history"])
    out = ok(act(api, pr(7), "record_rejected", SHERINE, lostReason="timing"))
    opp = opportunity(api, "OPP-0016", NOHA)
    assert (opp["stage"], opp["lostReason"], len(opp["history"])) == ("won", None, before), "untouched"
    assert "Opportunity OPP-0016 stays Won." in out["message"]
    assert out["request"]["history"][-1]["lostReason"] == "timing"


def test_failures_map_to_http_statuses(api):
    """JS: failures carry a code the API maps to an HTTP status"""
    assert act(api, pr(19), "submit", NOHA).status_code == 404, "someone else's draft"
    assert act(api, pr(17), "teleport", NOHA).status_code == 422
    assert act(api, pr(17), "share_with_client", ABDELRAHMAN).status_code == 409
    assert act(api, pr(17), "start_work", NOHA).status_code == 403
    assert act(api, pr(14), "mark_ready", MK_AM).status_code == 409, "no proposal file yet"
    assert act(api, pr(15), "mark_ready", MD_AM).status_code == 422, "file uploaded, price missing"
