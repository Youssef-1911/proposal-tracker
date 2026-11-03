"""
The dropdown lists. Port of frontend lists.js (same defaults, codes and messages; the contract file
checks both). Values are stored as codes; Settings may add, rename or hide options, never delete.

lists = {list_id: [{"code", "label", "hidden"}]} — the defaults with Settings' rows applied.
"""

import re
import unicodedata

OTHER = "other"
LIST_MAX_VISIBLE = 12
LIST_LABEL_MAX = 60


def _o(code, label):
    return {"code": code, "label": label, "hidden": False}


LIST_DEFS = [
    {"id": "whatsMissing", "label": "What's missing (Awaiting BD information)", "multi": True},
    {"id": "whatShouldChange", "label": "What should change (Revision requested)", "multi": True},
    {"id": "postponeWhy", "label": "Why postponed", "multi": False},
    {"id": "cities", "label": "Client city", "multi": False},
    {"id": "briefTags", "label": "Brief quick tags", "multi": True},
    {"id": "waitingClient", "label": "Waiting on the client: reasons", "multi": False},
    {"id": "waitingMarketing", "label": "Waiting on Marketing: reasons", "multi": False},
    {"id": "waitingOperations", "label": "Waiting on Operations: reasons", "multi": False},
    {"id": "waitingInternal", "label": "Waiting on BD, AM or management: reasons", "multi": False},
    {"id": "questionAbout", "label": "Questions: about", "multi": False},
    {"id": "eventCancelReasons", "label": "Event cancelled: why", "multi": False},
    {"id": "facilitatorSkills", "label": "Facilitators: skills", "multi": True},
]
LIST_IDS = [d["id"] for d in LIST_DEFS]

DEFAULT_LISTS = {
    "whatsMissing": [_o("budget", "Budget"), _o("participants", "Participants"), _o("event_date", "Event date"),
                     _o("venue", "Venue"), _o("transport", "Transport"), _o("catering", "Catering"),
                     _o("activities", "Activities"), _o(OTHER, "Other")],
    "whatShouldChange": [_o("price", "Price"), _o("activities", "Activities"), _o("date", "Date"),
                         _o("participants", "Participants"), _o("venue", "Venue"), _o("transport", "Transport"),
                         _o("design", "Design"), _o(OTHER, "Other")],
    "postponeWhy": [_o("budget_not_approved", "Budget not approved"), _o("date_not_confirmed", "Date not confirmed"),
                    _o("internal_changes", "Client's internal changes"), _o("seasonal", "Seasonal / Ramadan"),
                    _o(OTHER, "Other")],
    "cities": [_o("cairo", "Cairo"), _o("giza", "Giza"), _o("new_cairo", "New Cairo"),
               _o("sheikh_zayed", "Sheikh Zayed / 6th of October"), _o("alexandria", "Alexandria"),
               _o("north_coast", "North Coast"), _o("ain_sokhna", "Ain Sokhna"), _o("hurghada", "Hurghada / El Gouna"),
               _o("sharm", "Sharm El Sheikh"), _o(OTHER, "Other")],
    "briefTags": [_o("transport", "Transport"), _o("catering", "Catering"), _o("venue", "Venue"),
                  _o("overnight", "Overnight"), _o("outdoor", "Outdoor"), _o("indoor", "Indoor")],
    "waitingClient": [_o("awaiting_reply", "Awaiting reply"), _o("budget_approval", "Budget approval"),
                      _o("final_numbers", "Final numbers"), _o("event_date", "Event date"), _o(OTHER, "Other")],
    "waitingMarketing": [_o("design", "Design / creative"), _o("presentation", "Presentation formatting"),
                         _o(OTHER, "Other")],
    "waitingOperations": [_o("venue_availability", "Venue availability"), _o("supplier_prices", "Supplier prices"),
                          _o("transport", "Transport"), _o("staff", "Staff"), _o(OTHER, "Other")],
    "waitingInternal": [_o("information_missing", "Information missing"), _o("approval_needed", "Approval needed"),
                        _o(OTHER, "Other")],
    "questionAbout": [_o("price", "Price"), _o("activities", "Activities"), _o("date", "Date"),
                      _o("participants", "Participants"), _o("venue", "Venue"), _o("transport", "Transport"),
                      _o("design", "Design"), _o(OTHER, "Other")],
    "eventCancelReasons": [_o("client_cancelled", "Client cancelled"), _o("budget", "Budget"),
                           _o("date_clash", "Date clash"), _o(OTHER, "Other")],
    "facilitatorSkills": [_o("games", "Games"), _o("sports", "Sports"), _o("kids", "Kids"), _o("team_building", "Team building"),
                          _o("mc", "MC"), _o("first_aid", "First aid")],
}


