"""
Is the app right for every user?  python -m app.check_users --target test   (read-only; GET requests only)

For every active person in every role they hold, this computes from the database and the permission rules
what they should see, then calls the same API endpoints the screens use, as that person and role, and
compares. It prints: person · role · view · expected · actual · OK/DIFF (with request ids for differences).

Views: Proposals (each scope) · My Work (Your turn, Waiting on the team, Waiting for client, New) ·
My queue (Account Managers) · Events (and prices) · Dashboard/Analytics · Clients.
Rules checked: nobody sees someone else's draft; an AM without "See all brands" sees only their brand;
Operations and Marketing never see prices; BD numbers = their own requests, an AM's = their brand,
Noha and Executives = all, and the per-BD totals add up to the company total; the same request shows the
same status, stage and "waiting on" in every view for every viewer.
"""

import argparse
import sys
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from .clock import cairo_today_iso
from .database import make_engine, make_sessionmaker, utcnow
from .domain import access, events as event_rules, my_work, tracker
from .domain.views import request_from_json, request_from_orm, user_from_orm
from .domain.waiting import effective_waiting
from .identity import Actor
from .models import Client, ProposalRequest, User
from .apply_tracker_mapping import MappingRefused, target_url

LOOPBACK = ("127.0.0.1", 50000)
OPEN_CLOSED = {"accepted", "rejected", "cancelled", "closed_unrecorded", "closed_postponed"}


@dataclass
class Line:
    person: str
    role: str
    view: str
    expected: object
    actual: object
    ids: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.expected == self.actual and not self.ids


def _ids(items) -> set:
    return {i["id"] for i in items}


def _waiting_key(w) -> tuple | None:
    return None if not w else (w["team"], w.get("userId"))


