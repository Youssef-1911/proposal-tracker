"""
Proposal requests: list, detail, create (optionally submit), edit a draft, lifecycle actions.

Visibility is applied in the SQL query FIRST (drafts only for their creator, plus the
requested scope). Search, filters, tab counts, sorting and pagination then run only over
that visible set, so a hidden draft can never appear in results, counts or empty states.
"""

from dataclasses import replace
from datetime import datetime
from typing import Any, Literal

from urllib.parse import unquote

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session, selectinload

from .. import config_domain as cfg
from ..clock import cairo_today_iso, get_now, iso_z
from ..database import begin_write, get_db
from ..domain import access, rules, tracker
from ..domain import conversation
from ..domain import waiting as waiting_rules
from ..domain import corrections
from ..domain import events as event_rules
from ..domain.access import can_see_request
from ..domain.lists import option_label
from ..domain.proposal_files import MIME, can_see_replaced_files, download_file_name, upload_target
from ..domain.request_form import request_fields
from ..domain.views import request_from_orm, user_from_orm
from ..domain.workflow import can_edit_draft, get_actions
from ..errors import forbidden, not_found, validation
from ..identity import Actor, get_current_actor
from ..models import Client, Opportunity, ProposalRequest, RequestEvent, RequestRead, User
from ..domain import activity
from ..schemas import event_date_out
from ..services import proposal_files as files_service
from ..services import proposal_requests as service
from ..services import corrections as corrections_service
from ..services import notifications as notifications_service
from ..services.lists import load_lists

router = APIRouter(prefix="/api/proposal-requests", tags=["proposal requests"])

Brand = Literal["grasshoppers", "teamup"]
Tab = Literal["all", "action", "overdue", "closed"]
Sort = Literal["deadline", "updated", "event"]
DeadlineState = Literal["overdue", "upcoming", "later", "none"]
WaitingOn = Literal["am", "bd"]
WaitingChip = Literal["me", "bd", "am", "marketing", "operations", "client"]


# ---------- shared helpers ----------

def _users(db: Session) -> dict:
    return {u.id: user_from_orm(u) for u in db.scalars(select(User).options(selectinload(User.roles))).all()}


def _client_names(db: Session) -> dict:
    return dict(db.execute(select(Client.id, Client.name)).all())


def _visibility(actor: Actor):
    """Drafts are visible only to their creator (even the Commercial Head)."""
    return or_(ProposalRequest.status != "draft", ProposalRequest.created_by_id == actor.user_id)


def _scope_clause(actor: Actor, scope: str, user_brand: str | None):
    """SQL version of tracker.in_scope (re-checked in Python afterwards)."""
    not_draft = ProposalRequest.status != "draft"
    role = actor.active_role
    if role == cfg.BUSINESS_DEVELOPMENT and scope == tracker.MINE:
        return or_(and_(ProposalRequest.status == "draft", ProposalRequest.created_by_id == actor.user_id),
                   and_(not_draft, ProposalRequest.bd_owner_id == actor.user_id))
    if role == cfg.BUSINESS_DEVELOPMENT and scope == tracker.COMPANY:
        return and_(not_draft, ProposalRequest.bd_owner_id != actor.user_id)
    if role == cfg.ACCOUNT_MANAGER and scope == tracker.MY_BRAND:
        return and_(not_draft, ProposalRequest.brand == user_brand)
    if role == cfg.ACCOUNT_MANAGER and scope == tracker.COMPANY:
        return and_(not_draft, ProposalRequest.brand != user_brand)
    if role in (cfg.COMMERCIAL_HEAD, cfg.EXECUTIVE) and scope == tracker.COMPANY:
        return _visibility(actor)
    return ProposalRequest.id.is_(None)  # no scope -> nothing


