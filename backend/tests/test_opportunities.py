"""
Opportunities: read endpoints, and the stage-change service that Phase 3 will use.
Rewritten for the new schema; every behaviour the old tests covered is re-asserted:
  unique server IDs + history on create · required fields · unknown client · status change
  recorded with old/new + actor · no-op change records nothing · Lost needs a reason ·
  list filters · config endpoint (in test_config_parity) · plus append-only history,
  optimistic concurrency and the reopen rule. The old "open needs a next action" rule is
  intentionally dropped (approved decision 2) and asserted as dropped.
"""

import re
from datetime import date

import pytest
from sqlalchemy import select

from app.errors import ApiError
from app.identity import Actor
from app.models import Opportunity, OpportunityHistory
from app.services.opportunities import create_opportunity, set_opportunity_stage

from .conftest import AHMED, NOHA, pr

AS_BD = Actor("u-ahmed", "business_development")
AS_HEAD = Actor("u-noha", "commercial_head")


def items(response):
    assert response.status_code == 200, response.text
    return response.json()["items"]


# ---------- read endpoints ----------

def test_list_opportunities_ids_and_shape(api):
    body = api.get("/api/opportunities", headers=NOHA).json()
    assert body["total"] == 18
    assert [o["id"] for o in body["items"]] == [f"OPP-{n:04d}" for n in range(1, 19)]
    first = body["items"][0]
    assert first["clientId"] == "CL-0010" and first["brand"] == "teamup" and first["service"] == "team_building"
    assert first["owner"] == "u-abdelrahman" and first["stage"] == "new_lead"
    assert first["estimatedValue"] == 180000 and isinstance(first["estimatedValue"], int), "whole EGP"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", first["eventDate"]) and first["eventDatePrecision"] == "day"


def test_month_only_event_dates_are_returned_as_year_month(api):
    opp = api.get("/api/opportunities/OPP-0003", headers=NOHA).json()
    assert opp["eventDatePrecision"] == "month"
    assert re.fullmatch(r"\d{4}-\d{2}", opp["eventDate"]), "never an invented day"


@pytest.mark.parametrize("params,check", [
    ({"client": "CL-0008"}, lambda o: o["clientId"] == "CL-0008"),
    ({"brand": "grasshoppers"}, lambda o: o["brand"] == "grasshoppers"),
    ({"owner": "u-sherine"}, lambda o: o["owner"] == "u-sherine"),
    ({"stage": "won,lost"}, lambda o: o["stage"] in ("won", "lost")),
    ({"open": "true"}, lambda o: o["stage"] not in ("won", "lost")),
])
def test_list_filters(api, params, check):
    rows = items(api.get("/api/opportunities", params=params, headers=NOHA))
    assert rows and all(check(o) for o in rows)


def test_filter_counts(api):
    assert len(items(api.get("/api/opportunities", params={"open": "true"}, headers=NOHA))) == 15
    assert len(items(api.get("/api/opportunities", params={"stage": "won,lost"}, headers=NOHA))) == 3
    assert len(items(api.get("/api/opportunities", params={"brand": "teamup", "owner": "u-ahmed"}, headers=NOHA))) == 3


@pytest.mark.parametrize("params,field", [({"stage": "cancelled"}, "stage"), ({"brand": "acme"}, "brand")])
def test_invalid_filters_are_422(api, params, field):
    r = api.get("/api/opportunities", params=params, headers=NOHA)
    assert r.status_code == 422 and field in r.json()["error"]["fields"]


def test_detail_includes_history_and_lost_reason(api):
    lost = api.get("/api/opportunities/OPP-0018", headers=AHMED).json()
    assert lost["stage"] == "lost" and lost["lostReason"] == "competitor"
    assert lost["history"] == [{
        "id": lost["history"][0]["id"], "fromStage": None, "toStage": "lost", "changedBy": "u-abdelrahman",
        "role": "business_development", "changedAt": lost["history"][0]["changedAt"],
        "note": "Demo seed data", "reasonCode": "seed", "sourceRequestId": None, "lostReason": "competitor",
        "details": None, "imported": False,
    }]
    assert api.get("/api/opportunities/OPP-9999", headers=AHMED).status_code == 404


