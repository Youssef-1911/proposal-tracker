"""request history: lost reason and share channel

Adds two columns to request_status_history:
- lost_reason: the fixed reason chosen on "Mark lost" (only on Rejected entries)
- channel: how the proposal was sent to the client (only on Shared with Client entries)
Both are CHECK-constrained to their fixed lists and to the matching status.

SQLite note: adding CHECK constraints rebuilds the table ("batch" mode), which drops its
append-only triggers; they are explicitly re-created afterwards (and on downgrade).

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-20 18:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None

TABLE = "request_status_history"


def upgrade() -> None:
    _drop_append_only(TABLE)
    with op.batch_alter_table(TABLE, schema=None) as batch_op:
        batch_op.add_column(sa.Column('lost_reason', sa.String(length=30), nullable=True))
        batch_op.add_column(sa.Column('channel', sa.String(length=20), nullable=True))
        batch_op.create_check_constraint(
            'ck_request_history_lost_reason',
            "lost_reason IS NULL OR (status = 'rejected' AND lost_reason IN "
            "('price', 'timing', 'competitor', 'no_response', 'budget_cancelled', 'other'))",
        )
        batch_op.create_check_constraint(
            'ck_request_history_channel',
            "channel IS NULL OR (status = 'shared_with_client' AND channel IN "
            "('whatsapp', 'email', 'in_person', 'other'))",
        )
    _create_append_only(TABLE)


def downgrade() -> None:
    _drop_append_only(TABLE)
    with op.batch_alter_table(TABLE, schema=None) as batch_op:
        batch_op.drop_constraint('ck_request_history_channel', type_='check')
        batch_op.drop_constraint('ck_request_history_lost_reason', type_='check')
        batch_op.drop_column('channel')
        batch_op.drop_column('lost_reason')
    _create_append_only(TABLE)


# ---------------------------------------------------------------------------
# Append-only triggers (same pattern as revisions 0001 and 0002)
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
