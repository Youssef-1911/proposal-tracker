"""Reminders (in-app notifications) and confirmed events

- notifications: one row per recipient (reminders, "waiting on you"); read_at is the only thing that changes.
- proposal_requests: what "Mark confirmed" records (confirmed_participants, final_price, venue, team_notes)
  and "Event cancelled" (event_cancelled_at, event_cancel_reason, event_cancel_note).
- request_events: 'reminder_sent', 'event_date_changed', 'event_cancelled'.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-25 10:00:00
"""

import importlib.util
from pathlib import Path

from alembic import op
import sqlalchemy as sa

revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None

_spec = importlib.util.spec_from_file_location("_m0007", Path(__file__).with_name("0007_real_data_import.py"))
_m0007 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m0007)
_replace_checks = _m0007._replace_checks

OLD_EVENTS = ("event IN ('bd_owner_transferred', 'assigned_am_changed', 'client_merged', 'waiting_on_set', "
              "'waiting_on_cleared', 'details_updated', 'details_seen')")
NEW_EVENTS = ("event IN ('bd_owner_transferred', 'assigned_am_changed', 'client_merged', 'waiting_on_set', "
              "'waiting_on_cleared', 'details_updated', 'details_seen', 'reminder_sent', 'event_date_changed', "
              "'event_cancelled')")
REQUEST_COLUMNS = (('confirmed_participants', sa.Integer()), ('final_price', sa.Integer()),
                   ('venue', sa.String(length=200)), ('team_notes', sa.Text()), ('event_cancelled_at', sa.DateTime()),
                   ('event_cancel_reason', sa.String(length=40)), ('event_cancel_note', sa.String(length=300)))


def upgrade() -> None:
    op.create_table(
        'notifications',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('user_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=False, index=True),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('body', sa.Text(), nullable=True),
        sa.Column('link', sa.String(length=200), nullable=True),
        sa.Column('request_ids', sa.JSON(), nullable=True),
        sa.Column('actor_id', sa.String(length=50), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('read_at', sa.DateTime(), nullable=True),
        sa.CheckConstraint("kind IN ('reminder', 'waiting_on')", name='ck_notifications_kind'),
    )
    for name, kind in REQUEST_COLUMNS:
        op.add_column('proposal_requests', sa.Column(name, kind, nullable=True))
    _replace_checks("request_events", [(OLD_EVENTS, NEW_EVENTS)])


def downgrade() -> None:
    _replace_checks("request_events", [(NEW_EVENTS, OLD_EVENTS)],
                    ["DELETE FROM {t} WHERE event IN ('reminder_sent', 'event_date_changed', 'event_cancelled')"])
    for name, _ in reversed(REQUEST_COLUMNS):
        op.execute(f"ALTER TABLE proposal_requests DROP COLUMN {name}")
    op.drop_table('notifications')