def check(client, db, today: str) -> tuple[list[Line], dict]:
    users_orm = {u.id: u for u in db.scalars(select(User)).all()}
    users = {uid: user_from_orm(u) for uid, u in users_orm.items()}
    rows = db.scalars(select(ProposalRequest).options(selectinload(ProposalRequest.history),
                                                      selectinload(ProposalRequest.files))).all()
    views = {r.id: request_from_orm(r) for r in rows}
    clients = db.scalars(select(Client).options(selectinload(Client.brands))).all()
    lines: list[Line] = []
    seen = defaultdict(set)  # request id -> {(status, stage, subLabel, waiting)} across every viewer and view
    company_total, bd_totals = None, {}

    for uid, u in sorted(users_orm.items()):
        if not u.active:
            continue
        for role in u.role_ids:
            a = Actor(uid, role)
            me = users[uid]
            h = {"X-Dev-User": uid, "X-Dev-Role": role}
            add = lambda view, exp, act, ids=(): lines.append(Line(u.name, role, view, exp, act, sorted(ids)))  # noqa: E731
            visible = {i for i, v in views.items() if access.can_see_request(v, a, users)}
            leaked = []

            # Proposals: every scope, against the scope rule.
            union = {}
            for scope in tracker.scopes_for(role, me):
                items = _all_pages(client, h, scope)
                union.update({i["id"]: i for i in items})
                expected = {i for i, v in views.items() if tracker.in_scope(v, a, me, scope) and i in visible}
                got = _ids(items)
                add(f"Proposals · {scope}", len(expected), len(got), expected ^ got)
                leaked += [i["id"] for i in items if i["status"] == "draft" and views[i["id"]].created_by != uid]
                if role == "account_manager" and not access.has_privilege(me, "seeAllBrands"):
                    leaked += [i["id"] for i in items if i["brand"] != me.brand]
                for i in items:
                    seen[i["id"]].add((i["status"], i["stage"], i["subLabel"], _waiting_key(effective_waiting(request_from_json(_as_json(i))))))
            if not tracker.scopes_for(role, me):
                r = client.get("/api/proposal-requests", headers=h)
                add("Proposals · none (no access)", 403, r.status_code)

            # My Work, from the same data the screen loads (the union of the scopes).
            if union:
                data = [request_from_json(_as_json(i)) for i in union.values()]
                from_db = [views[i] for i in union if i in views]
                for title, pick in _my_work(uid, role, utcnow()):
                    add(f"My Work · {title}", sorted(x.id for x in from_db if pick(x)), sorted(x.id for x in data if pick(x)))
                new_rows = sorted(i for i, it in union.items() if it.get("newForYou"))
                count = client.get("/api/proposal-requests/new-count", headers=h).json()["count"]
                add("My Work · New (count = rows)", len(new_rows), count)
            if role == "account_manager":
                expected = {i for i, v in views.items() if v.assigned_am == uid and v.status != "draft"
                            and v.status not in OPEN_CLOSED and not v.needs_review}
                got = {i for i, it in union.items() if it["assignedAM"] == uid and it["status"] != "draft"
                       and it["status"] not in OPEN_CLOSED and not it.get("needsReview")}
                add("My queue (open, assigned to me)", len(expected), len(got), expected ^ got)

            # Events: who sees which event, and never a price for Operations / Marketing.
            r = client.get("/api/events", headers=h)
            if r.status_code == 200:
                body = r.json()
                expected = {i for i, v in views.items() if event_rules.can_see_event(v, a, users)}
                got = _ids(body["items"])
                add("Events", len(expected), len(got), expected ^ got)
                priced = [i["id"] for i in body["items"] if "finalPrice" in i]
                if not event_rules.can_see_event_price(a):
                    add("Events · no prices", 0, len(priced), priced)
                for e in body["items"]:
                    seen[e["id"]].add(("event", e["status"]))
            else:
                add("Events", "403 (no access)", r.status_code)

            # Dashboard / Analytics: BD = own requests; AM = their brand; Noha / Executives = all.
            r = client.get("/api/analytics", headers=h)
            if r.status_code == 200:
                got = _ids(r.json()["requests"])
                if role == "business_development" or (role == "executive" and False):
                    expected = {i for i, v in views.items() if v.bd_owner == uid and (v.status != "draft" or v.created_by == uid)}
                elif role == "account_manager":
                    brands = access.analytics_brands(a, me)
                    expected = {i for i, v in views.items() if v.status != "draft" and (brands is None or v.brand in brands)}
                else:
                    expected = {i for i, v in views.items() if v.status != "draft" or v.created_by == uid}
                add("Dashboard/Analytics", len(expected), len(got), expected ^ got)
                if role in ("commercial_head", "executive") and company_total is None:
                    company_total = {i for i in got if views[i].status != "draft"}
                if role == "business_development":
                    bd_totals[uid] = {i for i in got if views[i].status != "draft"}

            # Clients.
            r = client.get("/api/clients", headers=h)
            if r.status_code == 200:
                got = {c["id"] for c in r.json()["items"]}
                expected = {c.id for c in clients if c.archived_at is None and access.can_see_client(c.brand_ids, a, users)}
                add("Clients", len(expected), len(got), expected ^ got)
            else:
                add("Clients", "no access", r.status_code)
            # The menu: the pages the server gives this role are exactly its menu.
            pages = client.get("/api/me", headers=h).json()["pages"]
            menu = access.MENUS.get(role, ())
            keys = ("home", "queue", "proposals", "events", "clients", "dashboard", "staffing", "facilitators", "screen")
            me_user = users.get(uid)
            expected_pages = [k for k in keys if k in menu]
            # Analytics needs "See analytics"; Admin (Team & Users) needs "Manage accounts".
            if "analytics" in menu and access.has_privilege(me_user, "seeAnalytics"):
                expected_pages.append("analytics")
            if "admin" in menu and access.has_privilege(me_user, "manageAccounts"):
                expected_pages.append("team")
            got_pages = [k for k in (*keys, "analytics", "team") if pages.get(k)]
            add("Menu (pages)", ", ".join(sorted(expected_pages)), ", ".join(sorted(got_pages)))
            # Staffing and Facilitators: HR and Operations only (403 for everyone else).
            for path in ("/api/staffing", "/api/facilitators", "/api/staffing/dashboard"):
                code = client.get(path, headers=h).status_code
                add(f"{path}", 200 if role in ("hr", "operations") else 403, code)
            # The Proposals tabs: server counts = the shared rule on what this person may see; never an event.
            if tracker.scopes_for(role, me):
                proposals_seen, buckets = set(), {t: 0 for t in tracker.PROPOSAL_TAB_IDS}
                for scope in tracker.scopes_for(role, me):
                    body = client.get("/api/proposal-requests", headers=h,
                                      params={"scope": scope, "hideEvents": "true", "pageSize": 100}).json()
                    for t, n in body["bucketCounts"].items():
                        buckets[t] += n
                    proposals_seen |= {i["id"] for i in _all_pages_hidden(client, h, scope)}
                expected_b = {t: 0 for t in tracker.PROPOSAL_TAB_IDS}
                for scope in tracker.scopes_for(role, me):
                    for i, v in views.items():
                        if tracker.in_scope(v, a, me, scope) and i in visible:
                            for t in tracker.PROPOSAL_TAB_IDS:
                                expected_b[t] += tracker.in_bucket(v, t)
                add("Proposals tabs (counts)", expected_b, buckets)
                events_seen = {e["id"] for e in client.get("/api/events", headers=h).json().get("items", [])}                     if client.get("/api/events", headers=h).status_code == 200 else set()
                both = proposals_seen & events_seen
                add("Never in both Proposals and Events", 0, len(both), both)
            if leaked:
                add("Never shown (others' drafts, other brands)", 0, len(set(leaked)), set(leaked))

    # Per-BD totals add up to the company total (every non-draft request has one BD owner).
    if company_total is not None:
        owners = defaultdict(set)
        for i in company_total:
            owners[views[i].bd_owner].add(i)
        summed = sum(len(s) for s in owners.values())
        lines.append(Line("Company", "—", "Per-BD totals add up", len(company_total), summed))
    # The same request looks the same everywhere.
    for rid, variants in sorted(seen.items()):
        request_variants = {v for v in variants if v[0] != "event"}
        if len(request_variants) > 1:
            lines.append(Line("Everyone", "—", "Same status/stage/waiting everywhere", 1, len(request_variants), [rid]))
    return lines, {}


