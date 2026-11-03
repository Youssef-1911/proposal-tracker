"""
Reconciliation, read-only: the app next to the 2026 tracker sheet.

    python -m app.check_tracker <tracker.xlsx> --target test     the persistent test copy
    python -m app.check_tracker <tracker.xlsx> --target real     the real database

All time, side by side, in plain categories: Done · Confirmed (not done) · Lost · Postponed · With client ·
With AM (and Ready for BD / Not recorded when there are any): the sheet's rows under the current mapping
vs the app's records today; per brand (with the same categories) and per BD owner (the sheet's "Brief Sent
by"); then every row that differs. Requests added in the app (not from the sheet) are listed apart.
Nothing is ever written.
"""

import argparse
import sys
from collections import Counter
from datetime import date

from sqlalchemy import select

from .clock import cairo_today_iso
from .database import make_engine, make_sessionmaker, utcnow
from .domain.events import event_timing
from .import_tracker import BRAND_CODES, BRAND_NAMES, SENDERS, SKIPPED_BRANDS, STATUS, parse_event, read_rows
from .apply_tracker_mapping import MappingRefused, target_url
from .models import Client, ProposalRequest, User

ORDER = ["Done", "Confirmed (not done)", "Lost", "Postponed", "With client", "Ready for BD", "With AM", "Not recorded"]
SENDER_OF = {uid: key.title() for key, uid in SENDERS.items()}


def category(status: str, timing: str | None) -> str:
    """The plain category of a request (the same words for the sheet and the app)."""
    if status == "accepted":
        return "Done" if timing == "done" else "Confirmed (not done)"
    if status in ("rejected", "cancelled"):
        return "Lost"
    if status in ("postponed", "closed_postponed"):
        return "Postponed"
    if status == "shared_with_client":
        return "With client"
    if status == "ready_for_bd":
        return "Ready for BD"
    if status == "closed_unrecorded":
        return "Not recorded"
    return "With AM"  # submitted · in progress · waiting for BD · revision


def _day(d: date | None, precision: str) -> str | None:
    if d is None:
        return None
    return d.strftime("%Y-%m") if precision == "month" else d.isoformat()


def sheet_timing(row, status: str, today: str) -> str | None:
    ev = parse_event(row.actual if row.actual not in (None, "") else row.expected, row.brief_date)
    return event_timing({"status": status, "imported": True, "originalStatus": row.status,
                         "eventDate": _day(ev.start, ev.precision), "eventEndDate": _day(ev.end, "day"),
                         "eventDatePrecision": ev.precision, "eventStatus": "confirmed"}, today)


def app_timing(r: ProposalRequest, today: str) -> str | None:
    return event_timing({"status": r.status, "imported": r.imported, "originalStatus": r.original_status,
                         "eventDate": _day(r.event_date, r.event_date_precision), "eventEndDate": _day(r.event_end_date, "day"),
                         "eventDatePrecision": r.event_date_precision,
                         "eventCancelledAt": r.event_cancelled_at.isoformat() if r.event_cancelled_at else None,
                         "eventStatus": r.event_status}, today)


def compare(sheet_rows, requests, users: dict, today: str, client_names: dict | None = None) -> dict:
    by_row = {r.import_row: r for r in requests if r.import_row is not None}
    sheet, app = Counter(), Counter()  # keys: ("all", cat) · (brand, cat) · ("person", name)
    differences, seen = [], set()
    for row in sorted(sheet_rows, key=lambda x: x.number):
        if row.brand_code in SKIPPED_BRANDS:
            continue
        mapped = STATUS.get(row.status.strip().lower())
        brand = BRAND_CODES.get(row.brand_code)
        if mapped is None or brand is None or not row.client or not row.brief_date:
            differences.append(f"row #{row.number} {row.client!r}: not importable ({row.status!r}, {row.brand_code!r})")
            continue
        cat = category(mapped[0], sheet_timing(row, mapped[0], today))
        person = row.sender.strip().title()
        for key in (("all", cat), (BRAND_NAMES[brand], cat), ("person", person)):
            sheet[key] += 1
        r = by_row.get(row.number)
        if r is None:
            differences.append(f"row #{row.number} {row.client!r}: missing in the app")
            continue
        seen.add(r.id)
        app_cat = category(r.status, app_timing(r, today))
        app_person = SENDER_OF.get(r.bd_owner_id) or (users[r.bd_owner_id].name if r.bd_owner_id in users else r.bd_owner_id)
        for key in (("all", app_cat), (BRAND_NAMES.get(r.brand, r.brand), app_cat), ("person", app_person)):
            app[key] += 1
        diffs = []
        if app_cat != cat:
            diffs.append(f"{app_cat} (sheet: {cat})")
        if r.brand != brand:
            diffs.append(f"brand {BRAND_NAMES.get(r.brand, r.brand)} (sheet: {BRAND_NAMES[brand]})")
        if app_person != person:
            diffs.append(f"BD owner {app_person} (sheet: {person})")
        if diffs:
            differences.append(f"row #{row.number} {r.id} {row.client!r}: " + "; ".join(diffs))
    added = [r for r in requests if r.import_row is None and r.status != "draft"]
    return {"sheet": sheet, "app": app, "differences": differences,
            "added": [(r.id, (client_names or {}).get(r.client_id), r.status) for r in sorted(added, key=lambda r: r.id)]}


def report(result: dict) -> str:
    sheet, app = result["sheet"], result["app"]
    lines = ["All time · sheet (current mapping) vs app"]

    def block(title, group, keys):
        total_s = sum(sheet[(group, k)] for k in keys)
        total_a = sum(app[(group, k)] for k in keys)
        lines.extend(["", f"{title}: sheet {total_s} · app {total_a}", f"  {'':<26}{'sheet':>7}{'app':>7}"])
        for k in keys:
            a, b = sheet[(group, k)], app[(group, k)]
            if a or b:
                lines.append(f"  {k:<26}{a:>7}{b:>7}" + ("" if a == b else "   <- differs"))

    block("All requests", "all", ORDER)
    for brand in sorted({g for g, _ in list(sheet) + list(app) if g not in ("all", "person")}):
        block(brand, brand, ORDER)
    people = sorted({k for g, k in list(sheet) + list(app) if g == "person"}, key=lambda k: (-sheet[("person", k)], k))
    block("By BD owner", "person", people)
    lines += ["", f"Added in the app since the import (not in the sheet): {len(result['added'])}"]
    lines += [f"  {i}  {c or '—'}  {s}" for i, c, s in result["added"]]
    lines += ["", f"Rows that differ: {len(result['differences'])}"]
    lines += [f"  {d}" for d in result["differences"]]
    lines += ["", "Read-only: nothing was changed."]
    return "\n".join(lines)


def run(path: str, *, database_url: str, today: str | None = None) -> str:
    rows = read_rows(path)
    today = today or cairo_today_iso(utcnow())
    engine = make_engine(database_url)
    try:
        with make_sessionmaker(engine)() as db:
            requests = db.scalars(select(ProposalRequest)).all()
            users = {u.id: u for u in db.scalars(select(User)).all()}
            names = {c.id: c.name for c in db.scalars(select(Client)).all()}
            return report(compare(rows, requests, users, today, names))
    finally:
        engine.dispose()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.check_tracker", description="The app vs the 2026 tracker (read-only).")
    parser.add_argument("file")
    parser.add_argument("--target", choices=("test", "real"), required=True)
    args = parser.parse_args(argv)
    try:
        print(f"Target: {args.target} database")
        print(run(args.file, database_url=target_url(args.target)))
    except MappingRefused as exc:
        print(f"Refused: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
