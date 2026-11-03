"""proposal files, comments, lost reason on opportunity history

- proposal_files: one row per uploaded proposal file (append-only; a re-upload for the same
  version is a new row that replaces the previous one). Bytes live in file storage.
- request_comments: plain-text comment thread per request (append-only).
- opportunity_history.lost_reason: why the opportunity became Lost (only on Lost entries).

SQLite note: adding the CHECK constraint rebuilds opportunity_history ("batch" mode), which
drops its append-only triggers; they are explicitly re-created afterwards (and on downgrade).

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-21 10:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None

ROLES = "('commercial_head', 'account_manager', 'business_development')"
MAX_BYTES = 25 * 1024 * 1024


def upgrade() -> None:
    op.create_table(
        'proposal_files',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('request_id', sa.String(length=16), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('storage_key', sa.String(length=64), nullable=False),
        sa.Column('file_type', sa.String(length=10), nullable=False),
        sa.Column('original_name', sa.String(length=255), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('sha256', sa.String(length=64), nullable=False),
        sa.Column('uploaded_by_id', sa.String(length=50), nullable=False),
        sa.Column('role', sa.String(length=40), nullable=False),
        sa.Column('uploaded_at', sa.DateTime(), nullable=False),
        sa.Column('replaces_file_id', sa.Integer(), nullable=True),
        sa.CheckConstraint("file_type IN ('pdf', 'pptx')", name='ck_proposal_files_type'),
        sa.CheckConstraint(f'size_bytes > 0 AND size_bytes <= {MAX_BYTES}', name='ck_proposal_files_size'),
        sa.CheckConstraint('version >= 1', name='ck_proposal_files_version'),
        sa.CheckConstraint(f"role IN {ROLES}", name='ck_proposal_files_role'),
        sa.ForeignKeyConstraint(['request_id'], ['proposal_requests.id']),
        sa.ForeignKeyConstraint(['uploaded_by_id'], ['users.id']),
        sa.ForeignKeyConstraint(['replaces_file_id'], ['proposal_files.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('storage_key'),
    )
    with op.batch_alter_table('proposal_files', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_proposal_files_request_id'), ['request_id'], unique=False)

    op.create_table(
        'request_comments',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('request_id', sa.String(length=16), nullable=False),
        sa.Column('author_id', sa.String(length=50), nullable=False),
        sa.Column('role', sa.String(length=40), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.CheckConstraint('length(body) BETWEEN 1 AND 2000', name='ck_request_comments_length'),
        sa.CheckConstraint(f"role IN {ROLES}", name='ck_request_comments_role'),
        sa.ForeignKeyConstraint(['request_id'], ['proposal_requests.id']),
        sa.ForeignKeyConstraint(['author_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('request_comments', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_request_comments_request_id'), ['request_id'], unique=False)

    _drop_append_only("opportunity_history")
    with op.batch_alter_table('opportunity_history', schema=None) as batch_op:
        batch_op.add_column(sa.Column('lost_reason', sa.Text(), nullable=True))
        batch_op.create_check_constraint('ck_opp_history_lost_reason', "lost_reason IS NULL OR to_stage = 'lost'")
    _create_append_only("opportunity_history")

    _create_append_only("proposal_files")
    _create_append_only("request_comments")


def downgrade() -> None:
    _drop_append_only("request_comments")
    _drop_append_only("proposal_files")

    _drop_append_only("opportunity_history")
    with op.batch_alter_table('opportunity_history', schema=None) as batch_op:
        batch_op.drop_constraint('ck_opp_history_lost_reason', type_='check')
        batch_op.drop_column('lost_reason')
    _create_append_only("opportunity_history")

    with op.batch_alter_table('request_comments', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_request_comments_request_id'))
    op.drop_table('request_comments')
    with op.batch_alter_table('proposal_files', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_proposal_files_request_id'))
    op.drop_table('proposal_files')


# ---------------------------------------------------------------------------
# Append-only triggers (same pattern as revisions 0001-0003)
# ---------------------------------------------------------------------------

def _create_append_only(table: str) -> None:
    message = f"{table} is append-only"
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        for action in ("UPDATE", "DELETE"):
            op.execute(
                f"CREATE TRIGGER {table}_no_{action.lower()} BEFORE {action} ON {table} "
                f"BEGIN SELECT RAISE(ABORT, '{message}'); END;"
            )
    elif dialect == "postgresql":
        op.execute(
            f"CREATE OR REPLACE FUNCTION {table}_append_only() RETURNS trigger AS $$ "
            f"BEGIN RAISE EXCEPTION '{message}'; END; $$ LANGUAGE plpgsql;"
        )
        for action in ("UPDATE", "DELETE"):
            op.execute(
                f"CREATE TRIGGER {table}_no_{action.lower()} BEFORE {action} ON {table} "
                f"FOR EACH ROW EXECUTE FUNCTION {table}_append_only();"
            )
    else:
        raise NotImplementedError(f"No append-only trigger defined for {dialect}")


def _drop_append_only(table: str) -> None:
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        op.execute(f"DROP TRIGGER IF EXISTS {table}_no_update")
        op.execute(f"DROP TRIGGER IF EXISTS {table}_no_delete")
    elif dialect == "postgresql":
        op.execute(f"DROP TRIGGER IF EXISTS {table}_no_update ON {table}")
        op.execute(f"DROP TRIGGER IF EXISTS {table}_no_delete ON {table}")
        op.execute(f"DROP FUNCTION IF EXISTS {table}_append_only()")
