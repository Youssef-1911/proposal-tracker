"""
Puts the requests ALREADY imported from the 2026 tracker on the current mapping, without re-importing:

    python -m app.apply_tracker_mapping --target test                 dry run on the test copy
    python -m app.apply_tracker_mapping --target test --apply         apply it to the test copy
    python -m app.apply_tracker_mapping --target real [--apply]       the same on the real data
    --file <tracker.xlsx>   recommended: the sheet's proposal / Actual / Expected dates for the history steps
                            (without it: the brief date and the stored event date are used)

The mapping (import_tracker.STATUS): Event Completed / Approved -> Confirmed · Canceled -> Lost ·
Postponed -> Postponed (follow-up in 7 days) · Preparing Phase -> In Progress · Pending -> Shared with Client.
"Needs review" is cleared everywhere. Each request's imported history is rebuilt as steps from the sheet's
dates ("From the 2026 tracker (row #N)"); its opportunity is moved to match.

Anything added in the app is kept: a request with ANY entry made in the app (a status step, a message, a
file or an event change) keeps its status and history (it is listed as "kept"). Test = the persistent test
copy (backend/eventflow-test.db, python -m app.test_copy); real = the real database, only when asked for explicitly.
All in one transaction, or nothing.
"""

import argparse
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session, selectinload

from .clock import cairo_today_iso
from .database import begin_write, make_engine, make_sessionmaker, utcnow
from .identity import Actor
from .import_tracker import (
    FOLLOW_UP_DAYS, STATUS, STATUS_LABELS, Row, history_entries, read_rows, sheet_history,
)
from .migrations_check import SchemaNotReadyError, check_schema
from .models import Opportunity, ProposalRequest, RequestComment, RequestEvent, RequestStatusHistory, User
from .test_copy import TEST_DB, test_url
from .services.opportunities import set_opportunity_stage
from .setup_real import real_database_url

LABELS = {**STATUS_LABELS, "closed_unrecorded": "Closed · outcome not recorded", "closed_postponed": "Closed · postponed",
          "submitted": "Submitted", "ready_for_bd": "Ready for BD", "awaiting_bd_info": "Awaiting BD info",
          "revision_requested": "Revision requested", "cancelled": "Cancelled", "draft": "Draft"}


class MappingRefused(RuntimeError):
    """Nothing was changed."""


@dataclass
class Change:
    row: ProposalRequest
    kind: str  # update | unchanged | kept | unknown
    to: str | None = None
    stage: str | None = None
    steps: list | None = None


def _stored_row(r: ProposalRequest) -> Row:
    """The sheet row as far as the database still knows it (no proposal / Actual dates)."""
    brief = (r.submitted_at.date() if r.submitted_at else None) or r.created_at.date()
    event = r.event_end_date or r.event_date
    return Row(number=r.import_row, sender="", brief_date=brief, client="", brief="", brand_code="", deadline=r.required_by,
               proposal_date=None, expected=event, actual=None, status=r.original_status or "")


def plan(db: Session, sheet: dict[int, Row] | None, today: date) -> list[Change]:
    rows = db.scalars(select(ProposalRequest).where(ProposalRequest.import_row.is_not(None))
                      .options(selectinload(ProposalRequest.history), selectinload(ProposalRequest.files))
                      .order_by(ProposalRequest.import_row)).all()
    talked = set(db.scalars(select(RequestComment.request_id)).all())
    evented = set(db.scalars(select(RequestEvent.request_id)).all())
    out = []
    for r in rows:
        mapped = STATUS.get((r.original_status or "").strip().lower())
        if mapped is None:
            out.append(Change(r, "unknown"))
            continue
        in_app = any(not h.imported for h in r.history) or r.files or r.id in talked or r.id in evented
        if in_app:
            out.append(Change(r, "kept", r.status))
            continue
        source = (sheet or {}).get(r.import_row) or _stored_row(r)
        steps = sheet_history(source, mapped[0], today)
        same = (r.status == mapped[0] and not r.needs_review
                and [h.status for h in sorted(r.history, key=lambda h: h.seq)] == [s for s, _ in steps])
        out.append(Change(r, "unchanged" if same else "update", mapped[0], mapped[1], steps))
    return out


def _lift_delete_guard(db: Session) -> list[str]:
    """History is append-only (a trigger refuses deletes). Lifted only inside this transaction; restored after."""
    triggers = db.execute(text("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' "
                               "AND tbl_name = 'request_status_history' AND sql LIKE '%DELETE%'")).all()
    for name, _ in triggers:
        db.execute(text(f'DROP TRIGGER "{name}"'))
    return [sql for _, sql in triggers]


