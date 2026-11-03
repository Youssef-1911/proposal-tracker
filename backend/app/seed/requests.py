"""
DEMO proposal requests: a one-to-one port of REQUEST_DEFS / buildHistory in the frontend's
src/demo/seed.js (same IDs, statuses, owners, histories, versions and prices).
tests/test_seed_requests_parity.py compares the two field by field.
"""

import hashlib
import math
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from ..config_domain import ACCOUNT_MANAGER, BRAND_AM_ROUTING, BUSINESS_DEVELOPMENT
from ..models import Client, Opportunity, ProposalFile, ProposalRequest, RequestStatusHistory, User
from ..services.ids import next_number

CAIRO = ZoneInfo("Africa/Cairo")

D, SUB, IP, AW, RDY, SH, REV, ACC, REJ, CAN = (
    "draft", "submitted", "in_progress", "awaiting_bd_info", "ready_for_bd", "shared_with_client",
    "revision_requested", "accepted", "rejected", "cancelled",
)
AM_STATUSES = {IP, AW, RDY}

STATUS_PATHS = {
    D: [D],
    SUB: [D, SUB],
    IP: [D, SUB, IP],
    AW: [D, SUB, IP, AW],
    RDY: [D, SUB, IP, RDY],
    SH: [D, SUB, IP, RDY, SH],
    REV: [D, SUB, IP, RDY, SH, REV],
    ACC: [D, SUB, IP, RDY, SH, ACC],
    REJ: [D, SUB, IP, RDY, SH, REJ],
    CAN: [D, SUB, CAN],
}

# created/last: days ago of the first and latest status change; required_in: days from today.
REQUEST_DEFS = [
    dict(opp="OPP-0016", status=REJ, created=55, last=42, required_in=-48, am_price=410000, lost_reason="price",
         summary="Residential 7-day summer camp, 140 students, Red Sea location.",
         note="Client found the residential concept over budget."),
    dict(opp="OPP-0016", status=ACC, created=40, last=15, required_in=-33, am_price=372000,
         path=[D, SUB, IP, RDY, SH, REV, IP, RDY, SH, ACC],
         summary="Day-camp format summer programme, 140 students, 10 days, transport included.",
         note="Signed off by school board."),
    dict(opp="OPP-0018", status=REJ, created=30, last=12, required_in=-24, am_price=168000, lost_reason="competitor",
         summary="Half-day outdoor team building for 80 staff, Sokhna resort.",
         note="Client chose a lower-cost provider."),
    dict(opp="OPP-0014", status=CAN, created=25, last=20, required_in=-18,
         summary="Spring family gathering for club members.",
         note="Duplicate: client merged two events into one family day."),
    dict(opp="OPP-0017", status=ACC, created=22, last=8, required_in=-15, am_price=64000,
         summary="Kids corner and activities for the Medora family day, 60 children aged 4–12.",
         note="Deposit confirmed by client."),
    dict(opp="OPP-0015", status=REV, created=20, last=2, required_in=3, am_price=236000,
         summary="Full-day team building for 100 staff with lunch, Alexandria.",
         note="Client wants a half-day option and a lower per-head price."),
    dict(opp="OPP-0013", status=SH, created=16, last=5, required_in=-8, am_price=68000,
         summary="On-campus activity day for KG and Grade 1, 90 children."),
    dict(opp="OPP-0006", status=CAN, created=12, last=9, required_in=-4,
         summary="Annual gala dinner with entertainment, 400 guests.",
         note="Client moved the event date; replaced by a new request."),
    dict(opp="OPP-0014", status=SH, created=11, last=3, required_in=-4, am_price=182000,
         summary="Family day for 250 club members with kids zone, food stalls and stage show."),
    dict(opp="OPP-0012", status=RDY, created=10, last=0, required_in=2, am_price=285000,
         path=[D, SUB, IP, AW, IP, RDY],
         step_notes={3: "Need confirmed venue capacity and catering preference."},
         summary="Employee family day, 350 attendees, outdoor venue in New Cairo.",
         specific="Shaded seating for 350. Separate kids zone with supervisors. Vegetarian food options."),
    dict(opp="OPP-0011", status=RDY, created=9, last=1, required_in=1, am_price=128000,
         summary="Grade 6 day trip to Alexandria, 120 students, 3 buses, museum and beach visit.",
         specific="Halal lunch boxes for all students. Two wheelchair-accessible seats. Back at school by 15:30."),
    dict(opp="OPP-0009", status=AW, created=8, last=3, required_in=1,
         summary="Explorers League season for Grades 4–6, 70 students, 6 sessions.",
         note="Need confirmed headcount per grade and preferred dates."),
    dict(opp="OPP-0010", status=AW, created=7, last=2, required_in=-1,
         summary="Mall brand activation for agency client, 2 weekends, ~500 visitors per day.",
         note="Please confirm brand guidelines and activation footprint."),
    dict(opp="OPP-0007", status=IP, created=6, last=4, required_in=2,
         summary="Grade 5 science trip, 110 students, 2 locations in Giza."),
    dict(opp="OPP-0008", status=IP, created=5, last=3, required_in=0, file_uploaded=True,
         summary="Leadership team building for 90 managers, half day, indoor venue."),
    dict(opp="OPP-0005", status=SUB, created=3, last=2, required_in=4,
         summary="Year 3 overnight school sleepover, 60 students, campfire and stargazing."),
    dict(opp="OPP-0006", status=SUB, created=2, last=1, required_in=3, created_by="u-noha",
         summary="Annual gala dinner with entertainment, 400 guests, new date."),
    dict(opp="OPP-0003", status=D, created=1, last=1, required_in=6,
         summary="Summer day camp for 150 students aged 8–12, 5 days, transport from school."),
    dict(opp="OPP-0004", status=D, created=0, last=0, required_in=5,
         summary="Family day for 300 employees and families, Alexandria."),
]