def effective_lists(rows=()) -> dict:
    """rows: [{"listId", "code", "label", "hidden", "position"}] (Settings' changes)."""
    out = {lid: [dict(x) for x in DEFAULT_LISTS[lid]] for lid in LIST_IDS}
    for r in sorted(rows, key=lambda r: (r.get("position") or 0, str(r["code"]))):
        items = out.get(r["listId"])
        if items is None:
            continue
        found = next((x for x in items if x["code"] == r["code"]), None)
        if found:
            found["label"] = r["label"]
            found["hidden"] = bool(r.get("hidden"))
        else:
            other = next((i for i, x in enumerate(items) if x["code"] == OTHER), len(items))
            items.insert(other, {"code": r["code"], "label": r["label"], "hidden": bool(r.get("hidden"))})
    return out


def visible_options(lists, list_id) -> list[dict]:
    return [x for x in (lists or DEFAULT_LISTS).get(list_id, DEFAULT_LISTS.get(list_id, [])) if not x["hidden"]]


def option_label(lists, list_id, code):
    if code is None or code == "":
        return None
    items = (lists or DEFAULT_LISTS).get(list_id, DEFAULT_LISTS.get(list_id, []))
    return next((x["label"] for x in items if x["code"] == code), str(code))


def check_codes(lists, list_id, codes, multi: bool = True):
    if not isinstance(codes, list):
        return "Choose from the list."
    valid = {x["code"] for x in visible_options(lists, list_id)}
    if any(not isinstance(c, str) or c not in valid for c in codes) or len(set(codes)) != len(codes):
        return "Choose from the list."
    if not multi and len(codes) > 1:
        return "Choose one."
    return None


def _code_from(label: str) -> str:
    text = unicodedata.normalize("NFKD", label.lower())
    return re.sub(r"^_+|_+$", "", re.sub(r"[^a-z0-9]+", "_", text))[:40]


def validate_list_change(lists, list_id, data: dict) -> dict:
    items = (lists or {}).get(list_id)
    if items is None:
        return {"errors": {"listId": "Unknown list."}, "row": None}
    raw = data.get("label")
    label = " ".join(raw.split()) if isinstance(raw, str) else ""
    existing = next((x for x in items if x["code"] == data.get("code")), None)

    def fail(field, message):
        return {"errors": {field: message}, "row": None}

    same = lambda x: x["label"].lower() == label.lower()  # noqa: E731
    visible = len([x for x in items if not x["hidden"]])
    action = data.get("action")
    if action == "add":
        if not label:
            return fail("label", "Enter the option.")
        if len(label) > LIST_LABEL_MAX:
            return fail("label", f"Use at most {LIST_LABEL_MAX} characters.")
        code = _code_from(label)
        if not code:
            return fail("label", "Use letters or numbers.")
        if any(x["code"] == code or same(x) for x in items):
            return fail("label", "This option already exists.")
        if visible >= LIST_MAX_VISIBLE:
            return fail("label", f"Keep at most {LIST_MAX_VISIBLE} options; hide one first.")
        return {"errors": {}, "row": {"listId": list_id, "code": code, "label": label, "hidden": False}}
    if existing is None:
        return fail("code", "Choose an option from the list.")
    if action == "rename":
        if not label:
            return fail("label", "Enter the new name.")
        if len(label) > LIST_LABEL_MAX:
            return fail("label", f"Use at most {LIST_LABEL_MAX} characters.")
        if any(x["code"] != existing["code"] and same(x) for x in items):
            return fail("label", "Another option has this name.")
        return {"errors": {}, "row": {"listId": list_id, "code": existing["code"], "label": label,
                                      "hidden": existing["hidden"]}}
    if action in ("hide", "show"):
        hidden = action == "hide"
        if hidden and existing["code"] == OTHER:
            return fail("code", '"Other" always stays available.')
        if not hidden and visible >= LIST_MAX_VISIBLE:
            return fail("code", f"Keep at most {LIST_MAX_VISIBLE} options; hide one first.")
        return {"errors": {}, "row": {"listId": list_id, "code": existing["code"], "label": existing["label"],
                                      "hidden": hidden}}
    return fail("action", "Choose add, rename, hide or show.")
