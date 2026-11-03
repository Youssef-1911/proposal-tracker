"""Questions & changes: the conversation, detail updates

- request_comments: kind ('comment' · 'question' · 'answer' · 'answered'), about (a questionAbout code)
  and parent_id (the question an answer belongs to). Still append-only: answering adds a row.
- request_events: details (JSON: what changed, before -> after) and the events 'details_updated'
  and 'details_seen'.
- proposal_requests: details_changed_at / details_seen_at (the assigned AM's "Details changed" banner).

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-24 10:00:00
"""

import importlib.util
from pathlib import Path

from alembic import op
import sqlalchemy as sa

revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None

_spec = importlib.util.spec_from_file_location("_m0007", Path(__file__).with_name("0007_real_data_import.py"))
_m0007 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m0007)
_replace_checks = _m0007._replace_checks

OLD_EVENTS = ("event IN ('bd_owner_transferred', 'assigned_am_changed', 'client_merged', 'waiting_on_set', "
              "'waiting_on_cleared')")
NEW_EVENTS = ("event IN ('bd_owner_transferred', 'assigned_am_changed', 'client_merged', 'waiting_on_set', "
              "'waiting_on_cleared', 'details_updated', 'details_seen')")


def upgrade() -> None:
    op.add_column('request_comments', sa.Column('kind', sa.String(length=10), nullable=False, server_default='comment'))
    op.add_column('request_comments', sa.Column('about', sa.String(length=40), nullable=True))
    op.add_column('request_comments', sa.Column('parent_id', sa.Integer(), nullable=True))
    op.add_column('request_events', sa.Column('details', sa.JSON(), nullable=True))
    op.add_column('proposal_requests', sa.Column('details_changed_at', sa.DateTime(), nullable=True))
    op.add_column('proposal_requests', sa.Column('details_seen_at', sa.DateTime(), nullable=True))
    _replace_checks("request_events", [(OLD_EVENTS, NEW_EVENTS)])


def downgrade() -> None:
    _replace_checks("request_events", [(NEW_EVENTS, OLD_EVENTS)],
                    ["DELETE FROM {t} WHERE event IN ('details_updated', 'details_seen')"])
    for table, column in (('proposal_requests', 'details_seen_at'), ('proposal_requests', 'details_changed_at'),
                          ('request_events', 'details'), ('request_comments', 'parent_id'),
                          ('request_comments', 'about'), ('request_comments', 'kind')):
        op.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