def _summary(view, ctx) -> dict:
    """Fields a tracker row/card needs (frontend names), plus rule results computed on the server."""
    today, now, actor, users = ctx["today"], ctx["now"], ctx["actor"], ctx["users"]
    return {
        "id": view.id,
        "opportunityId": view.opportunity_id,
        "clientId": view.client_id,
        "clientName": ctx["client_names"].get(view.client_id),
        "brand": view.brand,
        "service": view.service,
        "eventDate": view.event_date,
        "eventDatePrecision": view.event_date_precision,
        "eventEndDate": view.event_end_date,
        "eventName": view.event_name,
        "originalStatus": view.original_status,
        "followUpOn": view.follow_up_on,
        "imported": view.imported,
        "needsReview": view.needs_review,
        "briefTags": list(view.brief_tags),
        # Set by hand ("Set waiting on"); None = automatic from the status (domain/waiting.py).
        "waiting": None if not view.waiting_team else {
            "team": view.waiting_team, "userId": view.waiting_user_id, "reason": view.waiting_reason,
            "expectedBy": view.waiting_expected_by, "note": view.waiting_note, "setAt": iso_z(view.waiting_set_at),
            "setBy": view.waiting_set_by},
        "statusSince": iso_z(waiting_rules.status_since(view)),
        "openQuestions": view.open_questions,
        # "Mark confirmed" / "Event cancelled" (proposal viewers only: they may see prices).
        "confirmedParticipants": view.confirmed_participants, "finalPrice": view.final_price, "venue": view.venue,
        "eventCancelledAt": iso_z(view.event_cancelled_at), "eventCancelReason": view.event_cancel_reason,
        "eventStatus": event_rules.view_event_status(view),
        "occasionId": view.occasion_id, "facilitatorsNeeded": view.facilitators_needed,
        "detailsChangedAt": iso_z(view.details_changed_at),
        "detailsSeenAt": iso_z(view.details_seen_at),
        "requiredBy": view.required_by,
        "status": view.status,
        "stage": rules.stage_of(view.status),
        "subLabel": rules.sub_label(view.status, view.version),
        "bdOwner": view.bd_owner,
        "createdBy": view.created_by,
        "assignedAM": view.assigned_am,
        "submittedBy": view.submitted_by,
        "submittedAt": iso_z(view.submitted_at),
        "lastUpdated": iso_z(view.last_updated),
        "version": view.version,
        "amPrice": view.am_price,
        "amPricePerParticipant": rules.price_per_participant(view.am_price, view.participants),
        **{k: iso_z(v) if isinstance(v, datetime) else v for k, v in rules.stage_timing(view, now).items()},
        "waitingOn": rules.responsible_for(view),
        "deadlineState": tracker.deadline_state(view, today),
        "deadlineActive": rules.is_open_request(view) and rules.is_deadline_pending(view),
        "isOverdue": rules.is_request_overdue(view, today),
        "needsMyAction": tracker.needs_my_action(view, actor, users, now),
        "canEditDraft": can_edit_draft(view, actor, users),
        # What is new for this person since they last opened it: { line, at, count } or None.
        "newForYou": ctx.get("new_for_you", {}).get(view.id),
    }


# ---------- list ----------

@router.get("")
def list_requests(
    scope: str | None = None,
    tab: Tab = "all",
    q: str = Query(default="", max_length=100),
    brand: Brand | None = None,
    status: str | None = Query(default=None, description="Comma-separated statuses"),
    stage: str | None = Query(default=None, description="Comma-separated display stages"),
    assigned_am: str | None = Query(default=None, alias="assignedAM"),
    bd_owner: str | None = Query(default=None, alias="bdOwner"),
    deadline: DeadlineState | None = None,
    waiting_on: WaitingOn | None = Query(default=None, alias="waitingOn"),
    open: bool = False,
    needs_review: bool = Query(default=False, alias="needsReview"),
    hide_events: bool = Query(default=False, alias="hideEvents", description="Leave out confirmed proposals (Events)"),
    bucket: Literal["", "open", "with_am", "waiting", "ready", "with_client", "postponed", "closed"] = Query(
        default="", description="The Proposals page's tab"),
    waiting: WaitingChip | None = Query(default=None, description="Waiting on: me, bd, am, marketing, operations, client"),
    sort: Sort = "updated",  # most recent activity first
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100, alias="pageSize"),
    include: Literal["history"] | None = Query(
        default=None, description="'history': add each request's status history (for dashboards and analytics)"),
    actor: Actor = Depends(get_current_actor),
    now: datetime = Depends(get_now),
    db: Session = Depends(get_db),
):
    users = _users(db)
    me = users[actor.user_id]
    allowed_scopes = tracker.scopes_for(actor.active_role, me)
    if not allowed_scopes:
        raise forbidden("Your role has no access to proposal requests.")
    scope = scope or tracker.default_scope(actor.active_role, me)
    if scope not in allowed_scopes:
        raise validation("Please fix the highlighted fields.",
                         {"scope": f"Scope must be one of {allowed_scopes} for your active role."})
    statuses = [s.strip() for s in (status or "").split(",") if s.strip()]
    unknown = [s for s in statuses if s not in rules.STATUS]
    if unknown:
        raise validation("Please fix the highlighted fields.", {"status": f"Unknown status(es): {', '.join(unknown)}."})
    stages = [s.strip() for s in (stage or "").split(",") if s.strip()]
    unknown = [s for s in stages if s not in rules.STAGES]
    if unknown:
        raise validation("Please fix the highlighted fields.", {"stage": f"Unknown stage(s): {', '.join(unknown)}."})

    user_brand = me.brand
    rows = db.scalars(
        select(ProposalRequest)
        .where(_visibility(actor), _scope_clause(actor, scope, user_brand))  # visibility FIRST
        .options(selectinload(ProposalRequest.history), selectinload(ProposalRequest.files))
    ).all()
    views = [request_from_orm(r) for r in rows]

    today = cairo_today_iso(now)
    client_names = _client_names(db)
    filters = tracker.Filters(q=q, brand=brand or "", status=statuses, stage=stages, assigned_am=assigned_am or "",
                              bd_owner=bd_owner or "", deadline=deadline or "", waiting_on=waiting_on or "", open=open,
                              needs_review=needs_review, waiting=waiting or "", hide_events=hide_events, bucket=bucket)
    result = tracker.query_tracker(views, tracker.TrackerQuery(scope=scope, tab=tab, sort=sort, filters=filters),
                                   viewer=actor, users=users, client_names=client_names, today=today, now=now)
    total = len(result["rows"])
    page_rows = result["rows"][(page - 1) * page_size: page * page_size]
    ctx = {"today": today, "now": now, "actor": actor, "users": users, "client_names": client_names,
           "new_for_you": new_for_you_map(db, rows, actor, users)}
    items = [_summary(v, ctx) for v in page_rows]
    if include == "history":  # optional; without it the response is unchanged
        rows_by_id = {r.id: r for r in rows}
        for item in items:
            row = rows_by_id[item["id"]]
            item["history"] = _history_out(row)
            item["participants"] = row.participants
    return {
        "items": items,
        "counts": result["counts"],
        "bucketCounts": result["bucketCounts"],
        "total": total,
        "page": page,
        "pageSize": page_size,
        "scope": scope,
        "scopeSize": len(result["scoped"]),  # lets the UI tell "empty scope" from "no matches"
    }


