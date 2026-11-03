"""
DEMO DATA, DEVELOPMENT ONLY. Fictional clients and numbers, real team names.
Ported from the frontend's src/demo/seed.js (users, clients, opportunities, proposal
requests in seed/requests.py); tests
compare the two. Dates are relative to "today" in Africa/Cairo when seeding runs.

Never call this directly: use `python -m app.seed demo`, which applies the guards.
"""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from ..config_domain import ACCOUNT_MANAGER as AM, BUSINESS_DEVELOPMENT as BD, COMMERCIAL_HEAD as CH, EXECUTIVE as EX
from ..config_domain import BRAND_AM_ROUTING
from ..config_domain import GRASSHOPPERS as G, TEAM_UP as T
from ..database import utcnow
from ..identity import Actor
from ..domain.access import default_privileges, set_privileges
from ..models import BrandRouting, Client, ClientBrand, ClientContact, User, UserRole
from ..services.ids import next_client_id
from ..services.opportunities import create_opportunity
from .requests import load_demo_requests

SEED_VERSION = "2"  # 2 = adds proposal requests

# (id, name, initials, avatar tone, roles, brand, job title, email). Privileges: the roles' defaults.
# Marketing and Operations people are not seeded: they are created on the account screen.
USERS = [
    ("u-noha", "Noha El Kenawy", "NK", 1, [CH], None, "Commercial Head", "noha@eventflow.example"),
    ("u-mariam-elkhayat", "Mariam El Khayat", "MK", 2, [BD, AM], G, "Senior Account Manager",
     "mariam.elkhayat@eventflow.example"),
    ("u-mariam-dimitri", "Mariam Dimitri", "MD", 3, [AM], T, "Account Manager", "mariam.dimitri@eventflow.example"),
    ("u-abdelrahman", "Abdelrahman Shams", "AB", 4, [BD], None, "Business Development Executive",
     "abdelrahman@eventflow.example"),
    ("u-sherine", "Sherine El Tabakh", "ST", 5, [BD], None, "Business Development Executive", "sherine@eventflow.example"),
    ("u-ahmed", "Ahmed Seif", "AS", 6, [BD], None, "Business Development Executive", "ahmed@eventflow.example"),
    ("u-doaa", "Doaa", "DO", 1, [EX], None, "Managing Director", "doaa@eventflow.example"),
    ("u-tony", "Tony", "TO", 2, [EX], None, "Business Unit Director", "tony@eventflow.example"),
]

BRINGS_IN_CLIENTS = ("u-noha", "u-doaa")

MK, AB, ST, AS = "u-mariam-elkhayat", "u-abdelrahman", "u-sherine", "u-ahmed"

# (key, name, type, brands, city, (contact name, title, phone, email), owner) -> CL-0001.. in this order
CLIENTS = [
    ("c-01", "Crescent Valley International School", "school", [G], "New Cairo",
     ("Rania Fouad", "Activities Coordinator", "+20 100 555 0101", "r.fouad@crescentvalley.example"), MK),
    ("c-02", "Lotusfield Language School", "school", [G], "Giza",
     ("Hany Saber", "Deputy Principal", "+20 100 555 0102", "h.saber@lotusfield.example"), ST),
    ("c-03", "Heliopolis Horizon Academy", "school", [G], "Cairo",
     ("Dina Lotfy", "Head of Student Life", "+20 100 555 0103", "d.lotfy@horizonacademy.example"), AB),
    ("c-04", "Sunstone British School", "school", [G], "Sheikh Zayed",
     ("Karim Nabil", "Primary Years Lead", "+20 100 555 0104", "k.nabil@sunstone.example"), MK),
    ("c-05", "Delta Lighthouse School", "school", [G], "Alexandria",
     ("Mona Adel", "Trips Officer", "+20 100 555 0105", "m.adel@deltalighthouse.example"), AS),
    ("c-06", "Oakpalm American School", "school", [G], "6th of October",
     ("Youssef Kamal", "Elementary Principal", "+20 100 555 0106", "y.kamal@oakpalm.example"), ST),
    ("c-07", "Papyrus Fintech", "corporate", [T], "Cairo",
     ("Salma Hegazy", "People & Culture Manager", "+20 100 555 0107", "s.hegazy@papyrusfintech.example"), AB),
    ("c-08", "Harbor Line Logistics", "corporate", [T], "Alexandria",
     ("Tarek Mansour", "HR Director", "+20 100 555 0108", "t.mansour@harborline.example"), AS),
    ("c-09", "Medora Pharma", "corporate", [T, G], "6th of October",
     ("Nourhan Zaki", "Employee Engagement Lead", "+20 100 555 0109", "n.zaki@medorapharma.example"), ST),
    ("c-10", "Obelisk Telecom", "corporate", [T], "New Cairo",
     ("Omar Ragab", "HR Business Partner", "+20 100 555 0110", "o.ragab@obelisktelecom.example"), AB),
    ("c-11", "BrightWave Events Agency", "agency", [T, G], "Cairo",
     ("Laila Hamdy", "Account Director", "+20 100 555 0111", "l.hamdy@brightwave.example"), AS),
    ("c-12", "Riverbend Community Club", "other", [G, T], "Giza",
     ("Sameh Wahba", "Events Committee Chair", "+20 100 555 0112", "s.wahba@riverbend.example"), MK),
]

