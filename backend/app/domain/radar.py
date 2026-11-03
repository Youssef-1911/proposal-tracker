"""
"Likely to book soon": the repeat-client radar. Port of frontend radar.js (same answers; the contract
file's radarCases check both). Requests are dicts in the frontend's shape (clientId, status, occasionId,
submittedAt, statusHistory, eventDate, eventEndDate, eventName, id).
"""

from datetime import date, timedelta

from ..config_domain import PROPOSAL_STATUSES

OCCASION_WINDOW_DAYS = 56
ONE_EVENT_GAP_DAYS = 182
CLOSED = {s["id"] for s in PROPOSAL_STATUSES if s.get("closed")}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _d(iso: str) -> date:
    return date.fromisoformat(iso)


def _days(a: str, b: str) -> int:
    return (_d(b) - _d(a)).days


def plus_days(iso: str, n: int) -> str:
    return (_d(iso) + timedelta(days=n)).isoformat()


def _is_open(r) -> bool:
    return r["status"] != "draft" and r["status"] not in CLOSED


def _day(ts) -> str | None:
    return str(ts)[:10] if ts else None


def _submitted(r) -> str | None:
    return _day(r.get("submittedAt")) or _day(next((e["changedAt"] for e in r.get("statusHistory") or []
                                                   if e["status"] == "submitted"), None))


def _event_day(r) -> str | None:
    d = r.get("eventEndDate") or r.get("eventDate")
    if not d:
        return _day(next((e["changedAt"] for e in r.get("statusHistory") or [] if e["status"] == "accepted"), None))
    return f"{d}-01" if len(d) == 7 else d


def in_about(n: int) -> str:
    if n <= 0:
        return "today"
    if n < 14:
        return f"in {n} day{'' if n == 1 else 's'}"
    return f"in about {_round(n / 7)} weeks"


def _round(x: float) -> int:
    return int(x + 0.5)  # like JavaScript's Math.round for positive numbers


def _when_year(iso: str, today: str) -> str:
    if iso[:4] == today[:4]:
        return "this year"
    if int(iso[:4]) == int(today[:4]) - 1:
        return "last year"
    return f"in {iso[:4]}"


def _month_year(iso: str) -> str:
    return f"{MONTHS[int(iso[5:7]) - 1]} {iso[:4]}"


def radar_items(requests, periods, dismissals, clients: dict, today: str) -> list[dict]:
    by_client: dict = {}
    for r in requests:
        if r["status"] == "draft" or r["clientId"] not in clients:
            continue
        by_client.setdefault(r["clientId"], []).append(r)

    def hidden(client_id, signal):
        return any(d["clientId"] == client_id and d["signal"] == signal and d["until"] >= today for d in dismissals)

    out = []
    for client_id in sorted(by_client):
        lst, client = by_client[client_id], clients[client_id]
        for occasion_id in sorted({r["occasionId"] for r in lst if r.get("occasionId")}):
            mine = sorted((p for p in periods if p["occasionId"] == occasion_id), key=lambda p: p["startsOn"])
            nxt = next((p for p in mine if p["startsOn"] >= today), None)
            if nxt is None or _days(today, nxt["startsOn"]) > OCCASION_WINDOW_DAYS:
                continue
            previous = next((p for p in reversed(mine) if p["endsOn"] < nxt["startsOn"]), None)
            since = previous["endsOn"] if previous else plus_days(nxt["startsOn"], -300)
            for_it = [r for r in lst if r.get("occasionId") == occasion_id]
            covered = any(_is_open(r) or (_submitted(r) or "") > since for r in for_it)
            signal = f"occasion:{occasion_id}"
            if covered or hidden(client_id, signal):
                continue
            past = sorted(for_it, key=lambda r: (_event_day(r) or "", r["id"]), reverse=True)[0]
            booked = any(r["status"] == "accepted" for r in for_it)
            when = _event_day(past) or _submitted(past) or today
            what = past.get("eventName") or nxt["name"]
            n = _days(today, nxt["startsOn"])
            out.append({
                "clientId": client_id, "signal": signal, "occasionId": occasion_id, "bdOwner": client["owner"],
                "sourceRequestId": past["id"], "until": nxt["endsOn"], "sortDays": n,
                "sentence": f"{client['name']} {'booked' if booked else 'asked about'} {what} {_when_year(when, today)}. "
                            f"{nxt['name']} starts {in_about(n)}. No request yet.",
            })
        confirmed = sorted((r for r in lst if r["status"] == "accepted" and _event_day(r)),
                           key=lambda r: (_event_day(r), r["id"]))
        if not confirmed:
            continue
        last = confirmed[-1]
        last_day = _event_day(last)
        gap = ONE_EVENT_GAP_DAYS
        if len(confirmed) >= 2:
            gaps = sorted(_days(_event_day(confirmed[i]), _event_day(r)) for i, r in enumerate(confirmed[1:]))
            gap = max(1, gaps[(len(gaps) - 1) // 2])
        due = plus_days(last_day, gap)
        newer = any(r["id"] != last["id"] and (_submitted(r) or "") > last_day for r in lst)
        if due > today or newer or hidden(client_id, "rhythm"):
            continue
        what = f"{last['eventName']} ({_month_year(last_day)})" if last.get("eventName") else _month_year(last_day)
        months = max(1, _round(gap / 30))
        ago = max(1, _round(_days(last_day, today) / 30))
        out.append({
            "clientId": client_id, "signal": "rhythm", "occasionId": None, "bdOwner": client["owner"],
            "sourceRequestId": last["id"], "until": plus_days(today, gap), "sortDays": -_days(due, today),
            "sentence": (f"{client['name']} usually books every {months} month{'' if _round(gap / 30) == 1 else 's'}; "
                         f"the last was {what}. No new request since.") if len(confirmed) >= 2 else
                        f"{client['name']} booked {what}, {ago} months ago. No new request since.",
        })
    return sorted(out, key=lambda i: (i["sortDays"], i["clientId"], i["signal"]))