# ---------- detail ----------

def _history_out(row: ProposalRequest) -> list[dict]:
    return [
        {
            "seq": h.seq, "status": h.status, "stage": rules.stage_of(h.status),
            "subLabel": rules.sub_label(h.status, h.version),
            # An imported entry is shown as "Imported from the 2026 tracker": who ran the import stays internal.
            "changedBy": None if h.imported else h.changed_by_id, "role": h.role,
            "changedAt": iso_z(h.changed_at), "note": h.note, "version": h.version,
            "amPrice": h.am_price, "onBehalfOf": h.on_behalf_of_id,
            "previousRequiredBy": h.previous_required_by.isoformat() if h.previous_required_by else None,
            "requiredBy": h.required_by.isoformat() if h.required_by else None,
            "lostReason": h.lost_reason, "channel": h.channel,
            "followUpOn": h.follow_up_on.isoformat() if h.follow_up_on else None, "imported": h.imported,
            "reasons": list(h.reasons or []), "corrected": bool(h.corrected),
        }
        for h in sorted(row.history, key=lambda e: e.seq)
    ]


def _detail(db: Session, row: ProposalRequest, actor: Actor, now: datetime) -> dict:
    users = _users(db)
    view = request_from_orm(row)
    read = db.get(RequestRead, (actor.user_id, actor.active_role, row.id))
    ctx = {"today": cairo_today_iso(now), "now": now, "actor": actor, "users": users, "client_names": _client_names(db),
           "new_for_you": new_for_you_map(db, [row], actor, users)}
    opp = db.get(Opportunity, row.opportunity_id) if row.opportunity_id else None
    return {
        **_summary(view, ctx),
        "participants": view.participants,
        "requirementsSummary": view.requirements_summary,
        "specificRequirements": view.specific_requirements,
        "priceChange": row.price_change,
        "rowVersion": row.row_version,
        "lastReadAt": iso_z(read.read_at) if read else None,  # highlight what is new since then
        "history": _history_out(row),
        "versions": [{**v, "readyAt": iso_z(v["readyAt"])} for v in rules.proposal_versions(view)],
        "opportunity": None if opp is None else {
            "id": opp.id, "clientId": opp.client_id, "brand": opp.brand, "service": opp.service, "owner": opp.owner_id,
            "stage": opp.stage, "lostReason": opp.lost_reason, "estimatedValue": opp.estimated_value,
            "eventDate": event_date_out(opp.event_date, opp.event_date_precision),
            "eventDatePrecision": opp.event_date_precision, "rowVersion": opp.row_version,
        },
        "allowedActions": get_actions(view, actor, users),
        "conversationPermissions": {"ask": conversation.can_ask_question(view, actor, users),
                                    "updateDetails": conversation.can_update_details(view, actor, users)},
        "correctStatus": corrections.can_correct_status(view, actor, users),
        "waitingPermissions": {"set": waiting_rules.can_set_waiting_on(view, actor, users),
                               "clear": waiting_rules.can_clear_waiting_on(view, actor, users)},
        "upload": upload_target(view, actor, users),
        "files": _files_out(row, ctx["client_names"].get(row.client_id), can_see_replaced_files(view, actor)),
        # Non-status events, e.g. the BD owner transferred with the client (kept apart from the status history).
        "events": [{"id": e.id, "event": e.event, "changedBy": e.changed_by_id, "role": e.role,
                    "changedAt": iso_z(e.changed_at), "fromUser": e.from_user_id, "toUser": e.to_user_id, "note": e.note,
                    "details": e.details}
                   for e in db.scalars(select(RequestEvent).where(RequestEvent.request_id == row.id)
                                       .order_by(RequestEvent.id)).all()],
        # Kept separate from the status history; the UI may merge both into one timeline by time.
        "comments": [_comment_out(c) for c in row.comments],
    }


