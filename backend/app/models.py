"""
Data model: users & roles, clients, opportunities (+ history), proposal requests (+ history).
Proposal requests are written only through app/services/proposal_requests.py.

Rules enforced here (in addition to the services):
- Nothing is hard-deleted: clients and opportunities have archived_at instead.
- History, proposal files and comments are append-only (ORM guard here; database triggers
  in the migrations).
- An opportunity can only be Lost with a reason (CHECK constraint).
- Money is whole EGP (integers).
- Editable rows carry row_version for optimistic concurrency.
"""

from datetime import date, datetime

from sqlalchemy import (
    JSON, Boolean, CheckConstraint, Date, ForeignKey, Integer, String, Text, UniqueConstraint, event, Index,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .config_domain import (
    BRAND_IDS, CLIENT_TYPES, COMMENT_MAX_LENGTH, EVENT_DATE_PRECISIONS, LOST_REASON_IDS, PROPOSAL_FILE_MAX_BYTES,
    PROPOSAL_FILE_TYPE_IDS, PROPOSAL_STATUSES, REQUEST_EVENT_DATE_PRECISIONS, ROLES, SHARE_CHANNEL_IDS, STAGE_IDS, WORKING_ROLES,
)
from .database import Base, UTCDateTime, utcnow


def _in(column: str, values) -> str:
    quoted = ", ".join(f"'{v}'" for v in values)
    return f"{column} IN ({quoted})"


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False)


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(50), primary_key=True)  # slug, e.g. "u-noha"
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    initials: Mapped[str] = mapped_column(String(4), nullable=False)
    avatar_tone: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    brand: Mapped[str | None] = mapped_column(String(20))  # Account Managers only
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Stored lower-case; unique among ALL accounts (deactivated too). Real addresses arrive with Microsoft sign-in.
    email: Mapped[str] = mapped_column(String(254), nullable=False)
    job_title: Mapped[str | None] = mapped_column(String(200))
    # Privileges belong to the person (the same in every active role). See app/domain/access.py.
    manage_accounts: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    see_analytics: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    send_reminders: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    see_all_brands: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    brings_in_clients: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False)

    roles: Mapped[list["UserRole"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", order_by="UserRole.position"
    )

    __mapper_args__ = {"version_id_col": row_version}
    __table_args__ = (
        CheckConstraint(f"brand IS NULL OR {_in('brand', BRAND_IDS)}", name="ck_users_brand"),
        CheckConstraint("avatar_tone BETWEEN 1 AND 6", name="ck_users_avatar_tone"),
        Index("ux_users_email", "email", unique=True),
    )

    @property
    def role_ids(self) -> list[str]:
        return [r.role for r in self.roles]

    @property
    def privileges(self) -> dict:
        return {"manageAccounts": self.manage_accounts, "seeAnalytics": self.see_analytics,
                "sendReminders": self.send_reminders, "seeAllBrands": self.see_all_brands,
                "bringsInClients": self.brings_in_clients}


class UserRole(Base):
    __tablename__ = "user_roles"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(40), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # first = default role

    user: Mapped[User] = relationship(back_populates="roles")

    __table_args__ = (CheckConstraint(_in("role", ROLES), name="ck_user_roles_role"),)


# ---------------------------------------------------------------------------
# Clients
# ---------------------------------------------------------------------------

class Client(TimestampMixin, Base):
    __tablename__ = "clients"

    id: Mapped[str] = mapped_column(String(12), primary_key=True)  # CL-NNNN, server-generated
    name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    client_type: Mapped[str] = mapped_column(String(20), nullable=False)
    city: Mapped[str | None] = mapped_column(String(100))
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)  # BD relationship owner
    notes: Mapped[str | None] = mapped_column(Text)
    archived_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False)

    owner: Mapped[User] = relationship()
    brands: Mapped[list["ClientBrand"]] = relationship(
        back_populates="client", cascade="all, delete-orphan", order_by="ClientBrand.position"
    )
    opportunities: Mapped[list["Opportunity"]] = relationship(back_populates="client")
    contacts: Mapped[list["ClientContact"]] = relationship(back_populates="client", order_by="ClientContact.id")
    history: Mapped[list["ClientHistory"]] = relationship(back_populates="client", order_by="ClientHistory.id")

    __mapper_args__ = {"version_id_col": row_version}
    __table_args__ = (CheckConstraint(_in("client_type", CLIENT_TYPES), name="ck_clients_type"),)

    @property
    def brand_ids(self) -> list[str]:
        return [b.brand for b in self.brands]

    @property
    def active_contacts(self) -> list["ClientContact"]:
        return [c for c in self.contacts if c.archived_at is None]

    @property
    def primary_contact(self) -> "ClientContact | None":
        return next((c for c in self.active_contacts if c.is_primary), None)