# (client key, brand, service, owner, stage, value, participants, event (days, precision), next action, next action days, lost reason)
OPPORTUNITIES = [
    ("c-10", T, "team_building", AB, "new_lead", 180000, 120, (75, "day"), "Intro meeting with HR", 2, None),
    ("c-05", G, "school_trip", AS, "contacted", 95000, 80, (60, "day"), "Send brochure and sample itinerary", 0, None),
    ("c-01", G, "summer_camp", MK, "requirements_gathered", 420000, 150, (240, "month"), "Finalise and submit proposal request", 1, None),
    ("c-08", T, "family_day", AS, "requirements_gathered", 260000, 300, (45, "day"), "Confirm venue preference with HR", -1, None),
    ("c-04", G, "sleepover", MK, "proposal_requested", 85000, 60, (35, "day"), "Wait for proposal, then book client call", 4, None),
    ("c-07", T, "corporate_event", AB, "proposal_requested", 550000, 400, (50, "day"), "Check proposal progress with AM", 3, None),
    ("c-02", G, "school_trip", ST, "proposal_requested", 120000, 110, (28, "day"), "Confirm bus count with school", 1, None),
    ("c-09", T, "team_building", ST, "proposal_requested", 210000, 90, (40, "day"), "Share proposal once ready", 2, None),
    ("c-03", G, "explorers_league", AB, "proposal_requested", 160000, 70, (55, "day"), "Send headcount per grade to AM", -3, None),
    ("c-11", T, "event_activation", AS, "proposal_requested", 340000, 500, (30, "day"), "Get brand guidelines from agency", 0, None),
    ("c-01", G, "school_trip", MK, "proposal_requested", 135000, 120, (21, "day"), "Share proposal with school", 0, None),
    ("c-10", T, "family_day", AB, "proposal_requested", 300000, 350, (65, "day"), "Share proposal with HR", 1, None),
    ("c-06", G, "kids_activity", ST, "negotiation", 70000, 90, (18, "day"), "Feedback call with principal", 0, None),
    ("c-12", T, "family_day", MK, "negotiation", 190000, 250, (33, "day"), "Follow up on proposal feedback", 2, None),
    ("c-08", T, "team_building", AS, "negotiation", 230000, 100, (26, "day"), "Send revised activity list", 0, None),
    ("c-05", G, "summer_camp", AS, "won", 380000, 140, (210, "month"), "Hand over to Operations", 5, None),
    ("c-09", G, "kids_activity", ST, "won", 65000, 60, (12, "day"), "Hand over to Operations", 1, None),
    ("c-07", T, "team_building", AB, "lost", 175000, 80, (20, "day"), None, None, "competitor"),
]


def cairo_today(now: datetime | None = None) -> date:
    return (now or utcnow()).astimezone(ZoneInfo("Africa/Cairo")).date()


def load_demo_data(db: Session, now: datetime | None = None, storage=None) -> dict:
    """Inserts the demo dataset into an EMPTY database. Does not commit."""
    now = now or utcnow()
    today = cairo_today(now)
    day = lambda n: today + timedelta(days=n)  # noqa: E731

    for uid, name, initials, tone, roles, brand, job_title, email in USERS:
        user = User(id=uid, name=name, initials=initials, avatar_tone=tone, brand=brand, active=True, email=email,
                    job_title=job_title, created_at=now, updated_at=now)
        # Noha and Doaa bring in clients themselves (own clients and requests, no BD role).
        set_privileges(user, {**default_privileges(roles), **({"bringsInClients": True} if uid in BRINGS_IN_CLIENTS else {})})
        user.roles = [UserRole(role=r, position=i) for i, r in enumerate(roles)]
        db.add(user)
    db.flush()
    for brand, am in BRAND_AM_ROUTING.items():  # the starting routing (changed later in Settings)
        db.add(BrandRouting(brand=brand, am_user_id=am, updated_at=now))
    db.flush()

    client_ids = {}
    for key, name, ctype, brands, city, contact, owner in CLIENTS:
        client = Client(
            id=next_client_id(db), name=name, client_type=ctype, city=city,
            owner_id=owner, created_at=now, updated_at=now,
        )
        client.brands = [ClientBrand(brand=b, position=i) for i, b in enumerate(brands)]
        client.contacts = [ClientContact(name=contact[0], title=contact[1], phone=contact[2], email=contact[3],
                                         is_primary=True, created_at=now, updated_at=now)]
        db.add(client)
        db.flush()
        client_ids[key] = client.id

    for (ckey, brand, service, owner, stage, value, participants, (event_days, precision),
         next_action, next_days, lost_reason) in OPPORTUNITIES:
        create_opportunity(
            db,
            actor=Actor(user_id=owner, active_role=BD),
            client_id=client_ids[ckey], brand=brand, service=service, owner_id=owner, stage=stage,
            estimated_value=value, participants=participants,
            event_date=day(event_days), event_date_precision=precision,
            next_action=next_action, next_action_date=day(next_days) if next_days is not None else None,
            lost_reason=lost_reason, reason_code="seed", note="Demo seed data", now=now,
        )
    requests = load_demo_requests(db, now, today, storage)
    return {"users": len(USERS), "clients": len(CLIENTS), "opportunities": len(OPPORTUNITIES),
            "requests": requests, "client_ids": client_ids}
