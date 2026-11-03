"""
Who is told about what on a request, and what is "New for you". Port of frontend activity.js (same
answers; the contract file's activityCases check both).

messages: [{"id", "kind", "body", "about", "parentId", "reasons", "author", "role", "createdAt"}]
events:   [{"event", "changedBy", "role", "changedAt", "toUser", "details"}]
Times may be datetimes or ISO strings.
"""

import re
from datetime import datetime, timezone

from ..config_domain import ACCOUNT_MANAGER, BUSINESS_DEVELOPMENT, COMMERCIAL_HEAD
from ..identity import Actor
from .access import can_see_request
from .lists import DEFAULT_LISTS, option_label
from .views import parse_ts

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
# The role a status step is addressed to ("slot"); it only matters for people holding both roles.
SLOT_ROLE = {"am": ACCOUNT_MANAGER, "bd": BUSINESS_DEVELOPMENT}


def _team_members(team, users: dict) -> list[str]:
    from .waiting import TEAMS
    roles = TEAMS[team]["roles"] if team in TEAMS else []
    return sorted(u.id for u in users.values() if u.active is not False and any(x in roles for x in u.roles))


def _short(text, n=60) -> str:
    t = " ".join(str(text or "").split())
    return t[: n - 1] + "…" if len(t) > n else t


def _t(v) -> datetime:
    if v is None:
        return _EPOCH
    d = parse_ts(v) if isinstance(v, str) else v
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def find_mentions(body, users) -> list[str]:
    text = str(body or "").lower()
    active = [u for u in users if u.active is not False]
    first_counts: dict[str, int] = {}
    for u in active:
        first = u.name.split(" ")[0].lower()
        first_counts[first] = first_counts.get(first, 0) + 1

    def at(word: str) -> bool:
        start = 0
        while True:
            i = text.find("@" + word, start)
            if i == -1:
                return False
            nxt = text[i + len(word) + 1: i + len(word) + 2]
            if nxt == "" or not re.match(r"[a-z0-9]", nxt):
                return True
            start = i + 1

    found = set()
    for u in active:
        name = u.name.lower()
        first = name.split(" ")[0]
        if at(name) or (first_counts[first] == 1 and at(first)):
            found.add(u.id)
    return sorted(found)


def recipient_can_view(r, user, users: dict) -> bool:
    if user is None or user.active is False:
        return False
    return any(can_see_request(r, Actor(user.id, role), users) for role in user.roles)


def message_recipients(m: dict, r, users: dict, messages=()) -> list[str]:
    if m["kind"] in ("answered", "picked_up"):
        return []
    author = m["author"]
    side = [r.assigned_am] if author == r.bd_owner else [r.bd_owner] if author == r.assigned_am else [r.bd_owner, r.assigned_am]
    if m["kind"] == "answer":
        parent = next((x for x in messages if x["id"] == m.get("parentId")), None)
        ids = [parent["author"]] if parent else []
    else:
        ids = list(side)
    if m["kind"] == "change":
        ids += [u.id for u in users.values() if COMMERCIAL_HEAD in u.roles and u.active is not False]
    ids += find_mentions(m.get("body"), list(users.values()))
    out = {i for i in ids if i and i != author and recipient_can_view(r, users.get(i), users)}
    return sorted(out)


def message_line(m: dict, author_name: str, lists=None) -> str:
    if m["kind"] == "question":
        return f'{author_name} asked: "{_short(m.get("body"))}"'
    if m["kind"] == "answer":
        return f"{author_name} answered your question"
    if m["kind"] == "change":
        what = ", ".join(option_label(lists or DEFAULT_LISTS, "whatShouldChange", c) for c in (m.get("reasons") or [])).lower()
        return f"Change needed ({m.get('about')}): {what}"
    return f'{author_name}: "{_short(m.get("body"))}"'


