"""
Merge clients into one: python -m app.merge_clients

    python -m app.merge_clients --into Talabat --from "Ramadan Riders Football Tournament - Cairo" CL-0011 ...
        [--event-name "<client or request id>=<event name>" ...] [--as u-noha] [--apply]

Without --apply it is a dry run: it prints every request, opportunity, contact and history entry
that would move, and the clients that would be archived, and changes nothing.
With --apply, in ONE transaction:
  - the requests and opportunities of each merged client move to the target, with the event names
    given (--event-name SOURCE=NAME applies to all of a client's requests and opportunities;
    --event-name PR-…=NAME to one request and its opportunity);
  - contacts move too (a moved contact is never the target's main contact);
  - each moved request records "Client changed from X to <target> — merged by <name>";
  - the target records which clients were merged into it;
  - each emptied client is ARCHIVED with "Merged into <target>" (never deleted: history is kept).
Requests keep their BD owner and opportunities their owner (as recorded); closed requests are not reopened.

Refuses: a client into itself, an archived target or source, a target whose owner may not own
clients, and moving a request or opportunity of a brand the target does not work with.
Clients are given by id (CL-0009) or exact name (any case). The database is the real one by
default (DATABASE_URL like setup_real); tests pass their own.
"""

import argparse
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .config_domain import BRANDS
from .database import begin_write, make_engine, make_sessionmaker, utcnow
from .domain.access import can_own_clients
from .domain.request_form import EVENT_NAME_MAX
from .migrations_check import SchemaNotReadyError, check_schema
from .models import (Client, ClientContact, ClientHistory, Opportunity, OpportunityHistory, ProposalRequest,
                     RequestEvent, RequestStatusHistory, User)
from .services.proposal_requests import _users
from .setup_real import real_database_url

BRAND_NAMES = {b["id"]: b["name"] for b in BRANDS}


class MergeRefused(RuntimeError):
    """The merge cannot be done as asked. Nothing was changed."""


@dataclass
class Plan:
    target: Client
    sources: list[Client]
    requests: list[ProposalRequest] = field(default_factory=list)
    opportunities: list[Opportunity] = field(default_factory=list)
    contacts: list[ClientContact] = field(default_factory=list)
    names: dict = field(default_factory=dict)  # request or opportunity id -> new event name (absent: unchanged)
    history: Counter = field(default_factory=Counter)  # what travels with them / stays


def _find(db: Session, ref: str) -> Client:
    ref = ref.strip()
    found = db.get(Client, ref)
    if found:
        return found
    matches = db.scalars(select(Client).where(func.lower(Client.name) == ref.lower())).all()
    if not matches:
        raise MergeRefused(f'No client "{ref}". Use the client id (CL-…) or the exact name.')
    if len(matches) > 1:
        raise MergeRefused(f'More than one client is named "{ref}" ({", ".join(c.id for c in matches)}). Use the id.')
    return matches[0]


def _event_names(pairs: list[str]) -> list[tuple[str, str]]:
    out = []
    for pair in pairs:
        key, sep, name = pair.partition("=")
        if not sep or not key.strip() or not name.strip():
            raise MergeRefused(f'--event-name needs "<client or request>=<event name>", got "{pair}".')
        name = " ".join(name.split())
        if len(name) > EVENT_NAME_MAX:
            raise MergeRefused(f'Event name "{name}" is longer than {EVENT_NAME_MAX} characters.')
        out.append((key.strip(), name))
    return out