class ClientContact(TimestampMixin, Base):
    """A contact person at a client. At most one active primary per client. Archived, never deleted."""

    __tablename__ = "client_contacts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    title: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(50))
    email: Mapped[str | None] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(Text)
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    archived_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False)

    client: Mapped[Client] = relationship(back_populates="contacts")

    __mapper_args__ = {"version_id_col": row_version}


CLIENT_HISTORY_EVENTS = ("created", "updated", "archived", "owner_transferred", "contact_added", "contact_updated",
                         "contact_archived", "opportunity_added", "clients_merged")


class ClientHistory(Base):
    """Append-only record of every change to a client and its contacts (who, when, what, why)."""

    __tablename__ = "client_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id"), nullable=False, index=True)
    event: Mapped[str] = mapped_column(String(40), nullable=False)
    changed_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(40), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)  # e.g. why the owner was transferred
    details: Mapped[dict | None] = mapped_column(JSON)  # what changed: {"field": {"from": .., "to": ..}, ...}

    client: Mapped[Client] = relationship(back_populates="history")

    __table_args__ = (
        CheckConstraint(_in("event", CLIENT_HISTORY_EVENTS), name="ck_client_history_event"),
        CheckConstraint(_in("role", ROLES), name="ck_client_history_role"),
    )


class ClientBrand(Base):
    __tablename__ = "client_brands"

    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id"), primary_key=True)
    brand: Mapped[str] = mapped_column(String(20), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    client: Mapped[Client] = relationship(back_populates="brands")

    __table_args__ = (CheckConstraint(_in("brand", BRAND_IDS), name="ck_client_brands_brand"),)


# ---------------------------------------------------------------------------
# Opportunities
# ---------------------------------------------------------------------------

class Opportunity(TimestampMixin, Base):
    __tablename__ = "opportunities"

    id: Mapped[str] = mapped_column(String(12), primary_key=True)  # OPP-NNNN, server-generated
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id"), nullable=False, index=True)
    brand: Mapped[str] = mapped_column(String(20), nullable=False)
    service: Mapped[str] = mapped_column(String(40), nullable=False)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    stage: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    estimated_value: Mapped[int | None] = mapped_column(Integer)  # whole EGP; a sales estimate, not revenue
    participants: Mapped[int | None] = mapped_column(Integer)
    # Month-only events store the 1st of the month with precision 'month' (shown as "Mar 2027").
    event_date: Mapped[date | None] = mapped_column(Date)
    event_date_precision: Mapped[str] = mapped_column(String(5), nullable=False, default="day")
    event_end_date: Mapped[date | None] = mapped_column(Date)  # optional, exact dates only
    event_name: Mapped[str | None] = mapped_column(String(80))  # optional, e.g. "Ramadan Iftar Riders – Alex"
    next_action: Mapped[str | None] = mapped_column(String(300))
    next_action_date: Mapped[date | None] = mapped_column(Date)
    lost_reason: Mapped[str | None] = mapped_column(Text)
    archived_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    imported: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)  # from the 2026 tracker
    row_version: Mapped[int] = mapped_column(Integer, nullable=False)

    client: Mapped[Client] = relationship(back_populates="opportunities")
    owner: Mapped[User] = relationship()
    history: Mapped[list["OpportunityHistory"]] = relationship(
        back_populates="opportunity", order_by="OpportunityHistory.id"
    )

    __mapper_args__ = {"version_id_col": row_version}
    __table_args__ = (
        CheckConstraint(_in("brand", BRAND_IDS), name="ck_opportunities_brand"),
        CheckConstraint(_in("stage", STAGE_IDS), name="ck_opportunities_stage"),
        CheckConstraint(_in("event_date_precision", EVENT_DATE_PRECISIONS), name="ck_opportunities_precision"),
        CheckConstraint("estimated_value IS NULL OR estimated_value >= 0", name="ck_opportunities_value"),
        CheckConstraint("participants IS NULL OR participants > 0", name="ck_opportunities_participants"),
        # An opportunity can only be Lost with a reason.
        CheckConstraint(
            "stage <> 'lost' OR (lost_reason IS NOT NULL AND length(trim(lost_reason)) > 0)",
            name="ck_opportunities_lost_reason",
        ),
    )


