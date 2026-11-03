"""
API response shapes. JSON uses camelCase to match the frontend's field names
(e.g. clientId, eventDatePrecision). Timestamps are UTC ISO-8601 ("...Z").
Event dates are "YYYY-MM-DD", or "YYYY-MM" when only the month is known.
"""

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from .models import Client, Opportunity, OpportunityHistory, User


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


def event_date_out(value: date | None, precision: str) -> str | None:
    if value is None:
        return None
    return value.strftime("%Y-%m") if precision == "month" else value.isoformat()


# ---------- Users ----------

class UserOut(ApiModel):
    id: str
    name: str
    initials: str
    avatar_tone: int
    brand: str | None
    roles: list[str]
    active: bool
    email: str
    job_title: str | None
    privileges: dict
    row_version: int

    @classmethod
    def of(cls, user: User) -> "UserOut":
        return cls(id=user.id, name=user.name, initials=user.initials, avatar_tone=user.avatar_tone,
                   brand=user.brand, roles=user.role_ids, active=user.active, email=user.email,
                   job_title=user.job_title, privileges=user.privileges, row_version=user.row_version)


class Permission(ApiModel):
    allowed: bool
    reason: str | None = None


class MeOut(ApiModel):
    user: UserOut
    active_role: str
    create_requests: Permission
    create_clients: Permission
    privileges: dict  # the person's switches (the same in every role)
    pages: dict  # which pages this person gets in this role (menu and page access)
    scopes: list[str]  # Proposal Tracker scopes in this role
    data_kind: str | None = None  # 'real' | 'demo' | 'presentation' (a copy of the real data): the header label


class UserList(ApiModel):
    items: list[UserOut]
    total: int


# ---------- Clients ----------

class ContactOut(ApiModel):
    name: str | None
    title: str | None
    phone: str | None
    email: str | None


class ContactPersonOut(ApiModel):
    id: int
    name: str
    title: str | None
    phone: str | None
    email: str | None
    notes: str | None
    is_primary: bool
    row_version: int


class ClientOut(ApiModel):
    id: str
    name: str
    type: str
    brands: list[str]
    city: str | None
    contact: ContactOut  # the primary contact (empty when there is none)
    contacts: list[ContactPersonOut]  # active (not archived) contact people
    owner: str
    notes: str | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    row_version: int

    @classmethod
    def of(cls, c: Client) -> "ClientOut":
        return cls(
            id=c.id, name=c.name, type=c.client_type, brands=c.brand_ids, city=c.city,
            contact=ContactOut(**{k: getattr(c.primary_contact, k, None) for k in ("name", "title", "phone", "email")}),
            contacts=[ContactPersonOut(id=p.id, name=p.name, title=p.title, phone=p.phone, email=p.email, notes=p.notes,
                                       is_primary=p.is_primary, row_version=p.row_version) for p in c.active_contacts],
            owner=c.owner_id, notes=c.notes, archived_at=c.archived_at,
            created_at=c.created_at, updated_at=c.updated_at, row_version=c.row_version,
        )


class ClientList(ApiModel):
    items: list[ClientOut]
    total: int


# ---------- Opportunities ----------

class OpportunityHistoryOut(ApiModel):
    id: int
    from_stage: str | None
    to_stage: str
    changed_by: str | None  # None on imported entries ("Imported from the 2026 tracker")
    imported: bool = False
    role: str
    changed_at: datetime
    note: str | None
    reason_code: str | None
    source_request_id: str | None
    lost_reason: str | None
    details: dict | None = None

    @classmethod
    def of(cls, h: OpportunityHistory) -> "OpportunityHistoryOut":
        imported = h.reason_code == "imported"
        return cls(id=h.id, from_stage=h.from_stage, to_stage=h.to_stage, imported=imported,
                   changed_by=None if imported else h.changed_by_id, role=h.role,
                   changed_at=h.changed_at, note=h.note, reason_code=h.reason_code,
                   source_request_id=h.source_request_id, lost_reason=h.lost_reason, details=h.details)


class OpportunityOut(ApiModel):
    id: str
    client_id: str
    brand: str
    service: str
    owner: str
    stage: str
    estimated_value: int | None
    participants: int | None
    event_date: str | None
    event_date_precision: str
    event_end_date: date | None = None
    event_name: str | None = None
    imported: bool = False
    next_action: str | None
    next_action_date: date | None
    lost_reason: str | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    row_version: int

    @classmethod
    def of(cls, o: Opportunity, **extra) -> "OpportunityOut":
        return cls(
            id=o.id, client_id=o.client_id, brand=o.brand, service=o.service, owner=o.owner_id, stage=o.stage,
            estimated_value=o.estimated_value, participants=o.participants,
            event_date=event_date_out(o.event_date, o.event_date_precision),
            event_date_precision=o.event_date_precision, event_end_date=o.event_end_date, event_name=o.event_name, imported=o.imported,
            next_action=o.next_action,
            next_action_date=o.next_action_date, lost_reason=o.lost_reason, archived_at=o.archived_at,
            created_at=o.created_at, updated_at=o.updated_at, row_version=o.row_version, **extra,
        )


class OpportunityDetailOut(OpportunityOut):
    history: list[OpportunityHistoryOut]


class OpportunityList(ApiModel):
    items: list[OpportunityOut]
    total: int
