"""Proposal request endpoints: reads, loopback-only identity, pagination, Cairo dates, no PUT/DELETE."""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.clock import get_now
from app.main import create_app

from .conftest import AHMED, MD_AM, MK_AM, MK_BD, NOHA, as_user, pr


# ---------- loopback (decision 1) ----------

@pytest.mark.parametrize("host", ["10.0.0.5", "192.168.1.20", "203.0.113.7", "testclient"])
def test_dev_identity_rejected_from_non_loopback_addresses(dev_settings, engine, seeded, host):
    with TestClient(create_app(dev_settings, engine=engine), client=(host, 40000)) as c:
        for path in ("/api/me", "/api/proposal-requests", f"/api/proposal-requests/{pr(7)}", "/api/clients"):
            r = c.get(path, headers=NOHA)
            assert r.status_code == 403, (host, path)
            assert "only accepted from this computer" in r.json()["error"]["message"]
        assert c.get("/api/health").status_code == 200


@pytest.mark.parametrize("host", ["127.0.0.1", "::1"])
def test_dev_identity_accepted_from_loopback(dev_settings, engine, seeded, host):
    with TestClient(create_app(dev_settings, engine=engine), client=(host, 40000)) as c:
        assert c.get("/api/me", headers=NOHA).status_code == 200


# ---------- no PUT, no DELETE (writes are POST create, PATCH draft, POST actions only) ----------

@pytest.mark.parametrize("method,path", [
    ("put", "/api/proposal-requests"), ("delete", "/api/proposal-requests"),
    ("post", "/api/proposal-requests/{id}"), ("put", "/api/proposal-requests/{id}"),
    ("delete", "/api/proposal-requests/{id}"), ("get", "/api/proposal-requests/{id}/actions"),
    ("delete", "/api/proposal-requests/{id}/actions"),
])
def test_no_put_or_delete_routes(api, method, path):
    r = getattr(api, method)(path.format(id=pr(7)), headers=NOHA)
    assert r.status_code == 405
    assert api.get(f"/api/proposal-requests/{pr(7)}", headers=NOHA).json()["rowVersion"] == 1


def test_hidden_draft_and_missing_request_give_identical_404s(api):
    hidden = api.get(f"/api/proposal-requests/{pr(18)}", headers=NOHA)
    missing = api.get("/api/proposal-requests/PR-1999-0001", headers=NOHA)
    assert hidden.status_code == missing.status_code == 404
    assert hidden.json()["error"]["code"] == missing.json()["error"]["code"] == "not_found"
    assert hidden.json()["error"]["message"] == f"Request '{pr(18)}' not found."


# ---------- list mechanics ----------

def test_default_scope_follows_the_active_role(api):
    assert api.get("/api/proposal-requests", headers=NOHA).json()["scope"] == "company"
    assert api.get("/api/proposal-requests", headers=MK_BD).json()["scope"] == "mine"
    assert api.get("/api/proposal-requests", headers=MK_AM).json()["scope"] == "my_brand"


def test_pagination_keeps_order_counts_and_total(api):
    full = api.get("/api/proposal-requests", params={"pageSize": 100}, headers=NOHA).json()
    pages, page = [], 1
    while True:
        body = api.get("/api/proposal-requests", params={"pageSize": 5, "page": page}, headers=NOHA).json()
        assert body["counts"] == full["counts"] and body["total"] == full["total"] == 17
        if not body["items"]:
            break
        pages += body["items"]
        page += 1
    assert [i["id"] for i in pages] == [i["id"] for i in full["items"]]
    assert page == 5  # 4 pages of up to 5 items, then an empty page


def test_summary_fields(api):
    item = next(i for i in api.get("/api/proposal-requests", headers=NOHA).json()["items"] if i["id"] == pr(17))
    assert item["clientName"] == "Papyrus Fintech" and item["assignedAM"] == "u-mariam-dimitri"
    assert item["submittedBy"] == "u-noha" and item["createdBy"] == "u-noha" and item["bdOwner"] == "u-abdelrahman"
    assert item["lastUpdated"].endswith("Z") and len(item["lastUpdated"]) == 24, "UTC, frontend format"


def test_detail_includes_history_versions_opportunity_and_actions(api):
    d = api.get(f"/api/proposal-requests/{pr(10)}", headers=as_user("u-abdelrahman", "business_development")).json()
    assert d["status"] == "ready_for_bd" and d["amPrice"] == 285000
    assert [e["status"] for e in d["history"]] == ["draft", "submitted", "in_progress", "awaiting_bd_info", "in_progress", "ready_for_bd"]
    assert d["history"][3]["note"] == "Need confirmed venue capacity and catering preference."
    assert d["opportunity"]["id"] == "OPP-0012" and d["opportunity"]["stage"] == "proposal_requested"
    assert [(a["action"], a["allowed"]) for a in d["allowedActions"]] == [
        ("share_with_client", True), ("request_changes", True), ("take_back", False), ("cancel", True)]
    assert d["priceChange"] is None


# ---------- include=history (dashboards / analytics) ----------