class OpportunityHistory(Base):
    """Append-only record of every stage change. Never updated or deleted."""

    __tablename__ = "opportunity_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    opportunity_id: Mapped[str] = mapped_column(ForeignKey("opportunities.id"), nullable=False, index=True)
    from_stage: Mapped[str | None] = mapped_column(String(40))  # null on creation
    to_stage: Mapped[str] = mapped_column(String(40), nullable=False)
    changed_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(40), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    # e.g. 'created', 'seed', 'proposal_rejected', 'reopened_after_acceptance'
    reason_code: Mapped[str | None] = mapped_column(String(50))
    # Proposal request that caused the change (if any).
    source_request_id: Mapped[str | None] = mapped_column(
        ForeignKey("proposal_requests.id", name="fk_opp_history_source_request"), nullable=True
    )
    # The reason it became Lost (a LOST_REASONS code from "Mark lost", or the reason given
    # when set Lost directly). Kept here so the opportunity's own history tells the full story.
    lost_reason: Mapped[str | None] = mapped_column(Text)
    # Field edits without a stage change (reason_code 'details_updated'): {"field": {"from": .., "to": ..}}
    details: Mapped[dict | None] = mapped_column(JSON)

    opportunity: Mapped[Opportunity] = relationship(back_populates="history")
    changed_by: Mapped[User] = relationship()

    __table_args__ = (
        CheckConstraint(_in("to_stage", STAGE_IDS), name="ck_opp_history_to_stage"),
        CheckConstraint(f"from_stage IS NULL OR {_in('from_stage', STAGE_IDS)}", name="ck_opp_history_from_stage"),
        CheckConstraint(_in("role", ROLES), name="ck_opp_history_role"),
        CheckConstraint("lost_reason IS NULL OR to_stage = 'lost'", name="ck_opp_history_lost_reason"),
    )


# ---------------------------------------------------------------------------
# Proposal requests
# ---------------------------------------------------------------------------

PROPOSAL_STATUS_IDS = [s["id"] for s in PROPOSAL_STATUSES]


