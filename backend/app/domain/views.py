"""
Plain read-only views of requests and users, built either from ORM rows (API) or from
frontend-shaped JSON (contract scenarios). Field values follow the frontend exactly:
dates are ISO strings, month-only event dates are "YYYY-MM".
"""

from dataclasses import dataclass, field
from datetime import date, datetime, timezone


def iso_date(value: date | str | None) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) else value.isoformat()


def event_date_str(value: date | None, precision: str) -> str | None:
    if value is None:
        return None
    return value.strftime("%Y-%m") if precision == "month" else value.isoformat()


def parse_ts(value: str | datetime | None) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


@dataclass(frozen=True)
class UserView:
    id: str
    name: str
    roles: tuple[str, ...]
    brand: str | None = None
    active: bool = True
    email: str | None = None
    job_title: str | None = None
    # { manageAccounts, seeAnalytics, sendReminders, seeAllBrands }; None = the roles' defaults.
    privileges: dict | None = field(default=None, compare=False, hash=False)


@dataclass(frozen=True)
class ClientView:
    id: str
    owner: str


@dataclass(frozen=True)
class OpportunityView:
    id: str
    client_id: str
    brand: str
    stage: str


@dataclass(frozen=True)
class HistoryView:
    status: str
    changed_by: str
    role: str
    changed_at: datetime
    note: str | None = None
    version: int = 1
    has_am_price: bool = False  # the frontend only puts amPrice on Ready for BD entries
    am_price: int | None = None
    on_behalf_of: str | None = None
    previous_required_by: str | None = None
    required_by: str | None = None
    lost_reason: str | None = None
    channel: str | None = None
    follow_up_on: str | None = None  # Postponed entries
    reasons: tuple[str, ...] = ()  # codes: what's missing / what should change / why postponed
    imported: bool = False  # the one entry of a request imported from the 2026 tracker
    corrected: bool = False  # "Correct status (data fix)"


@dataclass(frozen=True)
class RequestView:
    id: str
    client_id: str
    brand: str
    service: str | None
    bd_owner: str
    created_by: str
    assigned_am: str
    status: str
    version: int
    last_updated: datetime
    opportunity_id: str | None = None
    submitted_by: str | None = None
    submitted_at: datetime | None = None
    required_by: str | None = None
    event_date: str | None = None
    event_date_precision: str = "day"
    participants: int | None = None
    requirements_summary: str | None = None
    specific_requirements: str | None = None
    am_price: int | None = None
    event_end_date: str | None = None  # optional, exact dates only
    event_name: str | None = None  # optional, e.g. "Ramadan Iftar Riders – Alex"
    original_status: str | None = None  # imported: the tracker's own status ("Event Completed")
    follow_up_on: str | None = None  # Postponed: when BD follows up
    imported: bool = False  # from the 2026 tracker: exempt from the price and file rules
    needs_review: bool = False  # imported "Pending" without a proposal date; cleared by any workflow action
    brief_tags: tuple[str, ...] = ()  # codes from the "briefTags" list
    # "Set waiting on" (by hand); None = automatic from the status. Any status change clears it.
    waiting_team: str | None = None
    waiting_user_id: str | None = None
    waiting_reason: str | None = None
    waiting_expected_by: str | None = None
    waiting_note: str | None = None
    waiting_set_at: datetime | None = None
    waiting_set_by: str | None = None
    details_changed_at: datetime | None = None
    details_seen_at: datetime | None = None
    open_questions: int = 0
    confirmed_participants: int | None = None
    final_price: int | None = None
    venue: str | None = None
    team_notes: str | None = None
    event_cancelled_at: datetime | None = None
    event_cancel_reason: str | None = None
    event_cancel_note: str | None = None
    event_status: str | None = None  # initial · confirmed · postponed · cancelled (once accepted)
    occasion_id: int | None = None  # Ramadan, Easter... (the radar)
    facilitators_needed: int | None = None  # staffing
    history: tuple[HistoryView, ...] = field(default_factory=tuple)
    file_versions: tuple[int, ...] = ()  # versions that have an uploaded proposal file


def _open_questions(messages) -> int:
    """Questions without an answer (and not marked answered); see domain/conversation.py."""
    closed = {m.get("parentId") for m in messages if m.get("kind") in ("answer", "answered")}
    return sum(1 for m in messages if m.get("kind") == "question" and m.get("id") not in closed)


# ---------- from frontend-shaped JSON (contract scenarios) ----------

def user_from_json(u: dict) -> UserView:
    return UserView(id=u["id"], name=u["name"], roles=tuple(u["roles"]), brand=u.get("brand"), active=u.get("active", True),
                    email=u.get("email"), job_title=u.get("jobTitle"), privileges=u.get("privileges"))


def client_from_json(c: dict) -> ClientView:
    return ClientView(id=c["id"], owner=c["owner"])


def opportunity_from_json(o: dict) -> OpportunityView:
    return OpportunityView(id=o["id"], client_id=o["clientId"], brand=o["brand"], stage=o["stage"])