def activity_items(r, users: dict, messages=(), events=(), lists=None) -> list[dict]:
    def name(uid):
        return users[uid].name if uid in users else "Someone"

    items = []
    h = r.history
    for i, e in enumerate(h):
        if e.imported or e.corrected or e.status == "draft":
            continue
        prev = h[i - 1].status if i > 0 else None
        by = e.changed_by

        def push(who, line, e=e, by=by):
            slots = {}
            for k, uid in (("am", r.assigned_am), ("bd", r.bd_owner)):
                if k in who and uid and uid not in slots:
                    slots[uid] = k
            items.append({"at": e.changed_at, "by": by, "byRole": e.role, "to": list(slots), "slots": slots, "line": line})

        if e.status == "submitted":
            push(["am"], f"{name(by)} sent the information" if prev == "awaiting_bd_info" else f"New request from {name(by)}")
        elif e.status == "awaiting_bd_info":
            push(["bd"], f"{name(by)} needs an answer to continue")
        elif e.status == "ready_for_bd":
            push(["bd"], "Proposal ready for you")
        elif e.status == "revision_requested":
            push(["am"], f"Changes requested by {name(by)}" if prev == "ready_for_bd" else f"Client revision recorded by {name(by)}")
        elif e.status == "in_progress" and prev == "ready_for_bd":
            push(["bd"], f"{name(by)} took the proposal back to edit")
        elif e.status == "accepted":
            push(["am"], f"Confirmed by {name(by)}")
        elif e.status == "rejected":
            push(["am"], f"Marked lost by {name(by)}")
        elif e.status == "cancelled":
            push(["am", "bd"], f"Cancelled by {name(by)}")
    for m in messages:
        if m["kind"] in ("answered", "picked_up"):
            continue
        line = f"New question from {name(m['author'])}" if m["kind"] == "question" else message_line(m, name(m["author"]), lists)
        items.append({"at": m["createdAt"], "by": m["author"], "byRole": m.get("role"),
                      "to": message_recipients(m, r, users, messages), "slots": {}, "line": line,
                      "kind": "message", "messageId": m.get("id")})
    for ev in events:
        base = {"at": ev["changedAt"], "by": ev["changedBy"], "byRole": ev.get("role")}
        team = (ev.get("details") or {}).get("team")
        if ev["event"] == "details_updated" and r.assigned_am:
            items.append({**base, "to": [r.assigned_am], "slots": {r.assigned_am: "am"},
                          "line": f"Details changed by {name(ev['changedBy'])}"})
        elif ev["event"] == "waiting_on_set" and (ev.get("toUser") or team):
            # Waiting on a team with no one named (e.g. Marketing): everyone in that team is told.
            to = [ev["toUser"]] if ev.get("toUser") else _team_members(team, users)
            items.append({**base, "to": to, "slots": {}, "line": f"Waiting on you — set by {name(ev['changedBy'])}",
                          "kind": "waiting_on"})
        elif ev["event"] == "reminder_sent" and ev.get("toUser"):
            items.append({**base, "to": [ev["toUser"]], "slots": {}, "line": f"Reminder from {name(ev['changedBy'])}",
                          "source": "reminder_sent"})
    return items


def item_role(item: dict, user) -> str | None:
    """The role an item is addressed to for this person: only for people holding more than one role."""
    role = SLOT_ROLE.get((item.get("slots") or {}).get(getattr(user, "id", None)))
    return role if role and user is not None and len(user.roles) > 1 and role in user.roles else None


def is_new_for(item: dict, viewer: Actor, users: dict) -> bool:
    """The one shared rule: only what OTHER people did counts (never your own action, in either role);
    an item addressed to one role of a two-role person shows only while working in that role."""
    if viewer.user_id not in item["to"] or item["by"] == viewer.user_id:
        return False
    role = item_role(item, users.get(viewer.user_id))
    return not role or role == viewer.active_role


def new_recipients(item: dict, users: dict) -> list[dict]:
    """Who an item is new for -> [{"userId", "role"}]; each also gets a bell notification."""
    out = []
    for uid in item["to"]:
        role = item_role(item, users.get(uid))
        if uid in users and is_new_for(item, Actor(uid, role), users):
            out.append({"userId": uid, "role": role})
    return out


def new_for_you(r, viewer: Actor, last_read_at, users: dict, messages=(), events=(), lists=None) -> dict | None:
    since = _t(last_read_at) if last_read_at else _EPOCH
    mine = [it for it in activity_items(r, users, messages, events, lists)
            if _t(it["at"]) > since and is_new_for(it, viewer, users)]
    if not mine:
        return None
    mine.sort(key=lambda it: _t(it["at"]), reverse=True)
    return {"line": mine[0]["line"], "at": mine[0]["at"], "count": len(mine)}