class ProposalRequest(TimestampMixin, Base):
    __tablename__ = "proposal_requests"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)  # PR-YYYY-NNNN, server-generated
    opportunity_id: Mapped[str | None] = mapped_column(ForeignKey("opportunities.id"), index=True)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id"), nullable=False, index=True)
    brand: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    service: Mapped[str] = mapped_column(String(40), nullable=False)
    # Distinct responsibilities (may be the same person, e.g. Mariam El Khayat).
    bd_owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    assigned_am_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    submitted_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    submitted_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    required_by: Mapped[date | None] = mapped_column(Date)  # proposal deadline (calendar date)
    event_date: Mapped[date | None] = mapped_column(Date)  # 1st of month when precision = 'month'
    # 'day' | 'month' | 'unset' ("Date not set yet", no date)
    event_date_precision: Mapped[str] = mapped_column(String(5), nullable=False, default="day")
    event_end_date: Mapped[date | None] = mapped_column(Date)  # optional, exact dates only
    event_name: Mapped[str | None] = mapped_column(String(80))  # optional, e.g. "Ramadan Iftar Riders – Alex"
    follow_up_on: Mapped[date | None] = mapped_column(Date)  # Postponed: when BD follows up
    participants: Mapped[int | None] = mapped_column(Integer)
    requirements_summary: Mapped[str | None] = mapped_column(Text)
    specific_requirements: Mapped[str | None] = mapped_column(Text)
    am_price: Mapped[int | None] = mapped_column(Integer)  # whole EGP; price of the CURRENT version
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    price_change: Mapped[dict | None] = mapped_column(JSON)  # reserved for a later phase
    # Imported from the 2026 tracker: exempt from the price and file rules; never reminded about.
    imported: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    import_row: Mapped[int | None] = mapped_column(Integer)  # the sheet's row (makes the import repeatable)
    # "Pending" without a proposal date: kept out of queues and overdue counts until anyone acts on it.
    needs_review: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    original_status: Mapped[str | None] = mapped_column(String(60))  # the sheet's own status text
    brief_tags: Mapped[list | None] = mapped_column(JSON)  # codes from the "briefTags" list
    # "Set waiting on" by hand (None = automatic from the status); any status change clears it.
    waiting_team: Mapped[str | None] = mapped_column(String(20))
    waiting_user_id: Mapped[str | None] = mapped_column(String(50))  # a user id (checked by the server)
    waiting_reason: Mapped[str | None] = mapped_column(String(60))
    waiting_expected_by: Mapped[date | None] = mapped_column(Date)
    waiting_note: Mapped[str | None] = mapped_column(String(300))
    waiting_set_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    waiting_set_by_id: Mapped[str | None] = mapped_column(String(50))  # a user id (checked by the server)
    # "Update details": when the BD owner last changed the details, and when the assigned AM saw it.
    details_changed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    details_seen_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    # "Mark confirmed" (the event dates go in event_date / event_end_date) and "Event cancelled".
    confirmed_participants: Mapped[int | None] = mapped_column(Integer)
    final_price: Mapped[int | None] = mapped_column(Integer)  # whole EGP; hidden from Marketing and Operations
    venue: Mapped[str | None] = mapped_column(String(200))
    team_notes: Mapped[str | None] = mapped_column(Text)
    event_cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    event_cancel_reason: Mapped[str | None] = mapped_column(String(40))  # an eventCancelReasons code
    event_cancel_note: Mapped[str | None] = mapped_column(String(300))
    # The event's own status once accepted: initial · confirmed · postponed · cancelled (domain/events.py).
    event_status: Mapped[str | None] = mapped_column(String(12))
    event_postpone_reason: Mapped[str | None] = mapped_column(String(40))  # a postponeWhy code
    event_postpone_note: Mapped[str | None] = mapped_column(String(300))
    occasion_id: Mapped[int | None] = mapped_column(Integer)  # an Occasion (Ramadan, Easter...), optional; for the radar
    facilitators_needed: Mapped[int | None] = mapped_column(Integer)  # set by Operations, the AM or the Commercial Head
    from_radar: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)  # "Create request from previous"
    last_updated: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False)

    client: Mapped[Client] = relationship()
    opportunity: Mapped[Opportunity | None] = relationship()
    history: Mapped[list["RequestStatusHistory"]] = relationship(
        back_populates="request", order_by="RequestStatusHistory.seq"
    )
    files: Mapped[list["ProposalFile"]] = relationship(back_populates="request", order_by="ProposalFile.id")
    comments: Mapped[list["RequestComment"]] = relationship(back_populates="request", order_by="RequestComment.id")

    __mapper_args__ = {"version_id_col": row_version}
    __table_args__ = (
        CheckConstraint(_in("brand", BRAND_IDS), name="ck_requests_brand"),
        CheckConstraint(_in("status", PROPOSAL_STATUS_IDS), name="ck_requests_status"),
        CheckConstraint(_in("event_date_precision", REQUEST_EVENT_DATE_PRECISIONS), name="ck_requests_precision"),
        Index("ux_requests_import_row", "import_row", unique=True),
        CheckConstraint("participants IS NULL OR participants > 0", name="ck_requests_participants"),
        CheckConstraint("am_price IS NULL OR am_price > 0", name="ck_requests_am_price"),
        CheckConstraint("version >= 1", name="ck_requests_version"),
    )