def request_from_json(r: dict) -> RequestView:
    history = tuple(
        HistoryView(
            status=h["status"], changed_by=h["changedBy"], role=h["role"], changed_at=parse_ts(h["changedAt"]),
            note=h.get("note"), version=h.get("version", 1), has_am_price="amPrice" in h, am_price=h.get("amPrice"),
            on_behalf_of=h.get("onBehalfOf"), previous_required_by=h.get("previousRequiredBy"),
            required_by=h.get("requiredBy"), lost_reason=h.get("lostReason"), channel=h.get("channel"),
            follow_up_on=h.get("followUpOn"), imported=bool(h.get("imported")), reasons=tuple(h.get("reasons") or ()),
            corrected=bool(h.get("corrected")),
        )
        for h in r["statusHistory"]
    )
    w = r.get("waiting") or {}
    return RequestView(
        id=r["id"], client_id=r["clientId"], brand=r["brand"], service=r.get("service"), bd_owner=r["bdOwner"],
        created_by=r["createdBy"], assigned_am=r["assignedAM"], status=r["status"], version=r["version"],
        last_updated=parse_ts(r["lastUpdated"]), opportunity_id=r.get("opportunityId"),
        submitted_by=r.get("submittedBy"), submitted_at=parse_ts(r.get("submittedAt")),
        required_by=r.get("requiredBy"), event_date=r.get("eventDate"),
        event_date_precision=r.get("eventDatePrecision") or "day", participants=r.get("participants"),
        requirements_summary=r.get("requirementsSummary"), specific_requirements=r.get("specificRequirements"),
        am_price=r.get("amPrice"), event_end_date=r.get("eventEndDate"), event_name=r.get("eventName"),
        original_status=r.get("originalStatus"), follow_up_on=r.get("followUpOn"),
        imported=bool(r.get("imported")), needs_review=bool(r.get("needsReview")), history=history,
        brief_tags=tuple(r.get("briefTags") or ()),
        waiting_team=w.get("team"), waiting_user_id=w.get("userId"), waiting_reason=w.get("reason"),
        waiting_expected_by=w.get("expectedBy"), waiting_note=w.get("note"), waiting_set_at=parse_ts(w.get("setAt")),
        waiting_set_by=w.get("setBy"),
        details_changed_at=parse_ts(r.get("detailsChangedAt")), details_seen_at=parse_ts(r.get("detailsSeenAt")),
        open_questions=_open_questions(r.get("comments") or []),
        confirmed_participants=r.get("confirmedParticipants"), final_price=r.get("finalPrice"), venue=r.get("venue"),
        team_notes=r.get("teamNotes"), event_cancelled_at=parse_ts(r.get("eventCancelledAt")),
        event_cancel_reason=r.get("eventCancelReason"), event_cancel_note=r.get("eventCancelNote"),
        event_status=r.get("eventStatus"), occasion_id=r.get("occasionId"), facilitators_needed=r.get("facilitatorsNeeded"),
        file_versions=tuple(sorted({f["version"] for f in r.get("files", [])})),
    )


# ---------- from ORM rows (API) ----------

def user_from_orm(u) -> UserView:
    return UserView(id=u.id, name=u.name, roles=tuple(u.role_ids), brand=u.brand, active=u.active, email=u.email,
                    job_title=u.job_title, privileges=u.privileges)


def client_from_orm(c) -> ClientView:
    return ClientView(id=c.id, owner=c.owner_id)


def opportunity_from_orm(o) -> OpportunityView:
    return OpportunityView(id=o.id, client_id=o.client_id, brand=o.brand, stage=o.stage)


def request_from_orm(r) -> RequestView:
    history = tuple(
        HistoryView(
            status=h.status, changed_by=h.changed_by_id, role=h.role, changed_at=h.changed_at, note=h.note,
            version=h.version, has_am_price=h.status == "ready_for_bd", am_price=h.am_price,
            on_behalf_of=h.on_behalf_of_id, previous_required_by=iso_date(h.previous_required_by),
            required_by=iso_date(h.required_by), lost_reason=h.lost_reason, channel=h.channel,
            follow_up_on=iso_date(h.follow_up_on), imported=h.imported, reasons=tuple(h.reasons or ()),
            corrected=bool(h.corrected),
        )
        for h in sorted(r.history, key=lambda e: e.seq)
    )
    return RequestView(
        id=r.id, client_id=r.client_id, brand=r.brand, service=r.service, bd_owner=r.bd_owner_id,
        created_by=r.created_by_id, assigned_am=r.assigned_am_id, status=r.status, version=r.version,
        last_updated=r.last_updated, opportunity_id=r.opportunity_id, submitted_by=r.submitted_by_id,
        submitted_at=r.submitted_at, required_by=iso_date(r.required_by),
        event_date=event_date_str(r.event_date, r.event_date_precision), event_date_precision=r.event_date_precision,
        participants=r.participants, requirements_summary=r.requirements_summary,
        specific_requirements=r.specific_requirements, am_price=r.am_price,
        event_end_date=iso_date(r.event_end_date), event_name=r.event_name, original_status=r.original_status,
        follow_up_on=iso_date(r.follow_up_on), imported=r.imported,
        needs_review=r.needs_review, history=history, file_versions=tuple(sorted({f.version for f in r.files})),
        brief_tags=tuple(r.brief_tags or ()), waiting_team=r.waiting_team, waiting_user_id=r.waiting_user_id,
        waiting_reason=r.waiting_reason, waiting_expected_by=iso_date(r.waiting_expected_by), waiting_note=r.waiting_note,
        waiting_set_at=r.waiting_set_at, waiting_set_by=r.waiting_set_by_id,
        details_changed_at=r.details_changed_at, details_seen_at=r.details_seen_at,
        open_questions=_open_questions([{"id": c.id, "kind": c.kind, "parentId": c.parent_id} for c in r.comments]),
        confirmed_participants=r.confirmed_participants, final_price=r.final_price, venue=r.venue, team_notes=r.team_notes,
        event_cancelled_at=r.event_cancelled_at, event_cancel_reason=r.event_cancel_reason,
        event_cancel_note=r.event_cancel_note, event_status=r.event_status, occasion_id=r.occasion_id,
        facilitators_needed=r.facilitators_needed,
    )
