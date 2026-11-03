"""
Loads the shared contract world (contracts/proposal-scenarios.json) into a migrated test
database exactly as given (frontend ids such as c-01 are kept so responses can be compared
directly). Test-only: real data never comes from here.
"""

import json
import uuid
from datetime import date
from pathlib import Path

from fastapi.testclient import TestClient

from app.clock import get_now
from app.domain.access import set_privileges
from app.domain.views import parse_ts
from app.main import create_app
from app.models import (
    BrandRouting,
    Client, ClientBrand, ClientContact, Opportunity, OpportunityHistory, ProposalFile, ProposalRequest, RequestStatusHistory, User, UserRole,
)

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts" / "proposal-scenarios.json"


def load_scenarios() -> dict:
    return json.loads(CONTRACTS.read_text(encoding="utf-8"))


def _event_date(value: str | None) -> date | None:
    if not value:
        return None
    return date.fromisoformat(f"{value}-01" if len(value) == 7 else value)


def _date(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def load_world(session, scenarios: dict) -> None:
    world = scenarios["world"]
    now = parse_ts(scenarios["now"])
    for u in world["users"]:
        user = User(id=u["id"], name=u["name"], initials=u["initials"], avatar_tone=u["avatarTone"],
                    brand=u["brand"], active=u.get("active", True), email=u["email"], job_title=u.get("jobTitle"),
                    created_at=now, updated_at=now)
        set_privileges(user, u["privileges"])
        user.roles = [UserRole(role=r, position=i) for i, r in enumerate(u["roles"])]
        session.add(user)
    session.flush()
    for brand, am in scenarios["accountCases"]["routing"].items():
        session.add(BrandRouting(brand=brand, am_user_id=am, updated_at=now))
    session.flush()
    for c in world["clients"]:
        client = Client(id=c["id"], name=c["name"], client_type=c["type"], city=c["city"], owner_id=c["owner"],
                        created_at=now, updated_at=now)
        client.brands = [ClientBrand(brand=b, position=i) for i, b in enumerate(c["brands"])]
        client.contacts = [ClientContact(name=c["contact"]["name"], title=c["contact"]["title"], phone=c["contact"]["phone"],
                                         email=c["contact"]["email"], is_primary=True, created_at=now, updated_at=now)]
        session.add(client)
    session.flush()
    for o in world["opportunities"]:
        lost = o["stage"] == "lost"
        session.add(Opportunity(
            id=o["id"], client_id=o["clientId"], brand=o["brand"], service=o["service"], owner_id=o["owner"],
            stage=o["stage"], estimated_value=o["estimatedValue"], participants=o["participants"],
            event_date=_event_date(o["eventDate"]),
            event_date_precision="month" if o["eventDate"] and len(o["eventDate"]) == 7 else "day",
            next_action=o["nextAction"], next_action_date=_date(o["nextActionDate"]),
            lost_reason="Contract fixture: lost" if lost else None, created_at=now, updated_at=now,
        ))
        session.add(OpportunityHistory(opportunity_id=o["id"], from_stage=None, to_stage=o["stage"],
                                       changed_by_id=o["owner"], role="business_development", changed_at=now,
                                       note="Contract fixture: lost" if lost else None, reason_code="seed"))
    session.flush()
    add_requests(session, world["requests"])
    session.commit()


def add_requests(session, requests: list[dict]) -> None:
    """Inserts frontend-shaped requests (and their history) exactly as given. Does not commit."""
    for r in requests:
        history = r["statusHistory"]
        session.add(ProposalRequest(
            id=r["id"], opportunity_id=r.get("opportunityId"), client_id=r["clientId"], brand=r["brand"],
            service=r["service"], bd_owner_id=r["bdOwner"], created_by_id=r["createdBy"],
            assigned_am_id=r["assignedAM"], submitted_by_id=r.get("submittedBy"),
            submitted_at=parse_ts(r.get("submittedAt")), status=r["status"], required_by=_date(r.get("requiredBy")),
            event_date=_event_date(r.get("eventDate")), event_date_precision=r.get("eventDatePrecision") or "day",
            event_end_date=_date(r.get("eventEndDate")), follow_up_on=_date(r.get("followUpOn")),
            imported=bool(r.get("imported")), needs_review=bool(r.get("needsReview")),
            event_name=r.get("eventName"), original_status=r.get("originalStatus"),
            brief_tags=r.get("briefTags") or None,
            event_cancelled_at=parse_ts(r.get("eventCancelledAt")), event_cancel_reason=r.get("eventCancelReason"),
            event_status=r.get("eventStatus"), event_postpone_reason=r.get("eventPostponeReason"),
            event_postpone_note=r.get("eventPostponeNote"),
            waiting_team=(r.get("waiting") or {}).get("team"), waiting_user_id=(r.get("waiting") or {}).get("userId"),
            waiting_reason=(r.get("waiting") or {}).get("reason"),
            waiting_expected_by=_date((r.get("waiting") or {}).get("expectedBy")),
            waiting_note=(r.get("waiting") or {}).get("note"),
            waiting_set_at=parse_ts((r.get("waiting") or {}).get("setAt")),
            waiting_set_by_id=(r.get("waiting") or {}).get("setBy"),
            participants=r.get("participants"), requirements_summary=r.get("requirementsSummary"),
            specific_requirements=r.get("specificRequirements"), am_price=r.get("amPrice"), version=r["version"],
            price_change=r.get("priceChange"), last_updated=parse_ts(r["lastUpdated"]),
            created_at=parse_ts(history[0]["changedAt"]), updated_at=parse_ts(r["lastUpdated"]),
        ))
        session.flush()
        for seq, h in enumerate(history, start=1):
            session.add(RequestStatusHistory(
                request_id=r["id"], seq=seq, status=h["status"], changed_by_id=h["changedBy"], role=h["role"],
                changed_at=parse_ts(h["changedAt"]), note=h.get("note"), version=h.get("version", 1),
                am_price=h.get("amPrice"), on_behalf_of_id=h.get("onBehalfOf"),
                previous_required_by=_date(h.get("previousRequiredBy")), required_by=_date(h.get("requiredBy")),
                lost_reason=h.get("lostReason"), channel=h.get("channel"),
                follow_up_on=_date(h.get("followUpOn")), imported=bool(h.get("imported")), reasons=h.get("reasons"),
            ))
        for i, fl in enumerate(r.get("files", [])):  # metadata only: rule tests never read the bytes
            session.add(ProposalFile(
                request_id=r["id"], version=fl["version"], storage_key=uuid.uuid4().hex, file_type=fl["fileType"],
                original_name=fl["originalName"], size_bytes=1000 + i, sha256="0" * 64,
                uploaded_by_id=fl["uploadedBy"], role="account_manager", uploaded_at=parse_ts(fl["uploadedAt"]),
            ))
    session.flush()


def contract_client(dev_settings, engine, scenarios) -> TestClient:
    """A running app over the contract world, with the clock frozen at the scenarios' 'now'."""
    app = create_app(dev_settings, engine=engine)
    frozen = parse_ts(scenarios["now"])
    app.dependency_overrides[get_now] = lambda: frozen
    return TestClient(app, client=("127.0.0.1", 50000))


def headers(viewer: dict) -> dict:
    return {"X-Dev-User": viewer["userId"], "X-Dev-Role": viewer["activeRole"]}