def _files_out(row: ProposalRequest, client_name: str | None, see_replaced: bool) -> list[dict]:
    current = files_service.current_file_ids(row.files)
    shown = files_service.visible_files(row.files, see_replaced)
    return [{
        "id": f.id, "version": f.version, "fileType": f.file_type, "originalName": f.original_name,
        "sizeBytes": f.size_bytes, "sha256": f.sha256, "uploadedBy": f.uploaded_by_id, "role": f.role,
        "uploadedAt": iso_z(f.uploaded_at), "current": f.id in current, "replacesFileId": f.replaces_file_id,
        "downloadName": download_file_name(row.id, client_name, f.version, f.file_type),
        "downloadUrl": f"/api/proposal-requests/{row.id}/files/{f.id}",
    } for f in sorted(shown, key=lambda x: (x.version, x.id))]


def _comment_out(c) -> dict:
    # Plain text: returned exactly as stored. The UI must render it as text, never as HTML.
    return {"id": c.id, "body": c.body, "author": c.author_id, "role": c.role, "createdAt": iso_z(c.created_at),
            "kind": c.kind, "about": c.about, "parentId": c.parent_id, "reasons": c.reasons or []}


def _load_visible(db: Session, request_id: str, actor: Actor) -> ProposalRequest:
    row = db.scalars(
        select(ProposalRequest).where(ProposalRequest.id == request_id, _visibility(actor))
        .options(selectinload(ProposalRequest.history), selectinload(ProposalRequest.files))
    ).first()
    # Same answer for "doesn't exist", "someone else's draft" and "a brand (or role) that does not see it".
    if row is None or not access.can_see_request(request_from_orm(row), actor, _users(db)):
        raise not_found(f"Request {request_id!r} not found.")
    return row


@router.get("/new-count")
def new_count(actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    """How many requests this person may see have something new for them (sidebar and browser tab)."""
    users = _users(db)
    if not access.sees_proposal_data(actor.active_role):
        from ..models import Notification
        notes = db.scalars(select(Notification).where(Notification.user_id == actor.user_id, Notification.kind == "event",
                                                      Notification.read_at.is_(None))).all()
        return {"count": len({i for n in notes for i in (n.request_ids or [])})}
    rows = db.scalars(select(ProposalRequest).where(_visibility(actor))
                      .options(selectinload(ProposalRequest.history), selectinload(ProposalRequest.comments))).all()
    rows = [r for r in rows if access.can_see_request(request_from_orm(r), actor, users)]
    return {"count": len(new_for_you_map(db, rows, actor, users))}


@router.get("/waiting-on-me")
def waiting_on_me(actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                  db: Session = Depends(get_db)):
    """Requests waiting (set by hand) on this person or their team: the Marketing / Operations Home.
    Only what the line needs, so it works for roles that do not see proposal data."""
    users = _users(db)
    names = _client_names(db)
    lists = load_lists(db)
    items = []
    for row in service.waiting_on_me(db, actor):
        view = request_from_orm(row)
        auto = waiting_rules.effective_waiting(replace(view, waiting_team=None))
        items.append({
            "id": row.id, "clientName": names.get(row.client_id), "eventName": row.event_name, "brand": row.brand,
            "service": row.service, "team": row.waiting_team, "userId": row.waiting_user_id,
            "reason": row.waiting_reason,
            "reasonLabel": option_label(lists, waiting_rules.TEAMS[row.waiting_team]["reasons"], row.waiting_reason),
            "expectedBy": row.waiting_expected_by.isoformat() if row.waiting_expected_by else None,
            "note": row.waiting_note, "setAt": iso_z(row.waiting_set_at), "setBy": row.waiting_set_by_id,
            "backTo": waiting_rules.waiting_label(auto, users), "rowVersion": row.row_version,
            "canOpen": can_see_request(view, actor, users),
        })
    return {"items": items, "total": len(items)}


@router.get("/{request_id}")
def get_request(
    request_id: str,
    actor: Actor = Depends(get_current_actor),
    now: datetime = Depends(get_now),
    db: Session = Depends(get_db),
):
    return _detail(db, _load_visible(db, request_id, actor), actor, now)


# ---------- writes ----------
# Every write is ONE transaction: the service changes the request, appends its history entry
# and syncs the opportunity; this router commits once at the end. Any error before the
# commit (validation, permission, stale row version, or an unexpected failure) saves nothing.
# The response is the updated request (same shape as GET, with fresh allowedActions) plus a
# message and warnings.

class _WriteIn(BaseModel):
    # Unknown fields are refused, so server-generated values (id, status, createdBy, bdOwner,
    # assignedAM, submittedBy, timestamps, ...) can never be sent by the caller.
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=False)


