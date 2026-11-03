"""CRM 1: client contacts, client history, request events

- client_contacts: several contact people per client, one primary, archived instead of deleted.
  Each client's existing single contact (clients.contact_*) is copied in as its primary contact,
  then those columns are removed.
- client_history: append-only record of client and contact changes (who, when, what, why).
- request_events: append-only non-status events on a request (BD owner transferred).
- opportunity_history.details: what changed when an opportunity's fields are edited (no stage change).

The old columns are dropped with ALTER TABLE ... DROP COLUMN (SQLite 3.35+ / PostgreSQL) rather
than a table rebuild: clients is referenced by other tables, and migrations run with foreign keys on.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-21 12:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None

ROLES = "('commercial_head', 'account_manager', 'business_development')"
EVENTS = ("'created', 'updated', 'archived', 'owner_transferred', 'contact_added', 'contact_updated', "
          "'contact_archived', 'opportunity_added'")
OLD_COLUMNS = (("contact_name", 200), ("contact_title", 200), ("contact_phone", 50), ("contact_email", 200))


def upgrade() -> None:
    op.create_table(
        'client_contacts',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('client_id', sa.String(length=12), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=True),
        sa.Column('phone', sa.String(length=50), nullable=True),
        sa.Column('email', sa.String(length=200), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('is_primary', sa.Boolean(), nullable=False),
        sa.Column('archived_at', sa.DateTime(), nullable=True),
        sa.Column('row_version', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('client_contacts', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_client_contacts_client_id'), ['client_id'], unique=False)

    op.create_table(
        'client_history',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('client_id', sa.String(length=12), nullable=False),
        sa.Column('event', sa.String(length=40), nullable=False),
        sa.Column('changed_by_id', sa.String(length=50), nullable=False),
        sa.Column('role', sa.String(length=40), nullable=False),
        sa.Column('changed_at', sa.DateTime(), nullable=False),
        sa.Column('reason', sa.Text(), nullable=True),
        sa.Column('details', sa.JSON(), nullable=True),
        sa.CheckConstraint(f"event IN ({EVENTS})", name='ck_client_history_event'),
        sa.CheckConstraint(f"role IN {ROLES}", name='ck_client_history_role'),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id']),
        sa.ForeignKeyConstraint(['changed_by_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('client_history', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_client_history_client_id'), ['client_id'], unique=False)

    op.create_table(
        'request_events',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('request_id', sa.String(length=16), nullable=False),
        sa.Column('event', sa.String(length=40), nullable=False),
        sa.Column('changed_by_id', sa.String(length=50), nullable=False),
        sa.Column('role', sa.String(length=40), nullable=False),
        sa.Column('changed_at', sa.DateTime(), nullable=False),
        sa.Column('from_user_id', sa.String(length=50), nullable=True),
        sa.Column('to_user_id', sa.String(length=50), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.CheckConstraint("event IN ('bd_owner_transferred')", name='ck_request_events_event'),
        sa.CheckConstraint(f"role IN {ROLES}", name='ck_request_events_role'),
        sa.ForeignKeyConstraint(['request_id'], ['proposal_requests.id']),
        sa.ForeignKeyConstraint(['changed_by_id'], ['users.id']),
        sa.ForeignKeyConstraint(['from_user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['to_user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('request_events', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_request_events_request_id'), ['request_id'], unique=False)

    # Existing single contacts become each client's primary contact.
    op.execute(
        "INSERT INTO client_contacts (client_id, name, title, phone, email, notes, is_primary, archived_at, "
        "row_version, created_at, updated_at) "
        "SELECT id, contact_name, contact_title, contact_phone, contact_email, NULL, true, NULL, 1, created_at, updated_at "
        "FROM clients WHERE contact_name IS NOT NULL AND trim(contact_name) <> ''"
    )
    for column, _ in OLD_COLUMNS:
        op.execute(f"ALTER TABLE clients DROP COLUMN {column}")

    # A plain ADD COLUMN (no table rebuild), so the existing append-only triggers stay in place.
    op.add_column('opportunity_history', sa.Column('details', sa.JSON(), nullable=True))

    _create_append_only("client_history")
    _create_append_only("request_events")


def downgrade() -> None:
    op.execute("ALTER TABLE opportunity_history DROP COLUMN details")
    _drop_append_only("request_events")
    _drop_append_only("client_history")
    for column, length in OLD_COLUMNS:
        op.execute(f"ALTER TABLE clients ADD COLUMN {column} VARCHAR({length})")
    for column, source in zip((c for c, _ in OLD_COLUMNS), ("name", "title", "phone", "email")):
        op.execute(
            f"UPDATE clients SET {column} = (SELECT {source} FROM client_contacts cc WHERE cc.client_id = clients.id "
            "AND cc.is_primary = true AND cc.archived_at IS NULL ORDER BY cc.id LIMIT 1)"
        )
    for table in ('request_events', 'client_history', 'client_contacts'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_index(batch_op.f(f'ix_{table}_{"request_id" if table == "request_events" else "client_id"}'))
        op.drop_table(table)


# ---------------------------------------------------------------------------
# Append-only triggers (same pattern as revisions 0001-0004)
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