class RequestStatusHistory(Base):
    """Append-only record of every status change of a proposal request. Never updated or deleted."""

    __tablename__ = "request_status_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(ForeignKey("proposal_requests.id"), nullable=False, index=True)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)  # 1, 2, 3 ... per request
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    changed_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(40), nullable=False)  # the role the person acted in
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    am_price: Mapped[int | None] = mapped_column(Integer)  # only on Ready for BD entries; null = not recorded
    on_behalf_of_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    previous_required_by: Mapped[date | None] = mapped_column(Date)
    required_by: Mapped[date | None] = mapped_column(Date)
    lost_reason: Mapped[str | None] = mapped_column(String(30))  # only on Rejected entries (LOST_REASONS)
    channel: Mapped[str | None] = mapped_column(String(20))  # only on Shared with Client entries (SHARE_CHANNELS)
    follow_up_on: Mapped[date | None] = mapped_column(Date)  # only on Postponed entries
    reasons: Mapped[list | None] = mapped_column(JSON)  # codes: what's missing / what should change / why postponed
    # From the 2026 tracker or added manually (before IEE); shown with its note, no person's name.
    imported: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # "Correct status (data fix)": a jump outside the normal steps; never notifies (domain/corrections.py).
    corrected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    request: Mapped[ProposalRequest] = relationship(back_populates="history")

    __table_args__ = (
        UniqueConstraint("request_id", "seq", name="uq_request_history_seq"),
        CheckConstraint(_in("status", PROPOSAL_STATUS_IDS), name="ck_request_history_status"),
        CheckConstraint(_in("role", ROLES), name="ck_request_history_role"),
        CheckConstraint("am_price IS NULL OR status = 'ready_for_bd'", name="ck_request_history_price_only_ready"),
        CheckConstraint(f"lost_reason IS NULL OR (status = 'rejected' AND {_in('lost_reason', LOST_REASON_IDS)})",
                        name="ck_request_history_lost_reason"),
        CheckConstraint(f"channel IS NULL OR (status = 'shared_with_client' AND {_in('channel', SHARE_CHANNEL_IDS)})",
                        name="ck_request_history_channel"),
    )


class RequestEvent(Base):
    """
    Append-only events on a request that are not status changes, e.g. its BD owner being
    transferred with the client. Kept apart from the status history so status rules are untouched.
    """

    __tablename__ = "request_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(ForeignKey("proposal_requests.id"), nullable=False, index=True)
    event: Mapped[str] = mapped_column(String(40), nullable=False)
    changed_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(40), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    from_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    to_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    note: Mapped[str | None] = mapped_column(Text)
    details: Mapped[dict | None] = mapped_column(JSON)  # e.g. {"changes": [{field, label, from, to}], "note"}

    __table_args__ = (
        CheckConstraint("event IN ('bd_owner_transferred', 'assigned_am_changed', 'client_merged', 'waiting_on_set', "
                        "'waiting_on_cleared', 'details_updated', 'details_seen', 'reminder_sent', "
                        "'event_date_changed', 'event_cancelled', 'event_status_set', 'event_confirmed', "
                        "'event_postponed', 'facilitators_needed_set')",
                        name="ck_request_events_event"),
        CheckConstraint(_in("role", ROLES), name="ck_request_events_role"),
    )