class RequestFieldsIn(_WriteIn):
    # Values are checked by the ported frontend rules (domain/request_form.py), not by type
    # coercion here, so every message matches the form's.
    client_id: Any = None
    brand: Any = None
    service: Any = None
    opportunity_id: Any = None
    event_name: Any = None
    event_date_precision: Any = None
    event_date: Any = None
    event_end_date: Any = None
    required_by: Any = None
    participants: Any = None
    requirements_summary: Any = None
    specific_requirements: Any = None
    brief_tags: Any = None


class NewClientIn(_WriteIn):
    """"+ Add '<name>' as a new client" from the form; created with the request, in one transaction."""
    name: Any = None
    type: Any = None
    owner: Any = None  # used only when the Commercial Head adds the client
    contact_name: Any = None
    contact_phone: Any = None


class CreateRequestIn(RequestFieldsIn):
    submit: bool = False
    new_client: NewClientIn | None = None
    occasion_id: int | None = None  # optional: Ramadan, Easter... (the radar)
    from_radar: bool = False  # "Create request from previous" on the radar


def _set_occasion(db: Session, row_id: str, occasion_id, from_radar: bool | None = None) -> None:
    """The optional occasion (and whether it came from the radar), kept outside the shared form rules."""
    from ..models import Occasion
    row = db.get(ProposalRequest, row_id)
    if occasion_id is not None and db.get(Occasion, occasion_id) is None:
        raise validation("Please fix the highlighted fields.", {"occasionId": "Choose an occasion from the list."})
    row.occasion_id = occasion_id
    if from_radar is not None:
        row.from_radar = from_radar


class UpdateDraftIn(RequestFieldsIn):
    expected_row_version: int | None = None
    submit: bool = False
    new_client: NewClientIn | None = None
    occasion_id: int | None = None


class ActionIn(_WriteIn):
    action: str
    expected_row_version: int | None = None
    note: Any = None
    am_price: Any = None
    new_required_by: Any = None
    confirm_shared: Any = None
    lost_reason: Any = None
    channel: Any = None
    follow_up_on: Any = None  # Postponed: when BD follows up
    reasons: Any = None  # codes: what's missing / what should change / why postponed
    # "Mark confirmed": the event date(s) and the final details
    event_date: Any = None
    event_end_date: Any = None
    final_participants: Any = None
    final_price: Any = None
    venue: Any = None
    team_notes: Any = None
    event_status: Any = None  # "Mark confirmed": initial · confirmed


def _notify_new(db: Session, request_id: str, now: datetime, actor: Actor | None = None) -> None:
    row = db.get(ProposalRequest, request_id)
    if row is not None:
        notifications_service.notify_new_activity(db, row, now)
        if actor is not None:
            mark_read_for(db, actor, row.id, now)


def mark_read_for(db: Session, actor: Actor, request_id: str, now: datetime, roles: list[str] | None = None) -> None:
    """Read up to now for this person: opening a request (that role), or acting on it (every role they hold)."""
    if roles is None:
        user = db.get(User, actor.user_id)
        roles = list(user.role_ids) if user is not None else [actor.active_role]
    for role in roles:
        read = db.get(RequestRead, (actor.user_id, role, request_id))
        if read is None:
            db.add(RequestRead(user_id=actor.user_id, role=role, request_id=request_id, read_at=now))
        elif read.read_at < now:
            read.read_at = now


def _respond(db: Session, request_id: str, actor: Actor, now: datetime, result: dict,
             on_commit_failure=None) -> dict:
    try:
        _notify_new(db, request_id, now, actor)
        db.commit()
    except BaseException:
        if on_commit_failure:
            on_commit_failure()
        raise
    db.expire_all()
    return {"request": _detail(db, _load_visible(db, request_id, actor), actor, now),
            "message": result["message"], "warnings": result["warnings"]}


@router.post("", status_code=201)
def create_request(
    body: CreateRequestIn,
    actor: Actor = Depends(get_current_actor),
    now: datetime = Depends(get_now),
    db: Session = Depends(get_db),
):
    """Creates a Draft; with "submit": true creates and submits it in one transaction."""
    data = body.model_dump(by_alias=True, exclude={"submit", "occasion_id", "from_radar"})
    result = service.create_request(db, actor, data, submit=body.submit, now=now)
    _set_occasion(db, result["row"].id, body.occasion_id, body.from_radar)
    return _respond(db, result["row"].id, actor, now, result)


