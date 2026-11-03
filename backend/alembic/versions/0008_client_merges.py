"""Client merges (python -m app.merge_clients)

- request_events: 'client_merged' (a request moved to another client when its client was merged).
- client_history: 'clients_merged' on the client that received them (the emptied clients are
  archived with the existing 'archived' event and "Merged into <target>").

Only CHECK texts change; the tables are rebuilt on SQLite exactly as in 0007 (same helper).

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-22 18:00:00
"""

import importlib.util
from pathlib import Path

revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None

_spec = importlib.util.spec_from_file_location("_m0007", Path(__file__).with_name("0007_real_data_import.py"))
_m0007 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m0007)
_replace_checks = _m0007._replace_checks

OLD_REQUEST_EVENTS = "event IN ('bd_owner_transferred', 'assigned_am_changed')"
NEW_REQUEST_EVENTS = "event IN ('bd_owner_transferred', 'assigned_am_changed', 'client_merged')"
OLD_CLIENT_EVENTS = "'contact_archived', 'opportunity_added')"
NEW_CLIENT_EVENTS = "'contact_archived', 'opportunity_added', 'clients_merged')"


def upgrade() -> None:
    _replace_checks("request_events", [(OLD_REQUEST_EVENTS, NEW_REQUEST_EVENTS)])
    _replace_checks("client_history", [(OLD_CLIENT_EVENTS, NEW_CLIENT_EVENTS)])


def downgrade() -> None:
    # Revision 0007 cannot store the merge entries (development only; the moves themselves stay).
    _replace_checks("client_history", [(NEW_CLIENT_EVENTS, OLD_CLIENT_EVENTS)],
                    ["DELETE FROM {t} WHERE event = 'clients_merged'"])
    _replace_checks("request_events", [(NEW_REQUEST_EVENTS, OLD_REQUEST_EVENTS)],
                    ["DELETE FROM {t} WHERE event = 'client_merged'"])
