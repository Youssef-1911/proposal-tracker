"""Event status, separate from the proposal status

- proposal_requests.event_status: initial (Initially confirmed: planning only) · confirmed · postponed ·
  cancelled; set once the client accepted. Events confirmed before this count as confirmed (or
  cancelled, when they were cancelled after confirmation), filled in here.
- proposal_requests.event_postpone_reason / event_postpone_note.
- request_events: 'event_status_set', 'event_confirmed', 'event_postponed'.
- notifications: kind 'event' (Operations hears about every event change).

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-23 20:00:00
"""

import importlib.util
from pathlib import Path

from alembic import op
import sqlalchemy as sa

revision = '0014'
down_revision = '0013'
branch_labels = None
depends_on = None

_spec = importlib.util.spec_from_file_location("_m0007", Path(__file__).with_name("0007_real_data_import.py"))
_m0007 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m0007)
_replace_checks = _m0007._replace_checks

OLD_EVENTS = ("'reminder_sent', 'event_date_changed', 'event_cancelled')")
NEW_EVENTS = ("'reminder_sent', 'event_date_changed', 'event_cancelled', 'event_status_set', 'event_confirmed', "
              "'event_postponed')")
OLD_KINDS = "kind IN ('reminder', 'waiting_on', 'message')"
NEW_KINDS = "kind IN ('reminder', 'waiting_on', 'message', 'event')"


def upgrade() -> None:
    op.add_column('proposal_requests', sa.Column('event_status', sa.String(length=12), nullable=True))
    op.add_column('proposal_requests', sa.Column('event_postpone_reason', sa.String(length=40), nullable=True))
    op.add_column('proposal_requests', sa.Column('event_postpone_note', sa.String(length=300), nullable=True))
    op.execute("UPDATE proposal_requests SET event_status = CASE WHEN event_cancelled_at IS NOT NULL THEN 'cancelled' "
               "ELSE 'confirmed' END WHERE status = 'accepted'")
    _replace_checks("request_events", [(OLD_EVENTS, NEW_EVENTS)])
    _replace_checks("notifications", [(OLD_KINDS, NEW_KINDS)])


def downgrade() -> None:
    _replace_checks("notifications", [(NEW_KINDS, OLD_KINDS)], ["DELETE FROM {t} WHERE kind = 'event'"])
    _replace_checks("request_events", [(NEW_EVENTS, OLD_EVENTS)],
                    ["DELETE FROM {t} WHERE event IN ('event_status_set', 'event_confirmed', 'event_postponed')"])
    for name in ('event_postpone_note', 'event_postpone_reason', 'event_status'):
        op.execute(f"ALTER TABLE proposal_requests DROP COLUMN {name}")