class ProposalFile(Base):
    """
    One uploaded proposal file (PDF or PPTX) for one version of a request. Append-only: uploading
    again for the same version adds a new row that replaces the previous one (replaces_file_id);
    the latest row per version is the current file. The bytes live in file storage under a
    random server-generated key, never under the uploaded name.
    """

    __tablename__ = "proposal_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(ForeignKey("proposal_requests.id"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    file_type: Mapped[str] = mapped_column(String(10), nullable=False)  # detected from the content
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)  # display only
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    uploaded_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(40), nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    replaces_file_id: Mapped[int | None] = mapped_column(ForeignKey("proposal_files.id"))

    request: Mapped[ProposalRequest] = relationship(back_populates="files")

    __table_args__ = (
        CheckConstraint(_in("file_type", PROPOSAL_FILE_TYPE_IDS), name="ck_proposal_files_type"),
        CheckConstraint(f"size_bytes > 0 AND size_bytes <= {PROPOSAL_FILE_MAX_BYTES}", name="ck_proposal_files_size"),
        CheckConstraint("version >= 1", name="ck_proposal_files_version"),
        CheckConstraint(_in("role", WORKING_ROLES), name="ck_proposal_files_role"),
    )


class RequestComment(Base):
    """A plain-text comment on a request. Append-only (no edit, no delete)."""

    __tablename__ = "request_comments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(ForeignKey("proposal_requests.id"), nullable=False, index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(40), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    # comment · question · answer · answered (domain/conversation.py); answering adds a row (append-only).
    kind: Mapped[str] = mapped_column(String(10), nullable=False, default="comment", server_default="comment")
    about: Mapped[str | None] = mapped_column(String(40))  # a questionAbout code
    parent_id: Mapped[int | None] = mapped_column(Integer)  # the question an answer belongs to
    reasons: Mapped[list | None] = mapped_column(JSON)  # "Change needed": whatShouldChange codes (about = client | internal)

    request: Mapped[ProposalRequest] = relationship(back_populates="comments")

    __table_args__ = (
        CheckConstraint(f"length(body) BETWEEN 1 AND {COMMENT_MAX_LENGTH}", name="ck_request_comments_length"),
        CheckConstraint(_in("role", ROLES), name="ck_request_comments_role"),
    )


class AppendOnlyError(RuntimeError):
    pass


def _forbid(table: str, verb: str):
    def handler(mapper, connection, target):
        raise AppendOnlyError(f"{table} is append-only: entries cannot be {verb}.")
    return handler


# ---------------------------------------------------------------------------
# Accounts and routing history; brand routing
# ---------------------------------------------------------------------------

USER_HISTORY_EVENTS = ("created", "updated", "deactivated", "reactivated")


class UserHistory(Base):
    """Append-only: every change to an account (who, when, what changed old -> new)."""

    __tablename__ = "user_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    event: Mapped[str] = mapped_column(String(30), nullable=False)
    changed_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(40), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    details: Mapped[dict | None] = mapped_column(JSON)

    __table_args__ = (
        CheckConstraint(_in("event", USER_HISTORY_EVENTS), name="ck_user_history_event"),
        CheckConstraint(_in("role", ROLES), name="ck_user_history_role"),
    )


class ListOption(Base):
    """
    Settings' changes to a dropdown list (domain/lists.py): a row for a default code renames or hides
    it; a row for a new code adds it. Never deleted (a used code keeps its label).
    """

    __tablename__ = "list_options"

    list_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    code: Mapped[str] = mapped_column(String(40), primary_key=True)
    label: Mapped[str] = mapped_column(String(60), nullable=False)
    hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)


class BrandRouting(Base):
    """Which Account Manager receives each brand's NEW proposal requests (changed in Settings)."""

    __tablename__ = "brand_routing"

    brand: Mapped[str] = mapped_column(String(20), primary_key=True)
    am_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False)

    __mapper_args__ = {"version_id_col": row_version}
    __table_args__ = (CheckConstraint(_in("brand", BRAND_IDS), name="ck_brand_routing_brand"),)