def build_plan(db: Session, target_ref: str, source_refs: list[str], event_names: list[str]) -> Plan:
    target = _find(db, target_ref)
    sources = []
    for ref in source_refs:
        source = _find(db, ref)
        if source.id == target.id:
            raise MergeRefused(f"{target.name} cannot be merged into itself.")
        if source.id in (s.id for s in sources):
            raise MergeRefused(f"{source.name} is listed twice.")
        if source.archived_at:
            raise MergeRefused(f"{source.name} ({source.id}) is archived already.")
        sources.append(source)
    if not sources:
        raise MergeRefused("Name at least one client to merge (--from).")
    if target.archived_at:
        raise MergeRefused(f"{target.name} ({target.id}) is archived; choose an active client to merge into.")
    users = _users(db)
    if not can_own_clients(users.get(target.owner_id)):
        raise MergeRefused(f"{target.name}'s owner ({target.owner_id}) can no longer own clients; transfer it first.")

    ids = [s.id for s in sources]
    plan = Plan(target, sources)
    plan.requests = db.scalars(select(ProposalRequest).where(ProposalRequest.client_id.in_(ids))
                               .order_by(ProposalRequest.id)).all()
    plan.opportunities = db.scalars(select(Opportunity).where(Opportunity.client_id.in_(ids)).order_by(Opportunity.id)).all()
    plan.contacts = db.scalars(select(ClientContact).where(ClientContact.client_id.in_(ids)).order_by(ClientContact.id)).all()

    brands = set(target.brand_ids)
    for item in [*plan.requests, *plan.opportunities]:
        if item.brand not in brands:
            raise MergeRefused(f"{item.id} is {BRAND_NAMES.get(item.brand, item.brand)}, but {target.name} works only with "
                               f"{', '.join(BRAND_NAMES.get(b, b) for b in sorted(brands)) or 'no brand'}. "
                               "Add the brand to the client first.")

    by_source = {s.id: s for s in sources}
    request_ids = {r.id for r in plan.requests}
    for key, name in _event_names(event_names):
        source = by_source.get(key) or next((s for s in sources if s.name.lower() == key.lower()), None)
        if source:
            for r in plan.requests:
                if r.client_id == source.id:
                    plan.names[r.id] = name
            for o in plan.opportunities:
                if o.client_id == source.id:
                    plan.names[o.id] = name
        elif key in request_ids:
            r = next(r for r in plan.requests if r.id == key)
            plan.names[r.id] = name
            if r.opportunity_id:
                plan.names[r.opportunity_id] = name
        else:
            raise MergeRefused(f'--event-name "{key}" is neither a client being merged nor one of its requests.')

    count = lambda model, column, values: db.scalar(select(func.count()).select_from(model).where(column.in_(values))) or 0
    plan.history["request status entries (move with their requests)"] = count(
        RequestStatusHistory, RequestStatusHistory.request_id, list(request_ids))
    plan.history["other request events (move with their requests)"] = count(
        RequestEvent, RequestEvent.request_id, list(request_ids))
    plan.history["opportunity entries (move with their opportunities)"] = count(
        OpportunityHistory, OpportunityHistory.opportunity_id, [o.id for o in plan.opportunities])
    plan.history["client entries (stay on the archived clients)"] = count(ClientHistory, ClientHistory.client_id, ids)
    return plan


def apply_plan(db: Session, plan: Plan, actor_id: str, now: datetime) -> None:
    actor = db.get(User, actor_id)
    if actor is None:
        raise MergeRefused(f"Unknown account {actor_id!r} for --as.")
    role = actor.role_ids[0]
    target = plan.target
    names = {s.id: s.name for s in plan.sources}
    for r in plan.requests:
        note = f"Client changed from {names[r.client_id]} to {target.name} — merged by {actor.name}"
        db.add(RequestEvent(request_id=r.id, event="client_merged", changed_by_id=actor.id, role=role, changed_at=now,
                            note=note))
        r.client_id = target.id
        if r.id in plan.names:
            r.event_name = plan.names[r.id]
        r.updated_at = now
    for o in plan.opportunities:
        o.client_id = target.id
        if o.id in plan.names:
            o.event_name = plan.names[o.id]
        o.updated_at = now
    has_primary = any(c.is_primary and not c.archived_at for c in target.contacts)
    for c in plan.contacts:
        c.client_id = target.id
        if has_primary:
            c.is_primary = False
        has_primary = has_primary or (c.is_primary and not c.archived_at)
        c.updated_at = now
    db.add(ClientHistory(client_id=target.id, event="clients_merged", changed_by_id=actor.id, role=role, changed_at=now,
                         details={"mergedFrom": [{"id": s.id, "name": s.name} for s in plan.sources],
                                  "requests": [r.id for r in plan.requests],
                                  "opportunities": [o.id for o in plan.opportunities],
                                  "contacts": len(plan.contacts)}))
    target.updated_at = now
    for s in plan.sources:
        s.archived_at = now
        s.updated_at = now
        db.add(ClientHistory(client_id=s.id, event="archived", changed_by_id=actor.id, role=role, changed_at=now,
                             reason=f"Merged into {target.name}", details={"mergedInto": target.id}))
    db.flush()


