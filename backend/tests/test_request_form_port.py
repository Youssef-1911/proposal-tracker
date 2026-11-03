"""
1:1 port of frontend/tests/requestForm.test.mjs (see tests/PORTING.md).
Create / edit / submit through POST and PATCH /api/proposal-requests over the seeded demo
database; the frontend test name is in each docstring.
"""

from datetime import date

import pytest
from sqlalchemy import func, select

from app.config_domain import BRAND_AM_ROUTING
from app.domain.request_form import validate_request_fields
from app.models import ProposalRequest

from .conftest import AHMED, MD_AM, MK_AM, MK_BD, NOHA, SHERINE, as_user, pr
from .write_helpers import act, cl, create, detail, edit, error, future, future_month, ok, opportunity, today

ABDELRAHMAN = as_user("u-abdelrahman", "business_development")


def ahmed_team_up(**over):
    """A complete, valid Team Up request for Ahmed's client Harbor Line Logistics (CL-0008)."""
    return {"clientId": cl(8), "brand": "teamup", "service": "team_building", "opportunityId": "",
            "eventDatePrecision": "day", "eventDate": future(40), "requiredBy": future(10), "participants": "120",
            "requirementsSummary": "Half-day team building", "specificRequirements": "", **over}


def count(session) -> int:
    session.expire_all()
    return session.scalar(select(func.count()).select_from(ProposalRequest))


def ids(api, headers, scope):
    return {i["id"] for i in api.get("/api/proposal-requests", params={"scope": scope, "pageSize": 100},
                                     headers=headers).json()["items"]}


# 1. Required fields ---------------------------------------------------------------

def test_1_draft_needs_client_brand_service_submission_needs_every_field(api, session):
    """JS: 1. a draft needs client, brand and service; a submission needs every request field"""
    before = count(session)
    draft = create(api, AHMED)
    assert draft.status_code == 422
    assert sorted(error(draft)["fields"]) == ["brand", "clientId", "service"]

    submit = create(api, AHMED, submit=True, clientId=cl(8), brand="teamup", service="team_building")
    assert submit.status_code == 422
    assert sorted(error(submit)["fields"]) == ["eventDate", "participants", "requiredBy", "requirementsSummary"]
    assert count(session) == before, "nothing saved after validation errors"


# 2. Invalid dates and counts --------------------------------------------------------

def test_2_invalid_dates_deadlines_and_counts_are_rejected(api):
    """JS: 2. invalid event dates, proposal deadlines and participant counts are rejected"""
    t = today().isoformat()

    def check(**over):
        return validate_request_fields(ahmed_team_up(**over), mode="submit", today=t)[0]

    assert check(eventDate=future(-1))["eventDate"], "past event date"
    assert check(eventDate="2027-02-30")["eventDate"], "impossible date"
    assert check(eventDatePrecision="month", eventDate="2027-13")["eventDate"], "impossible month"
    assert check(eventDatePrecision="month", eventDate=future_month(-1))["eventDate"], "past month"
    assert check(requiredBy=future(-1))["requiredBy"], "past deadline"
    assert check(requiredBy="tomorrow")["requiredBy"], "not a date"
    assert "before the event date" in check(eventDate=future(10), requiredBy=future(10))["requiredBy"]
    assert "before the event date" in check(eventDate=future(10), requiredBy=future(12))["requiredBy"]
    month = future_month(2)
    assert "before the first day of the event month" in check(
        eventDatePrecision="month", eventDate=month, requiredBy=f"{month}-01")["requiredBy"]
    assert check(eventDatePrecision="month", eventDate=month, requiredBy=future(5)) == {}, "valid month-only request"
    for participants in ("0", "-3", "2.5", "abc"):
        assert check(participants=participants)["participants"], f"participants {participants}"
    assert check() == {}, "the baseline input is valid"
    # The same rules through the API.
    r = create(api, AHMED, submit=True, **ahmed_team_up(eventDate="2027-02-30", participants="2.5"))
    assert r.status_code == 422 and {"eventDate", "participants"} <= set(error(r)["fields"])


# 3. Draft creation --------------------------------------------------------------------

def test_3_saving_a_draft_creates_a_private_draft_not_in_any_am_queue(api):
    """JS: 3. saving a draft creates a private Draft that is not in any AM queue"""
    r = ok(create(api, AHMED, clientId=cl(8), brand="teamup", service="team_building"))["request"]
    assert (r["status"], r["submittedAt"], r["submittedBy"], len(r["history"])) == ("draft", None, None, 1)
    assert r["id"] not in ids(api, MD_AM, "my_brand")
    assert r["id"] not in ids(api, NOHA, "company")
    assert r["id"] in ids(api, AHMED, "mine")


