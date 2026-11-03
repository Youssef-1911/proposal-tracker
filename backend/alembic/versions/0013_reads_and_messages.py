"""My Work: read state per person, and the new message types

- request_reads: when each person last opened each request ("New for you" is everything after it).
  The only table here that is updated in place (opening a request moves the time forward).
- request_comments.reasons: what should change ("Change needed"; whatShouldChange codes).
- notifications: kind 'message' (a message, question, answer or change sent to you, with its words).

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-23 16:00:00
"""

import importlib.util
from pathlib import Path

from alembic import op
import sqlalchemy as sa

revision = '0013'
down_revision = '0012'
branch_labels = None
depends_on = None

_spec = importlib.util.spec_from_file_location("_m0007", Path(__file__).with_name("0007_real_data_import.py"))
_m0007 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m0007)
_replace_checks = _m0007._replace_checks

OLD_KINDS = "kind IN ('reminder', 'waiting_on')"
NEW_KINDS = "kind IN ('reminder', 'waiting_on', 'message')"


def upgrade() -> None:
    op.create_table(
        'request_reads',
        sa.Column('user_id', sa.String(length=50), sa.ForeignKey('users.id'), primary_key=True),
        sa.Column('request_id', sa.String(length=16), sa.ForeignKey('proposal_requests.id'), primary_key=True),
        sa.Column('read_at', sa.DateTime(), nullable=False),
    )
    op.add_column('request_comments', sa.Column('reasons', sa.JSON(), nullable=True))
    _replace_checks("notifications", [(OLD_KINDS, NEW_KINDS)])


def downgrade() -> None:
    _replace_checks("notifications", [(NEW_KINDS, OLD_KINDS)], ["DELETE FROM {t} WHERE kind = 'message'"])
    op.execute("ALTER TABLE request_comments DROP COLUMN reasons")
    op.drop_table('request_reads')