def report(plan: Plan, applied: bool) -> str:
    lines = []
    add = lines.append
    t = plan.target
    add(f"Merge into: {t.name} ({t.id}) · owner {t.owner_id} · brands "
        f"{', '.join(BRAND_NAMES.get(b, b) for b in t.brand_ids)}")
    add("Clients merged (each archived with \"Merged into " + t.name + "\", never deleted):")
    for s in plan.sources:
        add(f"  {s.id}  {s.name}")
    add(f"Requests to move: {len(plan.requests)}")
    for r in plan.requests:
        new = plan.names.get(r.id, r.event_name)
        change = f'"{r.event_name or "—"}" -> "{new or "—"}"' if new != r.event_name else f'"{new or "—"}" (unchanged)'
        add(f"  {r.id}  {r.status:<20} BD owner {r.bd_owner_id:<18} event name {change}")
    add(f"Opportunities to move: {len(plan.opportunities)}")
    for o in plan.opportunities:
        new = plan.names.get(o.id, o.event_name)
        add(f"  {o.id}  {o.stage:<20} owner {o.owner_id:<18} event name \"{new or '—'}\"")
    add(f"Contacts to move: {len(plan.contacts)}")
    for c in plan.contacts:
        add(f"  {c.name}" + (" (main contact)" if c.is_primary else ""))
    add("History:")
    for label, n in plan.history.items():
        add(f"  {n:>3}  {label}")
    add(f"  New entries: {len(plan.requests)} on the moved requests (\"Client changed from … to {t.name} — merged by …\"), "
        f"1 on {t.name}, {len(plan.sources)} on the archived clients.")
    add("")
    add("APPLIED in one transaction." if applied else "Dry run: nothing was changed. Run again with --apply to merge.")
    return "\n".join(lines)


def run(target: str, sources: list[str], *, database_url: str, event_names=(), apply: bool = False,
        actor: str = "u-noha", now: datetime | None = None) -> str:
    engine = make_engine(database_url)
    try:
        if apply:
            try:
                check_schema(engine, database_url)
            except SchemaNotReadyError as exc:
                raise MergeRefused(f"{exc} (For the real database: python -m app.setup_real.)") from None
        with make_sessionmaker(engine)() as db:
            if apply:
                begin_write(db)
            plan = build_plan(db, target, sources, list(event_names))
            # Load what the report and apply need before anything moves.
            db.scalars(select(Client).where(Client.id == plan.target.id).options(selectinload(Client.contacts))).all()
            if not apply:
                return report(plan, applied=False)
            text = report(plan, applied=True)
            apply_plan(db, plan, actor, now or utcnow())
            db.commit()
            return text
    finally:
        engine.dispose()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.merge_clients", description="Merge clients into one.")
    parser.add_argument("--into", required=True, help="the client to keep (id or exact name)")
    parser.add_argument("--from", dest="sources", nargs="+", required=True, help="the clients to merge into it")
    parser.add_argument("--event-name", dest="event_names", action="append", default=[],
                        help='"<client or request id>=<event name>" for the moved requests (repeatable)')
    parser.add_argument("--as", dest="actor", default="u-noha", help="who does the merge (recorded in history)")
    parser.add_argument("--apply", action="store_true", help="merge (without it: dry run, nothing changes)")
    args = parser.parse_args(argv)
    try:
        print(run(args.into, args.sources, database_url=real_database_url(), event_names=args.event_names,
                  apply=args.apply, actor=args.actor))
    except MergeRefused as exc:
        print(f"Refused: {exc} Nothing was changed.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
