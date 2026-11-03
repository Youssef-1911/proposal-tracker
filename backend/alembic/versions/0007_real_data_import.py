"""Real-data phase: "Brings in clients", Postponed, event date ranges, imported records

- users.brings_in_clients: the fifth access switch. On for everyone with the Business Development
  role, and for Noha El Kenawy and Doaa (they own clients and requests without a BD role).
- proposal_requests: Postponed status (with follow_up_on), event_end_date, "Date not set yet"
  (event_date_precision 'unset'), and imported / import_row / original_status for rows imported
  from the 2026 tracker (import_row is unique, so re-running the import never duplicates).
- request_status_history: Postponed entries (follow_up_on), the imported entry flag, the lost
  reason "Not recorded" (imported data only).
- opportunities: event_end_date, event_name and imported.
- History role CHECKs allow every role (Executives with "Brings in clients" now write history);
  request_events also records 'assigned_am_changed' (an Account Manager's requests moved when
  they are deactivated).

proposal_requests is referenced by five tables and migrations run with foreign keys on. On
SQLite its CHECKs are widened by rebuilding it under PRAGMA defer_foreign_keys (the copy goes
back into a table with the SAME name before the transaction commits, so every reference is valid
again at commit). The other rebuilt tables are children; their append-only triggers and indexes
are re-created as they were. PostgreSQL simply replaces the constraints.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-22 10:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None

OLD_ROLES = "role IN ('commercial_head', 'account_manager', 'business_development')"
NEW_ROLES = ("role IN ('commercial_head', 'account_manager', 'business_development', 'executive', 'marketing', "
             "'operations')")
OLD_STATUS = "'shared_with_client', 'revision_requested'"
NEW_STATUS = "'shared_with_client', 'postponed', 'revision_requested'"
OLD_PRECISION = "event_date_precision IN ('day', 'month')"
NEW_PRECISION = "event_date_precision IN ('day', 'month', 'unset')"
OLD_LOST = "'budget_cancelled', 'other')"
NEW_LOST = "'budget_cancelled', 'other', 'not_recorded')"
OLD_EVENTS = "event IN ('bd_owner_transferred')"
NEW_EVENTS = "event IN ('bd_owner_transferred', 'assigned_am_changed')"

# table -> [(old text, new text)] for the widened CHECKs
WIDEN = {
    "proposal_requests": [(OLD_STATUS, NEW_STATUS), (OLD_PRECISION, NEW_PRECISION)],
    "request_status_history": [(OLD_STATUS, NEW_STATUS), (OLD_ROLES, NEW_ROLES), (OLD_LOST, NEW_LOST)],
    "opportunity_history": [(OLD_ROLES, NEW_ROLES)],
    "client_history": [(OLD_ROLES, NEW_ROLES)],
    "request_events": [(OLD_EVENTS, NEW_EVENTS), (OLD_ROLES, NEW_ROLES)],
}


def upgrade() -> None:
    bind = op.get_bind()
    op.add_column('users', sa.Column('brings_in_clients', sa.Boolean(), nullable=False, server_default=sa.false()))
    bind.execute(sa.text("UPDATE users SET brings_in_clients = :on WHERE id IN "
                         "(SELECT user_id FROM user_roles WHERE role = 'business_development') OR id IN ('u-noha', 'u-doaa')"),
                 {"on": True})

    op.add_column('opportunities', sa.Column('event_end_date', sa.Date(), nullable=True))
    op.add_column('opportunities', sa.Column('event_name', sa.String(length=80), nullable=True))
    op.add_column('opportunities', sa.Column('imported', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('proposal_requests', sa.Column('event_end_date', sa.Date(), nullable=True))
    op.add_column('proposal_requests', sa.Column('event_name', sa.String(length=80), nullable=True))
    op.add_column('proposal_requests', sa.Column('follow_up_on', sa.Date(), nullable=True))
    op.add_column('proposal_requests', sa.Column('imported', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('proposal_requests', sa.Column('import_row', sa.Integer(), nullable=True))
    op.add_column('proposal_requests', sa.Column('original_status', sa.String(length=60), nullable=True))
    op.add_column('proposal_requests', sa.Column('needs_review', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('request_status_history', sa.Column('follow_up_on', sa.Date(), nullable=True))
    op.add_column('request_status_history', sa.Column('imported', sa.Boolean(), nullable=False, server_default=sa.false()))

    for table, changes in WIDEN.items():
        _replace_checks(table, changes)
    op.create_index('ux_requests_import_row', 'proposal_requests', ['import_row'], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    op.drop_index('ux_requests_import_row', table_name='proposal_requests')
    # Revision 0006 cannot store what this phase added: map or remove it (development only).
    fixes = {
        "proposal_requests": [
            "UPDATE {t} SET status = 'shared_with_client' WHERE status = 'postponed'",
            "UPDATE {t} SET event_date_precision = 'day' WHERE event_date_precision = 'unset'",
        ],
        "request_status_history": [
            "DELETE FROM {t} WHERE status = 'postponed'",
            "UPDATE {t} SET lost_reason = 'other' WHERE lost_reason = 'not_recorded'",
            f"DELETE FROM {{t}} WHERE NOT ({OLD_ROLES})",
        ],
        "opportunity_history": [f"DELETE FROM {{t}} WHERE NOT ({OLD_ROLES})"],
        "client_history": [f"DELETE FROM {{t}} WHERE NOT ({OLD_ROLES})"],
        "request_events": ["DELETE FROM {t} WHERE event = 'assigned_am_changed'", f"DELETE FROM {{t}} WHERE NOT ({OLD_ROLES})"],
    }
    for table in reversed(list(WIDEN)):
        _replace_checks(table, [(new, old) for old, new in WIDEN[table]], fixes[table])
    for table, column in (('request_status_history', 'imported'), ('request_status_history', 'follow_up_on'),
                          ('proposal_requests', 'needs_review'), ('proposal_requests', 'original_status'), ('proposal_requests', 'import_row'),
                          ('proposal_requests', 'imported'), ('proposal_requests', 'follow_up_on'),
                          ('proposal_requests', 'event_end_date'), ('proposal_requests', 'event_name'), ('opportunities', 'imported'),
                          ('opportunities', 'event_end_date'), ('opportunities', 'event_name'), ('users', 'brings_in_clients')):
        op.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
    del bind


# ---------------------------------------------------------------------------

def _replace_checks(table: str, changes, fixes=()) -> None:
    """Rewrites the CHECK texts of one table (and runs `fixes` on its rows first), keeping everything else."""
    bind = op.get_bind()
    if bind.dialect.name != "sqlite":
        _replace_checks_postgres(table, changes, fixes)
        return
    sql = bind.execute(sa.text("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = :t"), {"t": table}).scalar()
    for old, new in changes:
        if old not in sql:
            raise RuntimeError(f"{table}: expected CHECK text not found: {old}")
        sql = sql.replace(old, new)
    indexes = bind.execute(sa.text("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = :t AND sql IS NOT NULL"),
                           {"t": table}).scalars().all()
    triggers = bind.execute(sa.text("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = :t"),
                            {"t": table}).all()
    columns = ", ".join(f'"{r[1]}"' for r in bind.execute(sa.text(f'PRAGMA table_info("{table}")')))
    # References to this table are checked at COMMIT, when the copy is back under the same name.
    op.execute("PRAGMA defer_foreign_keys = ON")
    for name, _ in triggers:
        op.execute(f'DROP TRIGGER "{name}"')
    op.execute(f'CREATE TEMP TABLE "{table}__copy" AS SELECT * FROM "{table}"')
    for fix in fixes:
        op.execute(fix.format(t=f'"{table}__copy"'))
    op.execute(f'DROP TABLE "{table}"')
    op.execute(sql)
    op.execute(f'INSERT INTO "{table}" ({columns}) SELECT {columns} FROM "{table}__copy"')
    op.execute(f'DROP TABLE "{table}__copy"')
    for index_sql in indexes:
        op.execute(index_sql)
    for _, trigger_sql in triggers:
        op.execute(trigger_sql)


def _replace_checks_postgres(table: str, changes, fixes) -> None:
    """Replace each changed CHECK constraint by name (append-only triggers stay; fixes run with them lifted)."""
    bind = op.get_bind()
    rows = bind.execute(sa.text(
        "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = CAST(:t AS regclass) AND contype = 'c'"),
        {"t": table}).all()
    if fixes:
        op.execute(f'ALTER TABLE "{table}" DISABLE TRIGGER USER')
        for fix in fixes:
            op.execute(fix.format(t=f'"{table}"'))
        op.execute(f'ALTER TABLE "{table}" ENABLE TRIGGER USER')
    for name, definition in rows:
        new = definition
        for old, replacement in changes:
            new = new.replace(old, replacement)
        if new != definition:
            op.execute(f'ALTER TABLE "{table}" DROP CONSTRAINT "{name}"')
            op.execute(f'ALTER TABLE "{table}" ADD CONSTRAINT "{name}" {new}')