# 4. Submission --------------------------------------------------------------------------

def test_4_submitting_creates_and_moves_to_submitted_through_the_workflow(api):
    """JS: 4. submitting creates the request and moves it to Submitted through the workflow"""
    r = ok(create(api, AHMED, submit=True, **ahmed_team_up(opportunityId="OPP-0004")))["request"]
    assert (r["status"], r["submittedBy"]) == ("submitted", "u-ahmed")
    assert r["submittedAt"]
    assert r["participants"] == 120, "participants stored as a number"
    assert r["id"] in ids(api, MD_AM, "my_brand"), "now in the AM queue"
    assert opportunity(api, "OPP-0004", NOHA)["stage"] == "proposal_requested", "linked opportunity synced"


# 5 & 6. Routing --------------------------------------------------------------------------

def test_5_grasshoppers_routes_to_mariam_el_khayat(api):
    """JS: 5. Grasshoppers requests route to Mariam El Khayat"""
    r = ok(create(api, MK_BD, submit=True, clientId=cl(4), brand="grasshoppers", service="sleepover",
                  eventDate=future(50), requiredBy=future(9), participants=40, requirementsSummary="Year 2 sleepover"))
    assert r["request"]["assignedAM"] == "u-mariam-elkhayat" == BRAND_AM_ROUTING["grasshoppers"]


def test_6_team_up_routes_to_mariam_dimitri(api):
    """JS: 6. Team Up requests route to Mariam Dimitri"""
    r = ok(create(api, AHMED, submit=True, **ahmed_team_up()))
    assert r["request"]["assignedAM"] == "u-mariam-dimitri" == BRAND_AM_ROUTING["teamup"]


# 7 & 8. On behalf + separation ------------------------------------------------------------

def test_7_8_noha_submits_on_behalf_people_stay_separate(api):
    """JS: 7/8. Noha submits on behalf of the client owner; createdBy, bdOwner, assignedAM, submittedBy stay separate"""
    data = dict(clientId=cl(7), brand="teamup", service="corporate_event", eventDate=future(60),
                requiredBy=future(12), participants=250, requirementsSummary="Annual dinner")
    # Difference: the frontend ignores a bdOwner in the input; the API refuses it (server-generated).
    sneaky = create(api, NOHA, submit=True, **data, bdOwner="u-sherine")
    assert sneaky.status_code == 422 and "bdOwner" in error(sneaky)["fields"]

    r = ok(create(api, NOHA, submit=True, **data))["request"]
    assert r["createdBy"] == "u-noha"
    assert r["bdOwner"] == "u-abdelrahman", "always the client relationship owner"
    assert r["assignedAM"] == "u-mariam-dimitri"
    assert r["submittedBy"] == "u-noha", "Noha submitted it, not the BD owner"
    created, submitted = r["history"]
    assert (created["changedBy"], created["role"], created["onBehalfOf"]) == ("u-noha", "commercial_head", "u-abdelrahman")
    assert (submitted["changedBy"], submitted["role"], submitted["onBehalfOf"]) == ("u-noha", "commercial_head", "u-abdelrahman")


def test_8_mariam_own_request_one_person_bd_role_routed_to_her(api):
    """JS: 8. Mariam El Khayat's own Grasshoppers request: one person, BD role recorded, routed to her as AM"""
    r = ok(create(api, MK_BD, submit=True, clientId=cl(1), brand="grasshoppers", service="explorers_league",
                  eventDate=future(30), requiredBy=future(7), participants=60,
                  requirementsSummary="Explorers League term"))["request"]
    assert (r["createdBy"], r["bdOwner"], r["submittedBy"], r["assignedAM"]) == ("u-mariam-elkhayat",) * 4
    assert all(e["role"] == "business_development" for e in r["history"])
    assert r["history"][1]["onBehalfOf"] is None


# 9. Draft privacy ----------------------------------------------------------------------------

def test_9_drafts_private_to_creator(api):
    """JS: 9. drafts are private to their creator; Noha's draft for Abdelrahman is hidden from him until submitted"""
    r = ok(create(api, NOHA, clientId=cl(7), brand="teamup", service="family_day"))["request"]
    for who in (ABDELRAHMAN, AHMED, MD_AM, MK_BD):
        assert api.get(f"/api/proposal-requests/{r['id']}", headers=who).status_code == 404, who
    assert detail(api, r["id"], NOHA)["canEditDraft"] is True
    assert r["id"] not in ids(api, ABDELRAHMAN, "mine")
    assert edit(api, r["id"], ABDELRAHMAN, version=1, clientId=cl(7)).status_code == 404


