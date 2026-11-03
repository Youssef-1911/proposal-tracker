"""Personal to-dos (My Work): one table, private to each owner, soft-deleted

- todos: owner, text (300), optional due date, optional link to a client, request or event, done_at,
  deleted_at. Nothing else changes; no notifications, Analytics or /screen use it.

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-30 10:00:00
"""

from alembic import op
import sqlalchemy as sa

revision = '0018'
down_revision = '0017'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'todos',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('owner_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=False, index=True),
        sa.Column('text', sa.String(length=300), nullable=False),
        sa.Column('due_on', sa.Date(), nullable=True),
        sa.Column('link_kind', sa.String(length=10), nullable=True),
        sa.Column('link_id', sa.String(length=16), nullable=True),
        sa.Column('done_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.Column('deleted_at', sa.DateTime(), nullable=True),
        sa.CheckConstraint("link_kind IS NULL OR link_kind IN ('client', 'request', 'event')", name='ck_todos_link_kind'),
        sa.CheckConstraint('(link_kind IS NULL) = (link_id IS NULL)', name='ck_todos_link_pair'),
    )


def downgrade() -> None:
    op.drop_table('todos')