class RoutingHistory(Base):
    """Append-only: every routing change."""

    __tablename__ = "routing_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    brand: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    from_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    to_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    changed_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(40), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)

    __table_args__ = (
        CheckConstraint(_in("brand", BRAND_IDS), name="ck_routing_history_brand"),
        CheckConstraint(_in("role", ROLES), name="ck_routing_history_role"),
    )


for _model in (OpportunityHistory, RequestStatusHistory, ProposalFile, RequestComment, ClientHistory, RequestEvent,
               UserHistory, RoutingHistory):
    event.listen(_model, "before_update", _forbid(_model.__tablename__, "changed"))
    event.listen(_model, "before_delete", _forbid(_model.__tablename__, "deleted"))


# ---------------------------------------------------------------------------
# Server-side bookkeeping
# ---------------------------------------------------------------------------

class IdCounter(Base):
    """Last number issued per sequence ('client', 'opportunity', later 'request:2026')."""

    __tablename__ = "id_counters"

    name: Mapped[str] = mapped_column(String(40), primary_key=True)
    last_value: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class AppMeta(Base):
    """Key/value facts about this database, e.g. data_kind = 'demo' | 'real'."""

    __tablename__ = "app_meta"

    key: Mapped[str] = mapped_column(String(50), primary_key=True)
    value: Mapped[str] = mapped_column(String(200), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False)


__all__ = [
    "AppMeta", "AppendOnlyError", "Client", "ClientBrand", "ClientContact", "ClientHistory", "RequestEvent", "IdCounter", "Opportunity",
    "OpportunityHistory", "ProposalFile", "ProposalRequest", "RequestComment", "RequestStatusHistory", "User",
    "UserRole", "UserHistory", "BrandRouting", "RoutingHistory",
]


class Notification(Base):
    """
    One in-app notification for one person (a reminder, "waiting on you"). Only read_at ever changes;
    the Notifications phase extends this (more kinds, preferences). No email, pop-ups or sounds.
    """

    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(200))
    request_ids: Mapped[list | None] = mapped_column(JSON)
    actor_id: Mapped[str | None] = mapped_column(String(50))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    # The role it is for (None: any of the person's roles). Someone with two roles sees each role's own.
    role: Mapped[str | None] = mapped_column(String(30))

    __table_args__ = (CheckConstraint("kind IN ('reminder', 'waiting_on', 'message', 'event', 'activity', 'task')",
                                      name="ck_notifications_kind"),)


class RequestRead(Base):
    """When a person last opened a request IN A ROLE: "New for you" is everything after it. Updated in place."""

    __tablename__ = "request_reads"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(30), primary_key=True)
    request_id: Mapped[str] = mapped_column(ForeignKey("proposal_requests.id"), primary_key=True)
    read_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)


# ---------------------------------------------------------------------------
# Repeat-client radar (occasions) and HR staffing (facilitators)
# ---------------------------------------------------------------------------

class Occasion(Base):
    """Ramadan, Eid, Easter, Summer season...: a name; its dates per year are OccasionPeriod rows (Settings)."""

    __tablename__ = "occasions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    archived_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class OccasionPeriod(Base):
    """One year's dates of an occasion (entered by the Commercial Head; nothing is hard-coded)."""

    __tablename__ = "occasion_periods"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    occasion_id: Mapped[int] = mapped_column(ForeignKey("occasions.id"), nullable=False, index=True)
    starts_on: Mapped[date] = mapped_column(Date, nullable=False)
    ends_on: Mapped[date] = mapped_column(Date, nullable=False)
    updated_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)

    __table_args__ = (CheckConstraint("ends_on >= starts_on", name="ck_occasion_periods_dates"),)


class RadarDismissal(Base):
    """A "Not this time" on a radar item: hidden until `until` (its next occurrence), with an optional reason."""

    __tablename__ = "radar_dismissals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id"), nullable=False, index=True)
    signal: Mapped[str] = mapped_column(String(60), nullable=False)  # "occasion:<id>" or "rhythm"
    until: Mapped[date] = mapped_column(Date, nullable=False)
    reason: Mapped[str | None] = mapped_column(String(300))
    dismissed_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    dismissed_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)


