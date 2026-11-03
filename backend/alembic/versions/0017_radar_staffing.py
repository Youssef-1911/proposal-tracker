"""Repeat-client radar, the office screen account, and HR staffing (facilitators)

- occasions + occasion_periods: Ramadan, Eid, Easter, Summer season... (names seeded, NO dates: the
  Commercial Head enters each year's start and end in Settings).
- proposal_requests.occasion_id (optional) and .facilitators_needed (set by Operations, the AM or Noha).
- radar_dismissals: "Not this time" on a radar item, until its next occurrence (reason kept).
- facilitators (HR's list; they never log in), facilitator_notes (history of HR's notes),
  facilitator_assignments (who works which event), facilitator_ratings (+ history: editable for 7 days).
- staffing_ratios: per brand and service, one facilitator per N participants (a suggestion only).
- roles: 'hr' and 'office_screen'. request_events: 'facilitators_needed_set'.

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-29 10:00:00
"""

import importlib.util
from pathlib import Path

from alembic import op
import sqlalchemy as sa

revision = '0017'
down_revision = '0016'
branch_labels = None
depends_on = None

_spec = importlib.util.spec_from_file_location("_m0007", Path(__file__).with_name("0007_real_data_import.py"))
_m0007 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m0007)
_replace_checks = _m0007._replace_checks

OLD_ROLES = "role IN ('commercial_head', 'account_manager', 'business_development', 'executive', 'marketing', 'operations')"
NEW_ROLES = ("role IN ('commercial_head', 'account_manager', 'business_development', 'executive', 'marketing', 'operations', "
             "'hr', 'office_screen')")
OLD_EVENTS = "'event_status_set', 'event_confirmed', 'event_postponed')"
NEW_EVENTS = "'event_status_set', 'event_confirmed', 'event_postponed', 'facilitators_needed_set')"
OCCASIONS = ["Ramadan", "Eid al-Fitr", "Eid al-Adha", "Easter", "Summer season", "Back to school", "Christmas", "Halloween",
             "Mid-year", "Year-end"]


def upgrade() -> None:
    occasions = op.create_table(
        'occasions',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('name', sa.String(length=60), nullable=False, unique=True),
        sa.Column('position', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('archived_at', sa.DateTime(), nullable=True),
    )
    op.bulk_insert(occasions, [{"name": n, "position": i} for i, n in enumerate(OCCASIONS)])
    op.create_table(
        'occasion_periods',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('occasion_id', sa.Integer(), sa.ForeignKey('occasions.id'), nullable=False, index=True),
        sa.Column('starts_on', sa.Date(), nullable=False),
        sa.Column('ends_on', sa.Date(), nullable=False),
        sa.Column('updated_by_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.CheckConstraint('ends_on >= starts_on', name='ck_occasion_periods_dates'),
    )
    # Plain columns (SQLite adds no foreign key without rebuilding the table); the app checks the occasion exists.
    op.add_column('proposal_requests', sa.Column('occasion_id', sa.Integer(), nullable=True))
    op.add_column('proposal_requests', sa.Column('facilitators_needed', sa.Integer(), nullable=True))
    op.add_column('proposal_requests', sa.Column('from_radar', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_table(
        'radar_dismissals',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('client_id', sa.String(length=12), sa.ForeignKey('clients.id'), nullable=False, index=True),
        sa.Column('signal', sa.String(length=60), nullable=False),  # "occasion:<id>" or "rhythm"
        sa.Column('until', sa.Date(), nullable=False),
        sa.Column('reason', sa.String(length=300), nullable=True),
        sa.Column('dismissed_by_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('dismissed_at', sa.DateTime(), nullable=False),
    )
    op.create_table(
        'staffing_ratios',
        sa.Column('service_key', sa.String(length=80), primary_key=True),  # "<brand>:<service>"
        sa.Column('per_facilitator', sa.Integer(), nullable=False),
        sa.Column('updated_by_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.CheckConstraint('per_facilitator > 0', name='ck_staffing_ratios_positive'),
    )
    op.create_table(
        'facilitators',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('phone', sa.String(length=40), nullable=False),
        sa.Column('reference', sa.String(length=60), nullable=True),
        sa.Column('skills', sa.JSON(), nullable=True),
        sa.Column('brands', sa.JSON(), nullable=True),
        sa.Column('status', sa.String(length=10), nullable=False, server_default='active'),
        sa.Column('created_by_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.Column('archived_at', sa.DateTime(), nullable=True),
        sa.CheckConstraint("status IN ('active', 'inactive')", name='ck_facilitators_status'),
    )
    op.create_table(
        'facilitator_notes',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('facilitator_id', sa.Integer(), sa.ForeignKey('facilitators.id'), nullable=False, index=True),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('author_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )
    op.create_table(
        'facilitator_assignments',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('request_id', sa.String(length=16), sa.ForeignKey('proposal_requests.id'), nullable=False, index=True),
        sa.Column('facilitator_id', sa.Integer(), sa.ForeignKey('facilitators.id'), nullable=False, index=True),
        sa.Column('assigned_by_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('assigned_at', sa.DateTime(), nullable=False),
        sa.Column('removed_by_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('removed_at', sa.DateTime(), nullable=True),
    )
    op.create_table(
        'facilitator_ratings',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('request_id', sa.String(length=16), sa.ForeignKey('proposal_requests.id'), nullable=False, index=True),
        sa.Column('facilitator_id', sa.Integer(), sa.ForeignKey('facilitators.id'), nullable=False, index=True),
        sa.Column('rater_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('stars', sa.Integer(), nullable=True),
        sa.Column('attended', sa.Boolean(), nullable=False),
        sa.Column('feedback', sa.String(length=1000), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.UniqueConstraint('request_id', 'facilitator_id', 'rater_id', name='uq_facilitator_rating_once'),
        sa.CheckConstraint('stars IS NULL OR (stars BETWEEN 1 AND 5)', name='ck_facilitator_ratings_stars'),
    )
    op.create_table(
        'facilitator_rating_history',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('rating_id', sa.Integer(), sa.ForeignKey('facilitator_ratings.id'), nullable=False, index=True),
        sa.Column('stars', sa.Integer(), nullable=True),
        sa.Column('attended', sa.Boolean(), nullable=False),
        sa.Column('feedback', sa.String(length=1000), nullable=True),
        sa.Column('changed_by_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('changed_at', sa.DateTime(), nullable=False),
    )
    _replace_checks("user_roles", [(OLD_ROLES, NEW_ROLES)])
    _replace_checks("request_events", [(OLD_EVENTS, NEW_EVENTS)])


def downgrade() -> None:
    _replace_checks("request_events", [(NEW_EVENTS, OLD_EVENTS)], ["DELETE FROM {t} WHERE event = 'facilitators_needed_set'"])
    _replace_checks("user_roles", [(NEW_ROLES, OLD_ROLES)], ["DELETE FROM {t} WHERE role IN ('hr', 'office_screen')"])
    for table in ('facilitator_rating_history', 'facilitator_ratings', 'facilitator_assignments', 'facilitator_notes',
                  'facilitators', 'staffing_ratios', 'radar_dismissals'):
        op.drop_table(table)
    for name in ('from_radar', 'facilitators_needed', 'occasion_id'):
        op.execute(f"ALTER TABLE proposal_requests DROP COLUMN {name}")
    op.drop_table('occasion_periods')
    op.drop_table('occasions')