def apply(db: Session, changes: list[Change], actor_id: str, today: date, now: datetime) -> None:
    me = db.get(User, actor_id)
    if me is None:
        raise MappingRefused(f"Unknown account {actor_id!r} for --as.")
    actor = Actor(me.id, me.role_ids[0])
    updates = [c for c in changes if c.kind == "update"]
    guard = _lift_delete_guard(db)
    ids = [c.row.id for c in updates]
    if ids:  # only imported entries of requests nobody touched in the app (the app never deletes history itself)
        db.execute(delete(RequestStatusHistory).where(RequestStatusHistory.request_id.in_(ids),
                                                      RequestStatusHistory.imported.is_(True)))
    for sql in guard:
        db.execute(text(sql))
    for c in updates:
        db.expire(c.row, ["history"])
    for c in updates:
        r = c.row
        follow_up = date.fromordinal(today.toordinal() + FOLLOW_UP_DAYS) if c.to == "postponed" else None
        for h in history_entries(c.steps, r.import_row, actor, follow_up):
            r.history.append(h)
        r.status = c.to
        r.needs_review = False
        r.follow_up_on = follow_up
        r.event_status = "confirmed" if c.to == "accepted" else None
        for name in ("waiting_team", "waiting_user_id", "waiting_reason", "waiting_expected_by", "waiting_note",
                     "waiting_set_at", "waiting_set_by_id"):
            setattr(r, name, None)
        r.last_updated = r.history[-1].changed_at
        r.updated_at = now
        if r.opportunity_id:
            opp = db.get(Opportunity, r.opportunity_id)
            if opp is not None and opp.stage != c.stage:
                set_opportunity_stage(db, opp, c.stage, actor=actor, note="The 2026 tracker mapping",
                                      lost_reason="not_recorded" if c.stage == "lost" else None, reason_code="imported",
                                      source_request_id=r.id, now=now)
    for c in changes:
        if c.kind in ("kept", "unchanged") and c.row.needs_review:
            c.row.needs_review = False
    db.flush()


def report(changes: list[Change], with_file: bool, applied: bool) -> str:
    kinds = Counter(c.kind for c in changes)
    lines = [f"Imported requests: {len(changes)}",
             f"  To update: {kinds['update']} · already on the mapping: {kinds['unchanged']} · "
             f"kept (changed in the app): {kinds['kept']} · unknown sheet status: {kinds['unknown']}",
             "", "Status (now -> mapping):"]
    moves = Counter((LABELS.get(c.row.status, c.row.status), LABELS.get(c.to, c.to)) for c in changes if c.kind == "update")
    for (a, b), n in sorted(moves.items()):
        lines.append(f"  {a:<32} -> {b:<20} {n:>4}")
    kept = [c for c in changes if c.kind == "kept"]
    if kept:
        lines += ["", "Kept as they are (something was added in the app):"]
        lines += [f"  {c.row.id}  row #{c.row.import_row}  {LABELS.get(c.row.status, c.row.status)}" for c in kept]
    unknown = [c for c in changes if c.kind == "unknown"]
    if unknown:
        lines += ["", "Unknown sheet status (left as they are):"]
        lines += [f"  {c.row.id}  row #{c.row.import_row}  {c.row.original_status!r}" for c in unknown]
    lines += ["", "History dates: " + ("from the sheet (proposal, Actual, Expected)." if with_file else
                                       "brief date and stored event date (pass --file for the sheet's own dates)."),
              "", "APPLIED in one transaction." if applied else "Dry run: nothing was changed. Run again with --apply."]
    return "\n".join(lines)


def target_url(target: str) -> str:
    if target == "test":
        if not TEST_DB.exists():
            raise MappingRefused("No test copy yet. Make one with: python -m app.test_copy (or ./start-dev.ps1 -Data test)")
        return test_url()
    if target == "real":
        return real_database_url()
    raise MappingRefused("--target must be 'test' or 'real'.")


def run(*, database_url: str, file: str | None = None, apply_changes: bool = False, actor: str = "u-noha",
        now: datetime | None = None) -> str:
    now = now or utcnow()
    today = date.fromisoformat(cairo_today_iso(now))
    sheet = {r.number: r for r in read_rows(file)} if file else None
    engine = make_engine(database_url)
    try:
        if engine.dialect.name != "sqlite":
            raise MappingRefused("Only the SQLite databases (test copy and real data) are supported.")
        try:
            check_schema(engine, database_url)
        except SchemaNotReadyError as exc:
            raise MappingRefused(f"{exc} (Run the app once, or python -m app.setup_real, to migrate it.)") from None
        with make_sessionmaker(engine)() as db:
            if apply_changes:
                begin_write(db)
            changes = plan(db, sheet, today)
            text_out = report(changes, sheet is not None, apply_changes)
            if apply_changes:
                apply(db, changes, actor, today, now)
                db.commit()
            return text_out
    finally:
        engine.dispose()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.apply_tracker_mapping",
                                     description="Put imported 2026 requests on the current mapping.")
    parser.add_argument("--target", choices=("test", "real"), required=True,
                        help="test = the presentation copy; real = the real database")
    parser.add_argument("--file", help="the 2026 tracker .xlsx, for the history steps' dates")
    parser.add_argument("--apply", action="store_true", help="change it (without it: dry run, nothing changes)")
    parser.add_argument("--as", dest="actor", default="u-noha", help="recorded internally; never shown")
    args = parser.parse_args(argv)
    try:
        print(f"Target: {args.target} database")
        print(run(database_url=target_url(args.target), file=args.file, apply_changes=args.apply, actor=args.actor))
    except MappingRefused as exc:
        print(f"Refused: {exc} Nothing was changed.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