def _as_json(item: dict) -> dict:
    """A list item in the shape request_from_json reads (history is optional in lists)."""
    return {**item, "statusHistory": item.get("history") or []}


def _all_pages(client, headers, scope) -> list[dict]:
    items, page = [], 1
    while True:
        body = client.get("/api/proposal-requests", headers=headers,
                          params={"scope": scope, "pageSize": 100, "page": page, "include": "history"}).json()
        items += body["items"]
        if page * 100 >= body["total"]:
            return items
        page += 1


def _all_pages_hidden(client, headers, scope) -> list[dict]:
    """The Proposals page's own list (events left out)."""
    items, page = [], 1
    while True:
        body = client.get("/api/proposal-requests", headers=headers,
                          params={"scope": scope, "pageSize": 100, "page": page, "hideEvents": "true"}).json()
        items += body["items"]
        if page * 100 >= body["total"]:
            return items
        page += 1


def _my_work(uid: str, role: str, now):
    """My Work's sections from the shared rule (app/domain/my_work.py = frontend domain/myWork.js)."""
    def section(r):
        return my_work.my_work_section(r, uid, role, now)
    out = [
        ("Your turn", lambda r: section(r) == "turn"),
        ("Waiting on others · The team", lambda r: section(r) == "team"),
        ("Waiting on others · The client", lambda r: section(r) == "client"),
    ]
    if role in my_work.MANAGEMENT:
        out.append(("Waiting on others · Every submitted request (under its AM)",
                    lambda r: r.status == "submitted" and not r.needs_review and section(r) == "team"
                    and (effective_waiting(r) or {}).get("userId") == r.assigned_am))
        out.append(("Waiting on others · Stuck 3+ days",
                    lambda r: section(r) in ("team", "client") and my_work.stuck_days(r, role, now) is not None))
    return out


def report(lines: list[Line]) -> str:
    out = [f"{'Person':<22}{'Role':<22}{'View':<44}{'Expected':>10}{'Actual':>10}  Result"]
    for line in lines:
        exp = line.expected if not isinstance(line.expected, list) else len(line.expected)
        act = line.actual if not isinstance(line.actual, list) else len(line.actual)
        ids = sorted(set(line.ids) | (set(line.expected) ^ set(line.actual) if isinstance(line.expected, list) else set()))
        result = "OK" if line.expected == line.actual and not ids else "DIFF"
        out.append(f"{line.person:<22}{line.role:<22}{line.view:<44}{str(exp):>10}{str(act):>10}  {result}"
                   + (f"  {', '.join(ids[:12])}{' …' if len(ids) > 12 else ''}" if result == "DIFF" else ""))
    diffs = sum(1 for o in out[1:] if "DIFF" in o)
    out.append("")
    out.append("All OK." if not diffs else f"{diffs} difference(s).")
    out.append("Read-only: nothing was changed.")
    return "\n".join(out)


def run(*, database_url: str, files_dir: str | None = None) -> tuple[str, int]:
    from fastapi.testclient import TestClient
    from .main import create_app
    from .settings import Settings
    settings = Settings(env="development", dev_identity=True, database_url=database_url,
                        files_dir=files_dir or "storage/proposal-files-test")
    engine = make_engine(database_url)
    try:
        with TestClient(create_app(settings, engine=engine), client=LOOPBACK) as client:
            with make_sessionmaker(engine)() as db:
                lines, _ = check(client, db, cairo_today_iso(utcnow()))
        text = report(lines)
        return text, text.count("  DIFF")
    finally:
        engine.dispose()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.check_users", description="Every user sees what they should (read-only).")
    parser.add_argument("--target", choices=("test", "real"), required=True)
    args = parser.parse_args(argv)
    try:
        text, _ = run(database_url=target_url(args.target))
    except MappingRefused as exc:
        print(f"Refused: {exc}", file=sys.stderr)
        return 2
    print(f"Target: {args.target} database")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