def test_no_delete_routes_anywhere(api):
    # The OpenAPI schema lists every operation, including those of included routers
    # (app.routes does not flatten included routers in this FastAPI version).
    operations = {(path, method.upper()) for path, ops in api.app.openapi()["paths"].items() for method in ops}
    assert len(operations) > 10, "the schema really lists the API"
    assert not any(method in ("DELETE", "PUT") for _, method in operations), "no DELETE or PUT routes"
    writes = sorted(op for op in operations if op[1] not in ("GET", "HEAD"))
    assert writes == [
        ("/api/clients", "POST"),
        ("/api/clients/{client_id}", "PATCH"),
        ("/api/clients/{client_id}/archive", "POST"),
        ("/api/clients/{client_id}/contacts", "POST"),
        ("/api/clients/{client_id}/contacts/{contact_id}", "PATCH"),
        ("/api/clients/{client_id}/contacts/{contact_id}/archive", "POST"),
        ("/api/clients/{client_id}/transfer", "POST"),
        ("/api/events/{event_id}/cancel", "POST"),
        ("/api/events/{event_id}/comments", "POST"),
        ("/api/events/{event_id}/confirm", "POST"),
        ("/api/events/{event_id}/date", "PATCH"),
        ("/api/events/{event_id}/facilitators", "POST"),
        ("/api/events/{event_id}/facilitators-needed", "PATCH"),
        ("/api/events/{event_id}/facilitators/{facilitator_id}/rating", "POST"),
        ("/api/events/{event_id}/facilitators/{facilitator_id}/remove", "POST"),
        ("/api/events/{event_id}/postpone", "POST"),
        ("/api/events/{event_id}/read", "POST"),
        ("/api/facilitators", "POST"),
        ("/api/facilitators/{facilitator_id}", "PATCH"),
        ("/api/facilitators/{facilitator_id}/notes", "POST"),
        ("/api/notifications/read-all", "POST"),
        ("/api/notifications/{notification_id}/read", "POST"),
        ("/api/occasions/periods/{period_id}/remove", "POST"),
        ("/api/occasions/{occasion_id}/periods", "POST"),
        ("/api/opportunities", "POST"),
        ("/api/opportunities/{opportunity_id}", "PATCH"),
        ("/api/opportunities/{opportunity_id}/stage", "POST"),
        ("/api/proposal-requests", "POST"),
        ("/api/proposal-requests/past", "POST"),
        ("/api/proposal-requests/{request_id}", "PATCH"),
        ("/api/proposal-requests/{request_id}/actions", "POST"),
        ("/api/proposal-requests/{request_id}/comments", "POST"),
        ("/api/proposal-requests/{request_id}/correct-status", "POST"),
        ("/api/proposal-requests/{request_id}/details", "PATCH"),
        ("/api/proposal-requests/{request_id}/details/seen", "POST"),
        ("/api/proposal-requests/{request_id}/files", "POST"),
        ("/api/proposal-requests/{request_id}/past-file", "POST"),
        ("/api/proposal-requests/{request_id}/read", "POST"),
        ("/api/proposal-requests/{request_id}/waiting-on", "POST"),
        ("/api/proposal-requests/{request_id}/waiting-on/clear", "POST"),
        ("/api/radar/dismiss", "POST"),
        ("/api/reminders", "POST"),
        ("/api/routing/{brand}", "PATCH"),
        ("/api/settings/lists/{list_id}", "POST"),
        ("/api/staffing/ratios/{brand}/{service}", "POST"),
        ("/api/todos", "POST"),
        ("/api/todos/{todo_id}", "PATCH"),
        ("/api/todos/{todo_id}/delete", "POST"),
        ("/api/todos/{todo_id}/done", "POST"),
        ("/api/users", "POST"),
        ("/api/users/{user_id}", "PATCH"),
        ("/api/users/{user_id}/deactivate", "POST"),
        ("/api/users/{user_id}/reactivate", "POST"),
    ], "the only write routes"


