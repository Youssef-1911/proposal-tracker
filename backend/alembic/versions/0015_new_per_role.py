"""New and unread per person AND role; every "New" also notifies

- request_reads: keyed by person, ROLE and request. Someone with two roles (Mariam El Khayat: BD and
  Account Manager) has a separate "New" in each. Existing reads are copied to each role the person holds.
- notifications.role: the role a notification is for (empty: any of the person's roles); the bell
  shows the ones for the role being worked in.
- notifications kinds: 'activity' (a status step or changed details marked New for you) and 'task'.

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-27 10:00:00
"""

import importlib.util
from pathlib import Path

from alembic import op
import sqlalchemy as sa

revision = '0015'
down_revision = '0014'
branch_labels = None
depends_on = None

_spec = importlib.util.spec_from_file_location("_m0007", Path(__file__).with_name("0007_real_data_import.py"))
_m0007 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m0007)
_replace_checks = _m0007._replace_checks

OLD_KINDS = "kind IN ('reminder', 'waiting_on', 'message', 'event')"
NEW_KINDS = "kind IN ('reminder', 'waiting_on', 'message', 'event', 'activity', 'task')"


def _reads_table(name: str, with_role: bool) -> None:
    columns = [sa.Column('user_id', sa.String(length=50), sa.ForeignKey('users.id'), primary_key=True)]
    if with_role:
        columns.append(sa.Column('role', sa.String(length=30), primary_key=True))
    columns += [sa.Column('request_id', sa.String(length=16), sa.ForeignKey('proposal_requests.id'), primary_key=True),
                sa.Column('read_at', sa.DateTime(), nullable=False)]
    op.create_table(name, *columns)


def upgrade() -> None:
    _reads_table('request_reads_new', True)
    op.execute("INSERT INTO request_reads_new (user_id, role, request_id, read_at) "
               "SELECT r.user_id, ur.role, r.request_id, r.read_at FROM request_reads r "
               "JOIN user_roles ur ON ur.user_id = r.user_id")
    op.drop_table('request_reads')
    op.rename_table('request_reads_new', 'request_reads')
    op.add_column('notifications', sa.Column('role', sa.String(length=30), nullable=True))
    _replace_checks("notifications", [(OLD_KINDS, NEW_KINDS)])


def downgrade() -> None:
    _replace_checks("notifications", [(NEW_KINDS, OLD_KINDS)], ["DELETE FROM {t} WHERE kind IN ('activity', 'task')"])
    op.execute("ALTER TABLE notifications DROP COLUMN role")
    _reads_table('request_reads_old', False)
    op.execute("INSERT INTO request_reads_old (user_id, request_id, read_at) "
               "SELECT user_id, request_id, MAX(read_at) FROM request_reads GROUP BY user_id, request_id")
    op.drop_table('request_reads')
    op.rename_table('request_reads_old', 'request_reads')