@router.patch("/{request_id}")
def update_draft(
    request_id: str,
    body: UpdateDraftIn,
    actor: Actor = Depends(get_current_actor),
    now: datetime = Depends(get_now),
    db: Session = Depends(get_db),
):
    """Edits a Draft (fields not sent keep their value; null clears). "submit": true also submits it."""
    row = service.load_for_write(db, request_id, actor, body.expected_row_version)
    sent = body.model_dump(by_alias=True, exclude_unset=True, exclude={"expected_row_version", "submit", "occasion_id"})
    if body.new_client is not None:
        sent["newClient"] = body.new_client.model_dump(by_alias=True)
    data = {**request_fields(request_from_orm(row)), **sent}
    result = service.update_draft(db, actor, row, data, submit=body.submit, now=now)
    if "occasion_id" in body.model_fields_set:
        _set_occasion(db, request_id, body.occasion_id)
    return _respond(db, request_id, actor, now, result)


@router.post("/{request_id}/actions")
def perform_action(
    request_id: str,
    body: ActionIn,
    actor: Actor = Depends(get_current_actor),
    now: datetime = Depends(get_now),
    db: Session = Depends(get_db),
):
    """Applies one lifecycle action (see allowedActions on the request)."""
    row = service.load_for_write(db, request_id, actor, body.expected_row_version)
    data = body.model_dump(by_alias=True, exclude_unset=True, exclude={"action", "expected_row_version"})
    outcome = service.perform_action(db, actor, row, body.action, data, now)
    return _respond(db, request_id, actor, now, outcome)


# ---------- proposal files ----------
# Upload: the request body IS the file (no multipart), its name in the X-File-Name header
# (URL-encoded), expectedRowVersion as a query parameter. The body is read with a hard limit:
# reading stops as soon as it passes 25 MB.

async def read_upload(request: Request) -> files_service.Upload:
    name = unquote(request.headers.get("X-File-Name") or "")
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > cfg.PROPOSAL_FILE_MAX_BYTES:
        return files_service.Upload(name, None, too_large=True)
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > cfg.PROPOSAL_FILE_MAX_BYTES:
            return files_service.Upload(name, None, too_large=True)
    return files_service.Upload(name, bytes(data))


@router.post("/{request_id}/files", status_code=201)
def upload_file(
    request_id: str,
    request: Request,
    actor: Actor = Depends(get_current_actor),
    expected_row_version: int | None = Query(default=None, alias="expectedRowVersion"),
    upload: files_service.Upload = Depends(read_upload),
    now: datetime = Depends(get_now),
    db: Session = Depends(get_db),
):
    """The assigned AM uploads (or replaces) the proposal file for the version being prepared."""
    storage = request.app.state.storage
    row = service.load_for_write(db, request_id, actor, expected_row_version)
    result = files_service.upload_proposal_file(db, storage, actor, row, upload, now)
    out = _respond(db, request_id, actor, now, result,
                   on_commit_failure=lambda: files_service.discard_saved_file(storage, result["storage_key"]))
    out["file"] = next(f for f in out["request"]["files"] if f["id"] == result["file"].id)  # the uploader is the AM
    return out


@router.get("/{request_id}/files/{file_id}")
def download_file(
    request_id: str,
    file_id: int,
    request: Request,
    actor: Actor = Depends(get_current_actor),
    db: Session = Depends(get_db),
):
    """Anyone who can view the request may download its files (someone else's draft: 404). Always as a download."""
    row = _load_visible(db, request_id, actor)
    shown = files_service.visible_files(row.files, can_see_replaced_files(request_from_orm(row), actor))
    f = next((x for x in shown if x.id == file_id), None)  # a replaced file is 404 for those who may not see it
    if f is None:
        raise not_found(f"File {file_id} not found on request {request_id!r}.")
    try:
        data = request.app.state.storage.read(f.storage_key)
    except FileNotFoundError:
        raise not_found("The file's content is missing from storage.") from None
    name = download_file_name(row.id, row.client.name if row.client else None, f.version, f.file_type)
    return Response(content=data, media_type=MIME[f.file_type], headers={
        "Content-Disposition": f'attachment; filename="{name}"',  # never rendered inline
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
    })


# ---------- comments ----------

class CommentIn(_WriteIn):
    body: Any = None
    reasons: Any = None  # "Change needed": what should change
    new_required_by: Any = None  # "Change needed" after sharing: the new proposal deadline
    kind: Any = None  # comment (default) · question · answer · answered
    about: Any = None  # a questionAbout code (questions)
    parent_id: Any = None  # the question being answered


