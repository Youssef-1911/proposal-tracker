"""
Suggests an occasion for requests that have none, from the brief and the event name (Ramadan, Iftar, Eid,
Easter, Christmas, Halloween, Beach, Summer...). Dry run first; nothing changes until --apply.

    python -m app.suggest_occasions --target test            the suggestions, one line each (dry run)
    python -m app.suggest_occasions --target test --apply    tag them
    --skip PR-2026-0012,PR-2026-0040                          leave these untagged (after checking the dry run)

    --set "PR-2026-0024=Eid al-Fitr"                          choose the occasion for a request (several: comma-separated)

Rule: an occasion named in the client or event name (Eid, Ramadan, Christmas, Easter, Halloween...) wins over
a season guess from the brief. A plain "Eid" is Eid al-Fitr or Eid al-Adha by the event date (else the brief
date): the Eid closest to it, from Settings when its dates are there, else the published dates below.
Only requests without an occasion are touched; an occasion set by hand is never changed.
"""

import argparse
import re
import sys

from sqlalchemy import select

from .apply_tracker_mapping import MappingRefused, target_url
from .database import begin_write, make_engine, make_sessionmaker
from .models import Client, Occasion, ProposalRequest

# Word (lower case, whole word) -> occasion name. The first match wins, in this order.
KEYWORDS = [
    (("ramadan", "iftar", "suhoor", "sohour"), "Ramadan"),
    (("eid al-adha", "eid al adha", "adha"), "Eid al-Adha"),
    (("eid",), "Eid al-Fitr"),
    (("easter", "sham el nessim", "sham el-nessim"), "Easter"),
    (("christmas", "xmas"), "Christmas"),
    (("halloween",), "Halloween"),
    (("back to school",), "Back to school"),
    (("year-end", "year end", "new year"), "Year-end"),
    (("mid-year", "mid year"), "Mid-year"),
    (("beach", "summer", "sahel"), "Summer season"),
]


# Named occasions (not a season guess): looked for in the client and event name first.
EXPLICIT = [(words, name) for words, name in KEYWORDS if name != "Summer season"] + [(("summer season",), "Summer season")]
# Approximate published dates, used only when Settings has no dates for that Eid.
EID_DATES = {"Eid al-Fitr": ["2024-04-10", "2025-03-30", "2026-03-20", "2027-03-09"],
             "Eid al-Adha": ["2024-06-16", "2025-06-06", "2026-05-27", "2027-05-16"]}


def _match(text: str, rules) -> str | None:
    t = " ".join(str(text or "").lower().split())
    for words, name in rules:
        if any(re.search(rf"(?<![a-z]){re.escape(w)}(?![a-z])", t) for w in words):
            return name
    return None


def suggest(text: str) -> str | None:
    """The earlier rule (event name and brief together): kept to show what the new rule changes."""
    return _match(text, KEYWORDS)


def _which_eid(day: str, periods: dict) -> tuple[str, str]:
    """Eid al-Fitr or Eid al-Adha: the one whose date is closest to `day` -> (name, the date used)."""
    from datetime import date
    target = date.fromisoformat(day)
    best = None
    for name in ("Eid al-Fitr", "Eid al-Adha"):
        for d in periods.get(name) or EID_DATES[name]:
            gap = abs((date.fromisoformat(d) - target).days)
            if best is None or gap < best[0]:
                best = (gap, name, d)
    return best[1], best[2]


def suggest_for(client, event_name, brief, day, periods: dict) -> tuple[str | None, str]:
    """-> (occasion, why). Named in the client or event name first; else the brief (a season guess)."""
    named = _match(f"{client or ''} {event_name or ''}", EXPLICIT)
    why = "named in the client or event name"
    if named is None:
        named, why = _match(f"{event_name or ''} {brief or ''}", KEYWORDS), "from the brief"
    if named == "Eid al-Fitr":
        text = f"{client or ''} {event_name or ''} {brief or ''}".lower()
        if "fitr" not in text and day:  # a plain "Eid": Fitr or Adha by date
            named, used = _which_eid(day, periods)
            why = f"Eid by date: {day} is closest to {named} ({used})"
    return named, why


def run(*, database_url: str, apply_changes: bool = False, skip=(), chosen: dict | None = None) -> str:
    chosen = chosen or {}
    engine = make_engine(database_url)
    try:
        with make_sessionmaker(engine)() as db:
            if apply_changes:
                begin_write(db)
            occasions = {o.name: o.id for o in db.scalars(select(Occasion)).all()}
            names = {c.id: c.name for c in db.scalars(select(Client)).all()}
            from .models import OccasionPeriod
            periods: dict = {}
            for per, o in db.execute(select(OccasionPeriod, Occasion).join(Occasion, Occasion.id == OccasionPeriod.occasion_id)).all():
                periods.setdefault(o.name, []).append(per.starts_on.isoformat())
            unknown = [n for n in chosen.values() if n not in occasions]
            if unknown:
                raise MappingRefused(f"Unknown occasion(s): {', '.join(unknown)}.")
            rows = db.scalars(select(ProposalRequest).where(ProposalRequest.occasion_id.is_(None),
                                                            ProposalRequest.status != "draft")
                              .order_by(ProposalRequest.id)).all()
            lines, changed, final = [], [], {}
            for r in rows:
                if r.id in skip:
                    continue
                day = r.event_date or (r.submitted_at.date() if r.submitted_at else None)
                day = day.isoformat() if day else None
                name, why = suggest_for(names.get(r.client_id), r.event_name, r.requirements_summary, day, periods)
                if r.id in chosen:
                    name, why = chosen[r.id], "chosen with --set"
                before = suggest(f"{r.event_name or ''} {r.requirements_summary or ''}")
                if not name or name not in occasions:
                    continue
                final[name] = final.get(name, 0) + 1
                label = f"{names.get(r.client_id) or '—'} · {r.event_name or r.requirements_summary or '—'}"
                lines.append(f"  {r.id}  {label}  ->  {name}  ({why})")
                if before != name:
                    changed.append(f"  {r.id}  {label}: {before or 'none'} -> {name}  ({why})")
                if apply_changes:
                    r.occasion_id = occasions[name]
            count = sum(final.values())
            if apply_changes:
                db.commit()
            head = f"Suggested occasions: {count} request(s) without one" + (f" (skipped: {len(skip)})" if skip else "")
            tail = "APPLIED." if apply_changes else "Dry run: nothing was changed. Check the list, then run with --apply (and --skip for any wrong ones)."
            totals = ["", "Per occasion:"] + [f"  {n:<16}{c:>4}" for n, c in sorted(final.items(), key=lambda x: (-x[1], x[0]))]
            diff = ["", f"Changed from the earlier rule: {len(changed)}", *changed]
            return "\n".join([head, *lines, *diff, *totals, "", tail])
    finally:
        engine.dispose()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.suggest_occasions", description="Suggest occasions from the brief.")
    parser.add_argument("--target", choices=("test", "real"), required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--skip", default="")
    parser.add_argument("--set", dest="chosen", default="", help="PR-2026-0024=Eid al-Fitr (several: comma-separated)")
    args = parser.parse_args(argv)
    try:
        skip = {x.strip() for x in args.skip.split(",") if x.strip()}
        print(f"Target: {args.target} database")
        pairs = [x.split("=", 1) for x in args.chosen.split(",") if "=" in x]
        chosen = {k.strip(): v.strip() for k, v in pairs}
        print(run(database_url=target_url(args.target), apply_changes=args.apply, skip=skip, chosen=chosen))
    except MappingRefused as exc:
        print(f"Refused: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
