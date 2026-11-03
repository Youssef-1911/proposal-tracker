"""Status corrections (data fixes)

- request_status_history.corrected: the entry is a "Correct status (data fix)": a jump straight to the
  right status, outside the normal steps. It never notifies anyone, and the outcome it replaces is not
  counted in the numbers any more.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-28 10:00:00
"""

from alembic import op
import sqlalchemy as sa

revision = '0016'
down_revision = '0015'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('request_status_history', sa.Column('corrected', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.execute("ALTER TABLE request_status_history DROP COLUMN corrected")