class DetailsIn(_WriteIn):
    expected_row_version: int | None = None
    event_name: Any = None
    event_date_precision: Any = None
    event_date: Any = None
    event_end_date: Any = None
    participants: Any = None
    requirements_summary: Any = None
    specific_requirements: Any = None
    required_by: Any = None
    note: Any = None


@router.get("/{request_id}/comments")
def list_comments(request_id: str, actor: Actor = Depends(get_current_actor), db: Session = Depends(get_db)):
    row = _load_visible(db, request_id, actor)
    items = [_comment_out(c) for c in row.comments]
    return {"items": items, "total": len(items)}


@router.post("/{request_id}/comments", status_code=201)
def add_comment(
    request_id: str,
    body: CommentIn,
    actor: Actor = Depends(get_current_actor),
    now: datetime = Depends(get_now),
    db: Session = Depends(get_db),
):
    """Anyone who can view the request may comment (drafts: only their creator). Plain text, append-only."""
    begin_write(db)
    row = _load_visible(db, request_id, actor)
    comment = files_service.add_comment(db, actor, row, body.body, now, kind=body.kind, about=body.about,
                                        parent_id=body.parent_id, reasons=body.reasons, new_required_by=body.new_required_by)
    mark_read_for(db, actor, row.id, now)  # writing in it means you have seen it
    db.commit()
    return {"comment": _comment_out(comment)}


# ---------- "Set waiting on" ----------

class WaitingIn(_WriteIn):
    expected_row_version: int | None = None
    team: Any = None
    user_id: Any = None
    reason: Any = None
    expected_by: Any = None
    note: Any = None


class WaitingClearIn(_WriteIn):
    expected_row_version: int | None = None


def _respond_waiting(db: Session, request_id: str, actor: Actor, now: datetime, result: dict) -> dict:
    """The full request for people who may see it; Marketing / Operations get the message only."""
    _notify_new(db, request_id, now, actor)
    db.commit()
    db.expire_all()
    row = db.get(ProposalRequest, request_id)
    if row is not None and can_see_request(request_from_orm(row), actor, _users(db)):
        return {"request": _detail(db, row, actor, now), "message": result["message"], "warnings": result["warnings"]}
    return {"request": None, "message": result["message"], "warnings": result["warnings"]}


