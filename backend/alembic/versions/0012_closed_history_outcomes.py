"""History from the 2026 tracker: closed outcomes

- proposal_requests / request_status_history: statuses 'closed_unrecorded' ("Closed · outcome not
  recorded") and 'closed_postponed' ("Closed · postponed"), set by python -m app.close_imported.
- opportunities / opportunity_history: stage 'closed_no_result' (closed to match, neither won nor lost).

Only CHECK texts change (tables rebuilt on SQLite with the 0007 helper).

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-23 10:00:00
"""

import importlib.util
from pathlib import Path

revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None

_spec = importlib.util.spec_from_file_location("_m0007", Path(__file__).with_name("0007_real_data_import.py"))
_m0007 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m0007)
_replace_checks = _m0007._replace_checks

OLD_STATUS = "'accepted', 'rejected', 'cancelled')"
NEW_STATUS = "'accepted', 'rejected', 'cancelled', 'closed_unrecorded', 'closed_postponed')"
OLD_STAGE = "'negotiation', 'won', 'lost')"
NEW_STAGE = "'negotiation', 'won', 'lost', 'closed_no_result')"


def upgrade() -> None:
    _replace_checks("proposal_requests", [(OLD_STATUS, NEW_STATUS)])
    _replace_checks("request_status_history", [(OLD_STATUS, NEW_STATUS)])
    _replace_checks("opportunities", [(OLD_STAGE, NEW_STAGE)])
    _replace_checks("opportunity_history", [(OLD_STAGE, NEW_STAGE)])  # from_stage and to_stage both


def downgrade() -> None:
    # Revision 0011 cannot store these: the closed history goes back to its last open status (development only).
    _replace_checks("opportunity_history", [(NEW_STAGE, OLD_STAGE)],
                    ["DELETE FROM {t} WHERE to_stage = 'closed_no_result' OR from_stage = 'closed_no_result'"])
    _replace_checks("opportunities", [(NEW_STAGE, OLD_STAGE)],
                    ["UPDATE {t} SET stage = 'proposal_requested' WHERE stage = 'closed_no_result'"])
    _replace_checks("request_status_history", [(NEW_STATUS, OLD_STATUS)],
                    ["DELETE FROM {t} WHERE status IN ('closed_unrecorded', 'closed_postponed')"])
    _replace_checks("proposal_requests", [(NEW_STATUS, OLD_STATUS)],
                    ["UPDATE {t} SET status = 'in_progress' WHERE status = 'closed_unrecorded'",
                     "UPDATE {t} SET status = 'postponed' WHERE status = 'closed_postponed'"])
