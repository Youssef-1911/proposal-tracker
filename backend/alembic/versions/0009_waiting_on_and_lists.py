"""Waiting on, dropdown lists, brief tags, action reasons

- proposal_requests: "Set waiting on" by hand (waiting_team, waiting_user_id, waiting_reason,
  waiting_expected_by, waiting_note, waiting_set_at, waiting_set_by_id) and brief_tags (codes).
- request_status_history.reasons: codes chosen with an action (what's missing, what should
  change, why postponed).
- list_options: Settings' changes to the dropdown lists (add, rename, hide; never deleted).
- request_events: 'waiting_on_set' and 'waiting_on_cleared'.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-23 10:00:00
"""

import importlib.util
from pathlib import Path

from alembic import op
import sqlalchemy as sa

revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None

_spec = importlib.util.spec_from_file_location("_m0007", Path(__file__).with_name("0007_real_data_import.py"))
_m0007 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m0007)
_replace_checks = _m0007._replace_checks

OLD_EVENTS = "event IN ('bd_owner_transferred', 'assigned_am_changed', 'client_merged')"
NEW_EVENTS = ("event IN ('bd_owner_transferred', 'assigned_am_changed', 'client_merged', 'waiting_on_set', "
              "'waiting_on_cleared')")
WAITING = (('waiting_team', sa.String(length=20)), ('waiting_reason', sa.String(length=60)),
           ('waiting_expected_by', sa.Date()), ('waiting_note', sa.String(length=300)),
           ('waiting_set_at', sa.DateTime()))


def upgrade() -> None:
    # Plain columns (no table rebuild: proposal_requests is referenced by five tables). The two user ids
    # are checked by the server, like the other references added after the table was created.
    op.add_column('proposal_requests', sa.Column('brief_tags', sa.JSON(), nullable=True))
    for name, kind in WAITING:
        op.add_column('proposal_requests', sa.Column(name, kind, nullable=True))
    op.add_column('proposal_requests', sa.Column('waiting_user_id', sa.String(length=50), nullable=True))
    op.add_column('proposal_requests', sa.Column('waiting_set_by_id', sa.String(length=50), nullable=True))
    op.add_column('request_status_history', sa.Column('reasons', sa.JSON(), nullable=True))
    op.create_table(
        'list_options',
        sa.Column('list_id', sa.String(length=40), primary_key=True),
        sa.Column('code', sa.String(length=40), primary_key=True),
        sa.Column('label', sa.String(length=60), nullable=False),
        sa.Column('hidden', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('position', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.Column('updated_by_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=False),
    )
    _replace_checks("request_events", [(OLD_EVENTS, NEW_EVENTS)])


def downgrade() -> None:
    _replace_checks("request_events", [(NEW_EVENTS, OLD_EVENTS)],
                    ["DELETE FROM {t} WHERE event IN ('waiting_on_set', 'waiting_on_cleared')"])
    op.drop_table('list_options')
    op.execute("ALTER TABLE request_status_history DROP COLUMN reasons")
    for name in ('waiting_set_by_id', 'waiting_user_id', *[n for n, _ in WAITING], 'brief_tags'):
        op.execute(f"ALTER TABLE proposal_requests DROP COLUMN {name}")