@router.post("/{request_id}/waiting-on")
def set_waiting_on(request_id: str, body: WaitingIn, actor: Actor = Depends(get_current_actor),
                   now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """Who the request is waiting on, set by hand (the stage stays automatic). Cleared by any status change."""
    row = service.load_for_write(db, request_id, actor, body.expected_row_version)
    data = body.model_dump(by_alias=True, exclude={"expected_row_version"})
    return _respond_waiting(db, request_id, actor, now, service.set_waiting_on(db, actor, row, data, now))


@router.post("/{request_id}/waiting-on/clear")
def clear_waiting_on(request_id: str, body: WaitingClearIn, actor: Actor = Depends(get_current_actor),
                     now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """Back to automatic ("Clear", or "Done — back to …" by the person or team it waits on)."""
    row = service.load_for_waiting(db, request_id, actor, body.expected_row_version)
    return _respond_waiting(db, request_id, actor, now, service.clear_waiting_on(db, actor, row, now))


# ---------- "Update details" ----------

@router.patch("/{request_id}/details")
def update_details(request_id: str, body: DetailsIn, actor: Actor = Depends(get_current_actor),
                   now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """The BD owner (or the Commercial Head) changes details of a submitted request; each change is recorded."""
    row = service.load_for_write(db, request_id, actor, body.expected_row_version)
    data = body.model_dump(by_alias=True, exclude_unset=True, exclude={"expected_row_version"})
    return _respond(db, request_id, actor, now, service.update_details(db, actor, row, data, now))


@router.post("/{request_id}/details/seen")
def details_seen(request_id: str, body: WaitingClearIn, actor: Actor = Depends(get_current_actor),
                 now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """The assigned AM has seen the changed details (opening the request, or "No change needed")."""
    row = service.load_for_write(db, request_id, actor, body.expected_row_version)
    return _respond(db, request_id, actor, now, service.mark_details_seen(db, actor, row, now))


# ---------- "New for you" (read state per person) ----------

def new_for_you_map(db: Session, rows, actor: Actor, users: dict) -> dict:
    """{request id: {line, at, count}} for the requests that have something new for this person."""
    if not rows:
        return {}
    ids = [r.id for r in rows]
    reads = {x.request_id: x.read_at for x in db.scalars(select(RequestRead).where(
        RequestRead.user_id == actor.user_id, RequestRead.role == actor.active_role, RequestRead.request_id.in_(ids))).all()}
    events: dict = {}
    for e in db.scalars(select(RequestEvent).where(RequestEvent.request_id.in_(ids))).all():
        events.setdefault(e.request_id, []).append(
            {"event": e.event, "changedBy": e.changed_by_id, "role": e.role, "changedAt": e.changed_at,
             "toUser": e.to_user_id, "details": e.details})
    lists = load_lists(db)
    out = {}
    for row in rows:
        messages = [{"id": c.id, "kind": c.kind, "body": c.body, "about": c.about, "parentId": c.parent_id,
                     "reasons": c.reasons, "author": c.author_id, "role": c.role, "createdAt": c.created_at}
                    for c in row.comments]
        got = activity.new_for_you(request_from_orm(row), actor, reads.get(row.id), users, messages,
                                   events.get(row.id, []), lists)
        if got:
            out[row.id] = {"line": got["line"], "at": iso_z(got["at"]) if not isinstance(got["at"], str) else got["at"],
                           "count": got["count"]}
    return out


class ReadIn(_WriteIn):
    pass


@router.post("/{request_id}/read")
def mark_read(request_id: str, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
              db: Session = Depends(get_db)):
    """Opening a request clears "New for you" for this person in the role they are working in (only theirs)."""
    begin_write(db)
    row = _load_visible(db, request_id, actor)
    mark_read_for(db, actor, row.id, now, roles=[actor.active_role])
    db.commit()
    return {"readAt": iso_z(now)}


# ---------- Data fixes: "Correct status" and "Add past proposal or event" ----------

class CorrectStatusIn(_WriteIn):
    expected_row_version: int | None = None
    target: Any = None
    follow_up_on: Any = None
    event_date: Any = None
    event_end_date: Any = None
    final_price: Any = None
    final_participants: Any = None
    lost_reason: Any = None
    note: Any = None
    occasion_id: int | None = None


@router.post("/{request_id}/correct-status")
def correct_status(request_id: str, body: CorrectStatusIn, actor: Actor = Depends(get_current_actor),
                   now: datetime = Depends(get_now), db: Session = Depends(get_db)):
    """A data fix: straight to the right status (recorded as corrected; no one is notified)."""
    row = service.load_for_write(db, request_id, actor, body.expected_row_version)
    data = body.model_dump(by_alias=True, exclude={"expected_row_version", "occasion_id"})
    result = corrections_service.correct_status(db, actor, row, data, now)
    if "occasion_id" in body.model_fields_set:
        _set_occasion(db, request_id, body.occasion_id)
    return _respond(db, request_id, actor, now, result)


class PastRecordIn(_WriteIn):
    client_id: Any = None
    new_client: NewClientIn | None = None
    event_name: Any = None
    brand: Any = None
    service: Any = None
    bd_owner: Any = None
    assigned_am: Any = Field(default=None, alias="assignedAM")
    brief_date: Any = None
    sent_date: Any = None
    event_date: Any = None
    event_end_date: Any = None
    participants: Any = None
    outcome: Any = None
    am_price: Any = None
    final_price: Any = None
    lost_reason: Any = None
    follow_up_on: Any = None
    notes: Any = None
    confirm_duplicate: bool = False
    occasion_id: int | None = None


@router.post("/past", status_code=201)
def add_past_record(body: PastRecordIn, actor: Actor = Depends(get_current_actor), now: datetime = Depends(get_now),
                    db: Session = Depends(get_db)):
    """"Add past proposal or event": a record from before IEE, history from its dates. No notifications."""
    begin_write(db)
    data = body.model_dump(by_alias=True, exclude={"occasion_id"})
    if body.new_client is not None:
        data["newClient"] = body.new_client.model_dump(by_alias=True)
    result = corrections_service.add_past_record(db, actor, data, now)
    _set_occasion(db, result["row"].id, body.occasion_id)
    db.commit()
    db.expire_all()
    return {"request": _detail(db, _load_visible(db, result["row"].id, actor), actor, now),
            "message": result["message"], "warnings": result["warnings"]}


@router.post("/{request_id}/past-file", status_code=201)
def upload_past_file(request_id: str, request: Request, actor: Actor = Depends(get_current_actor),
                     upload: files_service.Upload = Depends(read_upload), now: datetime = Depends(get_now),
                     db: Session = Depends(get_db)):
    """The proposal file of a past record, right after adding it (its creator; once)."""
    storage = request.app.state.storage
    begin_write(db)
    row = _load_visible(db, request_id, actor)
    if not corrections_service.can_add_past_file(row, actor):
        raise forbidden("A proposal file can be added here only to a past record you just added.")
    result = files_service.store_file(db, storage, actor, row, upload, version=1, now=now)
    try:
        db.commit()
    except BaseException:
        files_service.discard_saved_file(storage, result["storage_key"])
        raise
    db.expire_all()
    return {"request": _detail(db, _load_visible(db, request_id, actor), actor, now), "message": "Proposal file added.",
            "warnings": []}