def test_include_history_adds_history_without_changing_anything_else(api):
    plain = api.get("/api/proposal-requests", params={"pageSize": 100}, headers=NOHA).json()
    full = api.get("/api/proposal-requests", params={"pageSize": 100, "include": "history"}, headers=NOHA).json()
    assert {k: v for k, v in full.items() if k != "items"} == {k: v for k, v in plain.items() if k != "items"}
    assert [i["id"] for i in full["items"]] == [i["id"] for i in plain["items"]]
    for p, f in zip(plain["items"], full["items"]):
        assert "history" not in p, "unchanged without include"
        assert {k: v for k, v in f.items() if k not in ("history", "participants")} == p
        assert f["history"] == api.get(f"/api/proposal-requests/{p['id']}", headers=NOHA).json()["history"]


def test_include_history_never_shows_someone_elses_draft(api):
    for who in (NOHA, MD_AM, MK_AM, as_user("u-sherine", "business_development")):
        role = who["X-Dev-Role"]
        scopes = {"commercial_head": ["company"], "account_manager": ["my_brand"],  # no other brand by default
                  "business_development": ["mine", "company"]}[role]
        for scope in scopes:
            items = api.get("/api/proposal-requests", params={"scope": scope, "include": "history", "pageSize": 100},
                            headers=who).json()["items"]
            assert all(i["status"] != "draft" or i["createdBy"] == who["X-Dev-User"] for i in items), (who, scope)
    assert api.get("/api/proposal-requests", params={"include": "everything"}, headers=NOHA).status_code == 422


# ---------- display stages ----------

def test_items_and_history_carry_stage_and_sub_label(api):
    d = api.get(f"/api/proposal-requests/{pr(10)}", headers=as_user("u-abdelrahman", "business_development")).json()
    assert (d["stage"], d["subLabel"]) == ("ready_to_send", "Proposal ready")
    assert [(e["stage"], e["subLabel"]) for e in d["history"]] == [
        ("draft", None), ("with_am", "New"), ("with_am", "Preparing"), ("with_am", "Needs BD info"),
        ("with_am", "Preparing"), ("ready_to_send", "Proposal ready")]
    items = api.get("/api/proposal-requests", params={"pageSize": 100}, headers=NOHA).json()["items"]
    assert all(i["stage"] and "subLabel" in i for i in items)


def test_stage_filter_is_a_comma_list_and_combines_with_status(api):
    def ids(**params):
        return [i["id"] for i in api.get("/api/proposal-requests", params={"pageSize": 100, **params}, headers=NOHA).json()["items"]]
    with_am = api.get("/api/proposal-requests", params={"pageSize": 100, "stage": "with_am"}, headers=NOHA).json()["items"]
    assert with_am and {i["status"] for i in with_am} <= {"submitted", "in_progress", "awaiting_bd_info", "revision_requested"}
    both = api.get("/api/proposal-requests", params={"pageSize": 100, "stage": "ready_to_send,with_client"}, headers=NOHA).json()["items"]
    assert both and {i["stage"] for i in both} <= {"ready_to_send", "with_client"}
    assert set(ids(stage="with_am", status="submitted")) == set(ids(status="submitted"))
    assert ids(stage="ready_to_send", status="submitted") == []


def test_unknown_stage_is_a_422_field_error(api):
    r = api.get("/api/proposal-requests", params={"stage": "with_am,bogus"}, headers=NOHA)
    assert r.status_code == 422
    assert r.json()["error"]["fields"]["stage"] == "Unknown stage(s): bogus."


def test_config_exposes_stages_and_lost_reasons(api):
    c = api.get("/api/config", headers=NOHA).json()
    assert [s["label"] for s in c["proposalStages"]] == ["Draft", "With AM", "Ready to send", "With client", "Closed"]
    assert [r["id"] for r in c["lostReasons"]] == ["price", "timing", "competitor", "no_response", "budget_cancelled", "other",
                                                   "not_recorded"]  # "Not recorded": imported data only
    assert len(c["proposalStatuses"]) == 13, "the ten statuses, Postponed and the two closed history outcomes"


# ---------- Cairo calendar date (not UTC) ----------

def test_overdue_uses_the_cairo_calendar_date(dev_settings, engine, seeded, session):
    """Just after midnight in Cairo it is still the previous day in UTC, yet a deadline of that previous day is
    overdue. Times are picked in Cairo time, so this holds in summer (UTC+3) and winter (UTC+2) alike."""
    from datetime import time as clock_time
    from zoneinfo import ZoneInfo

    from app.models import ProposalRequest
    cairo = ZoneInfo("Africa/Cairo")
    day = datetime.now(cairo).date()
    late_evening = datetime.combine(day, clock_time(23, 0), cairo).astimezone(timezone.utc)
    after_midnight = datetime.combine(day + timedelta(days=1), clock_time(0, 30), cairo).astimezone(timezone.utc)
    assert after_midnight.date() == day, "still the deadline day in UTC"
    req = session.get(ProposalRequest, pr(15))  # In Progress, deadline pending
    req.required_by = day
    session.commit()
    app = create_app(dev_settings, engine=engine)
    with TestClient(app, client=("127.0.0.1", 40000)) as c:
        app.dependency_overrides[get_now] = lambda: late_evening  # 23:00 Cairo
        assert c.get(f"/api/proposal-requests/{pr(15)}", headers=NOHA).json()["isOverdue"] is False
        app.dependency_overrides[get_now] = lambda: after_midnight  # 00:30 Cairo, the next day
        assert c.get(f"/api/proposal-requests/{pr(15)}", headers=NOHA).json()["isOverdue"] is True
