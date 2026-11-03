"""
Personal to-dos: the same rules as frontend/src/domain/todos.js.

Private: only the owner ever reads or changes them (the router filters on the owner; anyone else's
to-do answers 404). Soft delete. A link points at a client, request or event the owner can see.
"""

from datetime import date

TODO_TEXT_MAX = 300
TODO_LINK_KINDS = ("client", "request", "event")
COMPLETED_DAYS = 30


def _is_date(value) -> bool:
    if not isinstance(value, str) or len(value) != 10:
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def validate_todo(data: dict) -> tuple[dict, dict]:
    """{ text, dueOn?, linkKind?, linkId? } -> (errors, values) with empty optional fields as None."""
    errors = {}
    text = data.get("text").strip() if isinstance(data.get("text"), str) else ""
    if not text:
        errors["text"] = "Write the to-do."
    elif len(text) > TODO_TEXT_MAX:
        errors["text"] = f"At most {TODO_TEXT_MAX} characters."
    due_on = data.get("dueOn") or None
    if due_on is not None and not _is_date(due_on):
        errors["dueOn"] = "Enter a valid date."
    link_kind = data.get("linkKind") or None
    link_id = data.get("linkId") or None
    if (link_kind is None) != (link_id is None) or (link_kind is not None and link_kind not in TODO_LINK_KINDS):
        errors["link"] = "Choose a client, request or event."
    return errors, {"text": text, "dueOn": due_on, "linkKind": link_kind, "linkId": link_id}


def is_todo_overdue(todo: dict, today: str) -> bool:
    return not todo.get("doneAt") and bool(todo.get("dueOn")) and todo["dueOn"] < today