# ---------- create service ----------

def test_create_assigns_next_server_id_and_writes_history_together(seeded, session):
    opp = create_opportunity(session, actor=AS_BD, client_id="CL-0008", brand="teamup", service="family_day",
                             owner_id="u-ahmed")
    session.commit()
    assert opp.id == "OPP-0019"
    entries = session.scalars(select(OpportunityHistory).where(OpportunityHistory.opportunity_id == opp.id)).all()
    assert [(e.from_stage, e.to_stage, e.changed_by_id, e.role, e.reason_code) for e in entries] == [
        (None, "new_lead", "u-ahmed", "business_development", "created")]
    second = create_opportunity(session, actor=AS_BD, client_id="CL-0008", brand="teamup", service="family_day",
                                owner_id="u-ahmed")
    assert second.id == "OPP-0020", "IDs never repeat"


def test_open_opportunity_without_next_action_is_allowed(seeded, session):
    """Decision 2: the old 'open opportunities must have a next action' rule is dropped."""
    opp = create_opportunity(session, actor=AS_BD, client_id="CL-0008", brand="teamup", service="team_building",
                             owner_id="u-ahmed", stage="contacted", next_action=None)
    assert opp.next_action is None and opp.stage == "contacted"


def test_create_validation(seeded, session):
    with pytest.raises(ApiError) as e:
        create_opportunity(session, actor=AS_BD, client_id="CL-9999", brand="teamup", service="family_day", owner_id="u-ahmed")
    assert e.value.status == 404
    with pytest.raises(ApiError) as e:
        create_opportunity(session, actor=AS_BD, client_id="CL-0008", brand="teamup", service="summer_camp",
                           owner_id="u-mariam-dimitri", stage="lost", estimated_value=-5, participants=0)
    assert e.value.status == 422
    assert set(e.value.fields) == {"service", "owner", "lostReason", "estimatedValue", "participants"}


def test_month_precision_is_stored_as_first_of_month(seeded, session):
    opp = create_opportunity(session, actor=AS_BD, client_id="CL-0008", brand="teamup", service="family_day",
                             owner_id="u-ahmed", event_date=date(2027, 3, 17), event_date_precision="month")
    assert opp.event_date == date(2027, 3, 1)


# ---------- stage service ----------

def get_opp(session, opp_id):
    session.expire_all()
    return session.get(Opportunity, opp_id)


def history(session, opp_id):
    return session.scalars(select(OpportunityHistory).where(OpportunityHistory.opportunity_id == opp_id)
                           .order_by(OpportunityHistory.id)).all()


def test_stage_change_records_old_new_actor_and_bumps_row_version(seeded, session):
    opp = get_opp(session, "OPP-0002")
    version = opp.row_version
    entry = set_opportunity_stage(session, opp, "requirements_gathered", actor=AS_BD, note="Met the trips officer")
    session.commit()
    opp = get_opp(session, "OPP-0002")
    assert opp.stage == "requirements_gathered" and opp.row_version == version + 1
    assert (entry.from_stage, entry.to_stage, entry.changed_by_id, entry.role, entry.note) == (
        "contacted", "requirements_gathered", "u-ahmed", "business_development", "Met the trips officer")
    assert len(history(session, "OPP-0002")) == 2


def test_same_stage_is_a_no_op_and_records_nothing(seeded, session):
    opp = get_opp(session, "OPP-0002")
    assert set_opportunity_stage(session, opp, "contacted", actor=AS_BD) is None
    session.commit()
    assert len(history(session, "OPP-0002")) == 1
    assert get_opp(session, "OPP-0002").row_version == 1