# 10. History and transitions ----------------------------------------------------------------

def test_10_history_draft_then_submitted_edit_adds_no_history_no_resubmit(api):
    """JS: 10. history: Draft then Submitted; editing a draft adds no history; a submitted request cannot be resubmitted"""
    draft = ok(create(api, AHMED, clientId=cl(8), brand="teamup", service="team_building"))["request"]
    edited = ok(edit(api, draft["id"], AHMED, **ahmed_team_up(requirementsSummary="Edited brief")))["request"]
    assert len(edited["history"]) == 1, "edit does not add a status change"
    assert edited["requirementsSummary"] == "Edited brief"

    submitted = ok(edit(api, draft["id"], AHMED, submit=True, **ahmed_team_up()))["request"]
    assert [e["status"] for e in submitted["history"]] == ["draft", "submitted"]

    again = act(api, draft["id"], "submit", AHMED)
    assert again.status_code == 409 and "not possible while the request is Submitted" in error(again)["message"]
    late = edit(api, draft["id"], AHMED, **ahmed_team_up())
    assert (late.status_code, error(late)["message"]) == (409, "Only drafts can be edited."), "cannot edit after submission"


# 11. Duplicate prevention ----------------------------------------------------------------------

def test_11_saving_and_submitting_the_same_draft_never_creates_a_second_record(api, session):
    """JS: 11. saving and submitting the same draft never creates a second record"""
    before = count(session)
    first = ok(create(api, AHMED, clientId=cl(8), brand="teamup", service="team_building"))["request"]
    ok(edit(api, first["id"], AHMED, clientId=cl(8), brand="teamup", service="team_building"))
    ok(edit(api, first["id"], AHMED, submit=True, **ahmed_team_up()))
    assert count(session) == before + 1
    assert detail(api, first["id"], AHMED)["status"] == "submitted"


def test_11b_failed_submit_saves_nothing_draft_keeps_last_saved_values(api, session):
    """JS: 11b. a failed submit saves nothing, and an existing draft keeps its last saved values"""
    before = count(session)
    assert create(api, AHMED, submit=True, **ahmed_team_up(participants="0")).status_code == 422
    assert count(session) == before, "no half-created draft"

    draft = ok(create(api, AHMED, **ahmed_team_up(requirementsSummary="Saved brief")))["request"]
    failed = edit(api, draft["id"], AHMED, submit=True,
                  **ahmed_team_up(requirementsSummary="Unsaved edit", requiredBy=future(-3)))
    assert failed.status_code == 422
    after = detail(api, draft["id"], AHMED)
    assert (after["requirementsSummary"], after["status"], after["rowVersion"]) == ("Saved brief", "draft", draft["rowVersion"])


def test_11c_possible_duplicates_among_open_requests_only(api):
    """JS: 11c. possible duplicates (same client, brand, service and event date) are found among open requests only"""
    existing = ok(create(api, AHMED, submit=True, **ahmed_team_up()))["request"]
    assert existing["id"] not in str(ok(create(api, AHMED, **ahmed_team_up(eventDate=future(41))))["warnings"])
    # A warning only: a second request with the same details is still allowed.
    second = ok(create(api, AHMED, submit=True, **ahmed_team_up()))
    dupes = [w for w in second["warnings"] if w["code"] == "possible_duplicate"]
    assert [r["id"] for r in dupes[0]["requests"]] == [existing["id"]], "excludes itself"
    assert dupes[0]["message"].startswith("Possible duplicate.")


# Access, client list, services, opportunities ------------------------------------------------

def test_only_bd_and_head_can_create_mariam_in_am_mode_is_told_to_switch(api):
    """JS: only BD (in BD role) and the Commercial Head can open the form; Mariam in AM mode is told to switch"""
    assert api.get("/api/me", headers=AHMED).json()["createRequests"]["allowed"] is True
    assert api.get("/api/me", headers=NOHA).json()["createRequests"]["allowed"] is True
    mk = create(api, MK_AM, **ahmed_team_up())
    assert mk.status_code == 403 and "Switch your active role to Business Development" in error(mk)["message"]
    assert create(api, MD_AM, **ahmed_team_up()).status_code == 403