def timestamp_days_ago(now: datetime, days: float, hour: int, minute: int) -> datetime:
    """Same as the frontend: that many days ago at hour:minute (Cairo time), never in the future."""
    local = now.astimezone(CAIRO) - timedelta(days=math.floor(days))
    d = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return d if d <= now else now - timedelta(minutes=15)


def load_demo_requests(db: Session, now: datetime, today: date, storage) -> int:
    users = {u.id: u for u in db.query(User).all()}
    year = now.astimezone(CAIRO).year
    for d in REQUEST_DEFS:
        opp = db.get(Opportunity, d["opp"])
        client = db.get(Client, opp.client_id)
        bd_owner = client.owner_id  # relationship owner
        created_by = d.get("created_by", bd_owner)
        assigned_am = BRAND_AM_ROUTING[opp.brand]
        path = d.get("path", STATUS_PATHS[d["status"]])
        last_ready = max((i for i, s in enumerate(path) if s == RDY), default=-1)

        entries, version = [], 1
        for i, status in enumerate(path):
            if status == IP and i > 0 and path[i - 1] == REV:
                version += 1
            t = d["created"] if len(path) == 1 else d["created"] - ((d["created"] - d["last"]) * i) / (len(path) - 1)
            actor = (assigned_am if status in AM_STATUSES
                     else created_by if status in (D, SUB) and i <= 1
                     else bd_owner)
            role = (ACCOUNT_MANAGER if status in AM_STATUSES
                    else BUSINESS_DEVELOPMENT if actor == bd_owner
                    else users[actor].role_ids[0])
            note = d.get("note") if i == len(path) - 1 else d.get("step_notes", {}).get(i)
            entries.append(dict(
                seq=i + 1, status=status, changed_by_id=actor, role=role,
                changed_at=timestamp_days_ago(now, t, 9 + (i * 3) % 8, (i * 17) % 60),
                note=note, version=version,
                am_price=(d.get("am_price") if i == last_ready else None) if status == RDY else None,
                on_behalf_of_id=bd_owner if actor != bd_owner and status not in AM_STATUSES else None,
                lost_reason=d.get("lost_reason") if status == REJ else None,
            ))

        submitted = next((e for e in entries if e["status"] == SUB), None)
        request_id = f"PR-{year}-{next_number(db, f'request:{year}'):04d}"
        req = ProposalRequest(
            id=request_id, opportunity_id=opp.id, client_id=client.id, brand=opp.brand, service=opp.service,
            bd_owner_id=bd_owner, created_by_id=created_by, assigned_am_id=assigned_am,
            submitted_by_id=submitted["changed_by_id"] if submitted else None,
            submitted_at=submitted["changed_at"] if submitted else None,
            status=d["status"], required_by=today + timedelta(days=d["required_in"]),
            event_date=opp.event_date, event_date_precision=opp.event_date_precision,
            participants=opp.participants, requirements_summary=d["summary"],
            specific_requirements=d.get("specific"), am_price=d.get("am_price"), version=entries[-1]["version"],
            price_change=None, last_updated=entries[-1]["changed_at"], created_at=entries[0]["changed_at"],
            updated_at=entries[-1]["changed_at"],
        )
        db.add(req)
        db.flush()
        for e in entries:
            db.add(RequestStatusHistory(request_id=request_id, **e))
        for version, uploaded_at in demo_file_versions(entries, d.get("file_uploaded", False)):
            data = placeholder_pdf(request_id, version)
            db.add(ProposalFile(
                request_id=request_id, version=version, storage_key=storage.save(data), file_type="pdf",
                original_name=f"Proposal v{version}.pdf", size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                uploaded_by_id=assigned_am, role=ACCOUNT_MANAGER, uploaded_at=uploaded_at,
            ))
        db.flush()
    return len(REQUEST_DEFS)


def demo_file_versions(entries: list[dict], file_uploaded: bool) -> list[tuple[int, datetime]]:
    """Same rule as the frontend's demoProposalFiles: one file per version that reached Ready for BD,
    plus the current version's file when file_uploaded (uploaded, not yet marked ready)."""
    files = [(e["version"], e["changed_at"]) for e in entries if e["status"] == RDY]
    last = entries[-1]
    if file_uploaded and all(v != last["version"] for v, _ in files):
        files.append((last["version"], last["changed_at"]))
    return files


def placeholder_pdf(request_id: str, version: int) -> bytes:
    """A tiny, valid one-page PDF standing in for a real proposal (demo data only)."""
    text = f"EventFlow demo proposal {request_id} version {version}".encode()
    stream = b"BT /F1 18 Tf 72 720 Td (" + text + b") Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)