def test_lost_without_a_reason_is_rejected_and_nothing_changes(seeded, session):
    opp = get_opp(session, "OPP-0013")
    for reason in (None, "", "   "):
        with pytest.raises(ApiError) as e:
            set_opportunity_stage(session, opp, "lost", actor=AS_BD, note=reason)
        assert e.value.status == 422
    session.rollback()
    assert get_opp(session, "OPP-0013").stage == "negotiation"
    assert len(history(session, "OPP-0013")) == 1


def test_lost_with_reason_records_it_on_the_opportunity_and_in_history(seeded, session):
    opp = get_opp(session, "OPP-0013")
    set_opportunity_stage(session, opp, "lost", actor=AS_BD, note="Budget cut", reason_code="proposal_rejected",
                          source_request_id=pr(7))  # the seeded request on OPP-0013
    session.commit()
    opp = get_opp(session, "OPP-0013")
    last = history(session, "OPP-0013")[-1]
    assert opp.lost_reason == "Budget cut"
    assert (last.to_stage, last.note, last.reason_code, last.source_request_id, last.lost_reason) == (
        "lost", "Budget cut", "proposal_rejected", pr(7), "Budget cut")


def test_reopening_a_lost_opportunity_is_recorded(seeded, session):
    opp = get_opp(session, "OPP-0018")  # Lost
    set_opportunity_stage(session, opp, "won", actor=AS_HEAD, reason_code="reopened_after_acceptance",
                          source_request_id=pr(3), note="Client accepted a later proposal")  # seeded request on OPP-0018
    session.commit()
    opp = get_opp(session, "OPP-0018")
    last = history(session, "OPP-0018")[-1]
    assert opp.stage == "won" and opp.lost_reason is None
    assert (last.from_stage, last.to_stage, last.reason_code) == ("lost", "won", "reopened_after_acceptance")
    assert history(session, "OPP-0018")[0].lost_reason == "competitor", "the old reason stays in the opportunity's history"
    assert last.lost_reason is None


def test_leaving_a_closed_stage_defaults_to_a_reopened_reason_code(seeded, session):
    opp = get_opp(session, "OPP-0016")  # Won
    entry = set_opportunity_stage(session, opp, "negotiation", actor=AS_HEAD)
    assert entry.reason_code == "reopened"


def test_stale_row_version_is_409_and_nothing_changes(seeded, session):
    opp = get_opp(session, "OPP-0002")
    with pytest.raises(ApiError) as e:
        set_opportunity_stage(session, opp, "negotiation", actor=AS_BD, expected_row_version=opp.row_version + 1)
    assert e.value.status == 409 and e.value.code == "stale"
    session.rollback()
    assert get_opp(session, "OPP-0002").stage == "contacted"


def test_stage_change_and_history_commit_together(seeded, engine, session):
    """If the transaction is not committed, neither the stage nor the history entry persists."""
    opp = get_opp(session, "OPP-0002")
    set_opportunity_stage(session, opp, "negotiation", actor=AS_BD)
    session.rollback()
    from app.database import make_sessionmaker
    with make_sessionmaker(engine)() as fresh:
        assert fresh.get(Opportunity, "OPP-0002").stage == "contacted"
        assert len(fresh.scalars(select(OpportunityHistory).where(OpportunityHistory.opportunity_id == "OPP-0002")).all()) == 1


def test_history_source_request_must_exist(seeded, session):
    """Phase 2: source_request_id is a foreign key, so history cannot point at a made-up request."""
    from sqlalchemy.exc import IntegrityError
    opp = get_opp(session, "OPP-0002")
    with pytest.raises(IntegrityError):
        set_opportunity_stage(session, opp, "negotiation", actor=AS_BD, source_request_id="PR-1999-9999")
    session.rollback()
    assert get_opp(session, "OPP-0002").stage == "contacted"