class StaffingRatio(Base):
    """One facilitator per N participants, per brand and service ("<brand>:<service>"): a suggestion only."""

    __tablename__ = "staffing_ratios"

    service_key: Mapped[str] = mapped_column(String(80), primary_key=True)
    per_facilitator: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)

    __table_args__ = (CheckConstraint("per_facilitator > 0", name="ck_staffing_ratios_positive"),)


class Facilitator(Base):
    """A facilitator HR books for events (they never log in). Archived, never deleted."""

    __tablename__ = "facilitators"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    phone: Mapped[str] = mapped_column(String(40), nullable=False)
    reference: Mapped[str | None] = mapped_column(String(60))  # national ID or other reference
    skills: Mapped[list | None] = mapped_column(JSON)  # facilitatorSkills codes
    brands: Mapped[list | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="active", server_default="active")
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    __table_args__ = (CheckConstraint("status IN ('active', 'inactive')", name="ck_facilitators_status"),)


class FacilitatorNote(Base):
    """HR's notes on a facilitator; each change is a new row (the history of edits)."""

    __tablename__ = "facilitator_notes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    facilitator_id: Mapped[int] = mapped_column(ForeignKey("facilitators.id"), nullable=False, index=True)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)


class FacilitatorAssignment(Base):
    """A facilitator booked on an event; removing keeps the row (removed_at)."""

    __tablename__ = "facilitator_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(ForeignKey("proposal_requests.id"), nullable=False, index=True)
    facilitator_id: Mapped[int] = mapped_column(ForeignKey("facilitators.id"), nullable=False, index=True)
    assigned_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    assigned_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    removed_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    removed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class FacilitatorRating(Base):
    """One person's rating of one facilitator on one event (editable for 7 days; each change kept in history)."""

    __tablename__ = "facilitator_ratings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(ForeignKey("proposal_requests.id"), nullable=False, index=True)
    facilitator_id: Mapped[int] = mapped_column(ForeignKey("facilitators.id"), nullable=False, index=True)
    rater_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    stars: Mapped[int | None] = mapped_column(Integer)  # none when they did not attend
    attended: Mapped[bool] = mapped_column(Boolean, nullable=False)
    feedback: Mapped[str | None] = mapped_column(String(1000))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)

    __table_args__ = (
        UniqueConstraint("request_id", "facilitator_id", "rater_id", name="uq_facilitator_rating_once"),
        CheckConstraint("stars IS NULL OR (stars BETWEEN 1 AND 5)", name="ck_facilitator_ratings_stars"),
    )


class FacilitatorRatingHistory(Base):
    """Every version of a rating (the first and each edit)."""

    __tablename__ = "facilitator_rating_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    rating_id: Mapped[int] = mapped_column(ForeignKey("facilitator_ratings.id"), nullable=False, index=True)
    stars: Mapped[int | None] = mapped_column(Integer)
    attended: Mapped[bool] = mapped_column(Boolean, nullable=False)
    feedback: Mapped[str | None] = mapped_column(String(1000))
    changed_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)


class Todo(Base):
    """A personal to-do: private to its owner (never shown to anyone else), soft-deleted, never notified."""

    __tablename__ = "todos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    text: Mapped[str] = mapped_column(String(300), nullable=False)
    due_on: Mapped[date | None] = mapped_column(Date)
    link_kind: Mapped[str | None] = mapped_column(String(10))  # client · request · event
    link_id: Mapped[str | None] = mapped_column(String(16))
    done_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    __table_args__ = (
        CheckConstraint("link_kind IS NULL OR link_kind IN ('client', 'request', 'event')", name="ck_todos_link_kind"),
        CheckConstraint("(link_kind IS NULL) = (link_id IS NULL)", name="ck_todos_link_pair"),
    )