def test_bd_uses_only_own_clients_noha_all(api):
    """JS: a BD sees and may use only their own clients; Noha sees all"""
    res = create(api, SHERINE, **ahmed_team_up())  # Ahmed's client
    assert res.status_code == 403
    assert error(res)["fields"] == {"clientId": "Not one of your clients."}
    assert error(res)["message"] == "You can only create requests for clients you own."
    ok(create(api, NOHA, **ahmed_team_up()))


def test_services_belong_to_brand_and_opportunity_must_be_open_and_match(api):
    """JS: services must belong to the brand; a linked opportunity must be open and match client and brand"""
    assert "service" in error(create(api, AHMED, **ahmed_team_up(service="summer_camp")))["fields"]
    assert "opportunityId" in error(create(api, AHMED, **ahmed_team_up(opportunityId="OPP-0002")))["fields"]
    assert "opportunityId" in error(create(api, AHMED, **ahmed_team_up(opportunityId="OPP-0006")))["fields"]
    won = create(api, AHMED, clientId=cl(5), brand="grasshoppers", service="summer_camp", opportunityId="OPP-0016")
    assert "opportunityId" in error(won)["fields"], "closed (Won) opportunity"
    ok(create(api, AHMED, **ahmed_team_up(opportunityId="OPP-0015")))


def test_drafts_edited_in_place_only_by_creator_in_creating_role(api):
    """JS: drafts are edited in place only by their creator in a creating role"""
    mine = ok(create(api, MK_BD, clientId=cl(1), brand="grasshoppers", service="school_trip"))["request"]
    assert mine["canEditDraft"] is True
    assert detail(api, mine["id"], MK_AM)["canEditDraft"] is False, "not while acting as AM"
    as_am = edit(api, mine["id"], MK_AM, clientId=cl(4))
    assert (as_am.status_code, error(as_am)["message"]) == (
        403, "Only the person who created this draft, Mariam El Khayat, can do this.")
    assert edit(api, mine["id"], NOHA, version=1, clientId=cl(4)).status_code == 404, "not even the Commercial Head"
    edited = ok(edit(api, mine["id"], MK_BD, clientId=cl(4), service="sleepover"))["request"]
    assert (edited["id"], edited["clientId"], edited["service"]) == (mine["id"], cl(4), "sleepover")


def test_month_only_event_dates_are_kept_as_month_and_year(api, session):
    """JS: month-only event dates are kept as month + year and never turned into an exact day"""
    month = future_month(3)
    r = ok(create(api, AHMED, submit=True, **ahmed_team_up(eventDatePrecision="month", eventDate=month)))["request"]
    assert (r["eventDate"], r["eventDatePrecision"]) == (month, "month")
    session.expire_all()
    assert session.get(ProposalRequest, r["id"]).event_date == date.fromisoformat(f"{month}-01"), "stored as the 1st"


# 12. Existing behaviour ---------------------------------------------------------------------------

def test_12_seeded_drafts_still_submit_and_totals_reconcile(api):
    """JS: 12. seeded drafts still submit from the detail page and dashboards still reconcile"""
    ok(act(api, pr(19), "submit", AHMED))

    def open_total(headers, scope):
        return api.get("/api/proposal-requests", params={"scope": scope, "open": "true", "pageSize": 100},
                       headers=headers).json()["total"]
    assert open_total(NOHA, "company") == open_total(MK_AM, "my_brand") + open_total(MD_AM, "my_brand")
    items = api.get("/api/proposal-requests", params={"pageSize": 100}, headers=NOHA).json()["items"]
    assert all(i["eventDatePrecision"] in ("day", "month") for i in items)
    direct = ok(create(api, MK_BD, clientId=cl(12), brand="teamup", service="family_day"))["request"]
    assert direct["assignedAM"] == "u-mariam-dimitri", "routing applies to every create"


def test_submitting_an_empty_form_reports_every_required_field(api):
    """JS: submitting an empty form reports every required field at once"""
    r = create(api, AHMED, submit=True)
    assert r.status_code == 422
    assert sorted(error(r)["fields"]) == [
        "brand", "clientId", "eventDate", "participants", "requiredBy", "requirementsSummary", "service"]


def test_permission_errors_are_not_hidden_by_field_errors(api):
    """JS: permission errors are not hidden by field errors when submitting"""
    r = create(api, MD_AM, submit=True)
    assert r.status_code == 403
    assert "Only Business Development or the Commercial Head" in error(r)["message"]
