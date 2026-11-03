"""
Server-generated public IDs: CL-NNNN, OPP-NNNN and PR-YYYY-NNNN (year = Africa/Cairo year).

Numbers come from the id_counters row, incremented inside the caller's transaction
with a single UPDATE ... RETURNING, so two transactions never receive the same number
(SQLite serialises writers; PostgreSQL row-locks the counter until commit). The
primary-key uniqueness of the IDs is the final backstop.
"""

from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..clock import CAIRO
from ..models import IdCounter, ProposalRequest


def next_number(db: Session, sequence: str) -> int:
    issued = db.execute(
        update(IdCounter)
        .where(IdCounter.name == sequence)
        .values(last_value=IdCounter.last_value + 1)
        .returning(IdCounter.last_value)
    ).scalar()
    if issued is None:
        db.add(IdCounter(name=sequence, last_value=1))
        db.flush()
        return 1
    return issued


def next_client_id(db: Session) -> str:
    return f"CL-{next_number(db, 'client'):04d}"


def next_opportunity_id(db: Session) -> str:
    return f"OPP-{next_number(db, 'opportunity'):04d}"


def next_request_id(db: Session, now: datetime) -> str:
    """
    PR-YYYY-NNNN, numbered per Africa/Cairo year. If this year's counter does not exist yet
    but requests for the year do (e.g. data loaded without counters), numbering continues
    after the highest existing number instead of colliding with it.
    """
    year = now.astimezone(CAIRO).year
    sequence = f"request:{year}"
    if db.get(IdCounter, sequence) is None:
        prefix = f"PR-{year}-"
        ids = db.scalars(select(ProposalRequest.id).where(ProposalRequest.id.like(f"{prefix}%"))).all()
        highest = max((int(i[len(prefix):]) for i in ids if i[len(prefix):].isdigit()), default=0)
        db.add(IdCounter(name=sequence, last_value=highest))
        db.flush()
    return f"PR-{year}-{next_number(db, sequence):04d}"
