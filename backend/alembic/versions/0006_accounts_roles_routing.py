"""Accounts, roles and privileges; brand routing in the database

- users: email (unique, stored lower-case), job_title and four privilege switches
  (manage_accounts, see_analytics, send_reminders, see_all_brands). Existing people get an
  email made from their id (@eventflow.example) and their roles' default privileges.
- user_roles: the Executive, Marketing and Operations roles are allowed.
- request_comments: Executives may comment, so their role is allowed there too.
- user_history: append-only record of account changes (who, when, what changed old -> new).
- brand_routing: which Account Manager receives each brand's new requests, editable in
  Settings; filled from today's routing when those Account Managers exist (an empty database
  gets its routing from the seed).
- routing_history: append-only record of routing changes.

New columns are added in place (ALTER TABLE ... ADD COLUMN), never by rebuilding users:
users is referenced by other tables and migrations run with foreign keys on. Only user_roles
and request_comments, which nothing references, are rebuilt to widen their role CHECK.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-21 18:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None

OLD_ROLES = "('commercial_head', 'account_manager', 'business_development')"
NEW_ROLES = "('commercial_head', 'account_manager', 'business_development', 'executive', 'marketing', 'operations')"
BRANDS = "('grasshoppers', 'teamup')"
PRIVILEGES = ("manage_accounts", "see_analytics", "send_reminders", "see_all_brands")
# Same defaults as app/config_domain.ROLE_DEFAULT_PRIVILEGES (kept literal: migrations never import app code).
DEFAULTS = {
    "commercial_head": PRIVILEGES,
    "executive": ("see_analytics", "send_reminders", "see_all_brands"),
}
STARTING_ROUTING = {"grasshoppers": "u-mariam-elkhayat", "teamup": "u-mariam-dimitri"}


def upgrade() -> None:
    bind = op.get_bind()

    # ---- users: new columns, filled for existing people ----
    op.add_column('users', sa.Column('email', sa.String(length=254), nullable=False, server_default=''))
    op.add_column('users', sa.Column('job_title', sa.String(length=200), nullable=True))
    for column in PRIVILEGES:
        op.add_column('users', sa.Column(column, sa.Boolean(), nullable=False, server_default=sa.false()))
    users = bind.execute(sa.text("SELECT id FROM users")).scalars().all()
    for user_id in users:
        local = user_id.removeprefix("u-").replace("-", ".") or "user"
        bind.execute(sa.text("UPDATE users SET email = :email WHERE id = :id"),
                     {"email": f"{local}@eventflow.example", "id": user_id})
    for role, columns in DEFAULTS.items():
        sets = ", ".join(f"{c} = :on" for c in columns)
        bind.execute(sa.text(f"UPDATE users SET {sets} WHERE id IN (SELECT user_id FROM user_roles WHERE role = :role)"),
                     {"on": True, "role": role})
    op.create_index('ux_users_email', 'users', ['email'], unique=True)

    # ---- wider role CHECKs ----
    _rebuild_user_roles(NEW_ROLES)
    _rebuild_request_comments(NEW_ROLES)

    # ---- account history ----
    op.create_table(
        'user_history',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('user_id', sa.String(length=50), nullable=False),
        sa.Column('event', sa.String(length=30), nullable=False),
        sa.Column('changed_by_id', sa.String(length=50), nullable=False),
        sa.Column('role', sa.String(length=40), nullable=False),
        sa.Column('changed_at', sa.DateTime(), nullable=False),
        sa.Column('details', sa.JSON(), nullable=True),
        sa.CheckConstraint("event IN ('created', 'updated', 'deactivated', 'reactivated')", name='ck_user_history_event'),
        sa.CheckConstraint(f"role IN {NEW_ROLES}", name='ck_user_history_role'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['changed_by_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_user_history_user_id', 'user_history', ['user_id'], unique=False)
    _create_append_only('user_history')

    # ---- routing ----
    op.create_table(
        'brand_routing',
        sa.Column('brand', sa.String(length=20), nullable=False),
        sa.Column('am_user_id', sa.String(length=50), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.Column('row_version', sa.Integer(), nullable=False),
        sa.CheckConstraint(f"brand IN {BRANDS}", name='ck_brand_routing_brand'),
        sa.ForeignKeyConstraint(['am_user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('brand'),
    )
    op.create_table(
        'routing_history',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('brand', sa.String(length=20), nullable=False),
        sa.Column('from_user_id', sa.String(length=50), nullable=True),
        sa.Column('to_user_id', sa.String(length=50), nullable=False),
        sa.Column('changed_by_id', sa.String(length=50), nullable=False),
        sa.Column('role', sa.String(length=40), nullable=False),
        sa.Column('changed_at', sa.DateTime(), nullable=False),
        sa.CheckConstraint(f"brand IN {BRANDS}", name='ck_routing_history_brand'),
        sa.CheckConstraint(f"role IN {NEW_ROLES}", name='ck_routing_history_role'),
        sa.ForeignKeyConstraint(['from_user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['to_user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['changed_by_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_routing_history_brand', 'routing_history', ['brand'], unique=False)
    _create_append_only('routing_history')

    for brand, wanted in STARTING_ROUTING.items():
        am = bind.execute(sa.text(
            "SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'account_manager' "
            "WHERE u.active = :on AND u.brand = :brand ORDER BY CASE WHEN u.id = :wanted THEN 0 ELSE 1 END, u.id"),
            {"on": True, "brand": brand, "wanted": wanted}).scalars().first()
        if am:
            bind.execute(sa.text("INSERT INTO brand_routing (brand, am_user_id, updated_at, row_version) "
                                 "VALUES (:brand, :am, CURRENT_TIMESTAMP, 1)"), {"brand": brand, "am": am})


def downgrade() -> None:
    bind = op.get_bind()
    _drop_append_only('routing_history')
    op.drop_index('ix_routing_history_brand', table_name='routing_history')
    op.drop_table('routing_history')
    op.drop_table('brand_routing')
    _drop_append_only('user_history')
    op.drop_index('ix_user_history_user_id', table_name='user_history')
    op.drop_table('user_history')

    # Revision 0005 cannot store what the new roles wrote: Executives' comments and the new role
    # assignments are removed (the accounts themselves stay). Comments are append-only, so their
    # guard is lifted only for this, inside the rebuild.
    _rebuild_request_comments(OLD_ROLES, drop_new_roles=True)
    bind.execute(sa.text(f"DELETE FROM user_roles WHERE role NOT IN {OLD_ROLES}"))
    _rebuild_user_roles(OLD_ROLES)

    op.drop_index('ux_users_email', table_name='users')
    for column in ('email', 'job_title', *PRIVILEGES):
        op.execute(f"ALTER TABLE users DROP COLUMN {column}")


# ---------------------------------------------------------------------------
# Rebuilding the two small tables whose role CHECK widens (nothing references them)
# ---------------------------------------------------------------------------

def _is_sqlite() -> bool:
    return op.get_bind().dialect.name == "sqlite"


def _rebuild_user_roles(roles: str) -> None:
    if not _is_sqlite():
        op.execute("ALTER TABLE user_roles DROP CONSTRAINT ck_user_roles_role")
        op.execute(f"ALTER TABLE user_roles ADD CONSTRAINT ck_user_roles_role CHECK (role IN {roles})")
        return
    op.execute(
        "CREATE TABLE user_roles_new ("
        "user_id VARCHAR(50) NOT NULL, role VARCHAR(40) NOT NULL, position INTEGER NOT NULL, "
        f"CONSTRAINT ck_user_roles_role CHECK (role IN {roles}), "
        "FOREIGN KEY(user_id) REFERENCES users (id), PRIMARY KEY (user_id, role))"
    )
    op.execute("INSERT INTO user_roles_new (user_id, role, position) SELECT user_id, role, position FROM user_roles")
    op.execute("DROP TABLE user_roles")
    op.execute("ALTER TABLE user_roles_new RENAME TO user_roles")


def _rebuild_request_comments(roles: str, drop_new_roles: bool = False) -> None:
    _drop_append_only('request_comments')
    if drop_new_roles:
        op.execute(f"DELETE FROM request_comments WHERE role NOT IN {roles}")
    if not _is_sqlite():
        op.execute("ALTER TABLE request_comments DROP CONSTRAINT ck_request_comments_role")
        op.execute(f"ALTER TABLE request_comments ADD CONSTRAINT ck_request_comments_role CHECK (role IN {roles})")
        _create_append_only('request_comments')
        return
    op.execute(
        "CREATE TABLE request_comments_new ("
        "id INTEGER NOT NULL, request_id VARCHAR(16) NOT NULL, author_id VARCHAR(50) NOT NULL, "
        "role VARCHAR(40) NOT NULL, body TEXT NOT NULL, created_at DATETIME NOT NULL, "
        "CONSTRAINT ck_request_comments_length CHECK (length(body) BETWEEN 1 AND 2000), "
        f"CONSTRAINT ck_request_comments_role CHECK (role IN {roles}), "
        "FOREIGN KEY(request_id) REFERENCES proposal_requests (id), FOREIGN KEY(author_id) REFERENCES users (id), "
        "PRIMARY KEY (id))"
    )
    op.execute("INSERT INTO request_comments_new (id, request_id, author_id, role, body, created_at) "
               "SELECT id, request_id, author_id, role, body, created_at FROM request_comments")
    op.execute("DROP TABLE request_comments")
    op.execute("ALTER TABLE request_comments_new RENAME TO request_comments")
    op.create_index('ix_request_comments_request_id', 'request_comments', ['request_id'], unique=False)
    _create_append_only('request_comments')


# ---------------------------------------------------------------------------
# Append-only triggers (same pattern as revisions 0001-0005)
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
