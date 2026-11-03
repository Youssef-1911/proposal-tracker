"""
HR staffing: facilitators for confirmed events. Port of frontend staffing.js (same answers; the contract
file's staffingCases check both).
"""

import math
from datetime import datetime, timedelta

RATING_EDIT_DAYS = 7
MIN_RATINGS_FOR_TOP = 3


def can_set_facilitators_needed(r, viewer) -> bool:
    if viewer.active_role in ("operations", "commercial_head"):
        return True
    return viewer.active_role == "account_manager" and viewer.user_id == r.assigned_am


def can_manage_facilitators(viewer) -> bool:
    return viewer.active_role in ("hr", "operations")  # staffing, the list, assignments, ratios: HR and Operations only


def can_see_ratings(viewer) -> bool:
    return viewer.active_role in ("hr", "operations")


def can_rate(viewer) -> bool:
    return viewer.active_role in ("hr", "operations")


def suggested_needed(participants, per_facilitator):
    if not participants or not per_facilitator or participants <= 0 or per_facilitator <= 0:
        return None
    return math.ceil(participants / per_facilitator)


def staffing_of(needed, assigned: int) -> dict:
    return {"needed": needed, "assigned": assigned, "missing": max(0, (needed or 0) - assigned)}


def staffing_totals(events) -> dict:
    t = {"events": 0, "needed": 0, "assigned": 0, "missing": 0}
    for e in events:
        s = staffing_of(e.get("facilitatorsNeeded"), e.get("assignedCount") or 0)
        t = {"events": t["events"] + 1, "needed": t["needed"] + (s["needed"] or 0), "assigned": t["assigned"] + s["assigned"],
             "missing": t["missing"] + s["missing"]}
    return t


def _span(e):
    if not e.get("eventDate") or e.get("eventDatePrecision") == "month":
        return None
    end = e.get("eventEndDate")
    return (e["eventDate"], end if end and end > e["eventDate"] else e["eventDate"])


def clashes(event, others) -> list[str]:
    a = _span(event)
    if a is None:
        return []
    out = []
    for o in others:
        b = _span(o)
        if o["id"] != event["id"] and b and b[0] <= a[1] and a[0] <= b[1]:
            out.append(o["id"])
    return sorted(out)


def rating_editable(created_at: datetime | None, now: datetime) -> bool:
    return created_at is None or now - created_at <= timedelta(days=RATING_EDIT_DAYS)


def validate_rating(data: dict) -> dict:
    errors = {}
    raw = data.get("attended")
    attended = raw is True or raw == "yes"
    if raw is None or raw == "":
        errors["attended"] = "Did they attend?"
    stars_raw = data.get("stars")
    stars = None
    if stars_raw not in (None, ""):
        try:
            n = float(stars_raw)
            stars = int(n) if n == int(n) else n
        except (TypeError, ValueError):
            stars = "x"
    if attended and (stars is None or not isinstance(stars, int) or isinstance(stars_raw, bool) or not 1 <= stars <= 5):
        errors["stars"] = "Give 1 to 5 stars."
    fb = data.get("feedback")
    feedback = fb.strip() if isinstance(fb, str) and fb.strip() else None
    if feedback and len(feedback) > 1000:
        errors["feedback"] = "Use at most 1000 characters."
    return {"errors": errors, "values": {"attended": attended, "stars": stars if attended else None, "feedback": feedback}}


def facilitator_record(ratings, done_assignments) -> dict:
    starred = [r for r in ratings if r["attended"] and r.get("stars")]
    average = round(sum(r["stars"] for r in starred) / len(starred) * 10 + 1e-9) / 10 if starred else None
    latest = {}
    for r in sorted(ratings, key=lambda r: str(r["updatedAt"])):
        latest[r["requestId"]] = r
    attended = sum(1 for r in latest.values() if r["attended"])
    return {"average": average, "ratings": len(starred), "attended": attended, "assignedDone": len(set(done_assignments))}


def _norm_phone(v) -> str:
    return "".join(ch for ch in str(v or "") if ch.isdigit())


def _norm_name(v) -> str:
    return " ".join(str(v or "").lower().split())


def possible_duplicates(data: dict, facilitators) -> list[int]:
    phone, name = _norm_phone(data.get("phone")), _norm_name(data.get("name"))
    return [f["id"] for f in facilitators
            if (phone and _norm_phone(f.get("phone")) == phone) or (name and _norm_name(f["name"]) == name)]
