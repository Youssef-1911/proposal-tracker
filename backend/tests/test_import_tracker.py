"""
The 2026 tracker import (python -m app.import_tracker) on a MADE-UP workbook built here, never the
real file: mapping, dry run, repeatability, refusing the demo database, and how imported records
behave afterwards (exempt from the price/file rules, shown without the importer's name).
"""

from datetime import date, datetime, timezone

import pytest
from sqlalchemy import func, select

from app.database import make_engine, make_sessionmaker
from app.import_tracker import ImportRefused, client_name, event_name, map_service, parse_event, run
from app.models import Client, Opportunity, ProposalRequest, RequestStatusHistory, User
from app.setup_real import setup_real

from .conftest import sqlite_url

NOW = datetime(2026, 10, 22, 9, 0, tzinfo=timezone.utc)
HEADER = ["Brief Sent by", "#", "Brief Date", "Client", "Brief Details", "IEE Brand", "Deadline",
          "Propsal send to BD Date", "Expected Operation Date", "Actual Operation Date", "Feedback", "Comment", "Status", ""]
ROWS = [  # sender, #, brief, client, details, brand, deadline, proposal, expected, actual, status
    ("Noha", 1, date(2026, 1, 5), "Acme Co", "Team Building Event", "Team-Up", date(2026, 1, 12), date(2026, 1, 10),
     None, date(2026, 2, 1), "Event Completed"),
    ("Seif", 2, date(2026, 2, 3), "ACME co.", "Family Day", "Team-Up", None, date(2026, 2, 9), "5-7 March", None, "Canceled"),
    ("Shams", 3, date(2026, 3, 1), "Sunrise School", "Beach Activation", "TGH", None, None, "TBD", None, "Preparing Phase"),
    ("Sherine", 4, date(2026, 3, 2), "Sunrise School", "Day Camp", "TGH", None, date(2026, 3, 8), "May", None, "Pending"),
    ("Mariam", 5, date(2026, 3, 3), "Blue Bank", "Halloween Activation", "TGH", None, None, None, None, "Pending"),
    ("Doaa", 6, date(2026, 4, 1), "Delta Ventures", "Town Hall", "Team-Up", None, date(2026, 4, 5), None, None, "Postponed"),
    ("Nour", 7, date(2026, 4, 2), "Little Stars", "Bring Your Child to Work", "TGH", None, None, None, "10-11 March",
     "Event Completed"),
    ("Noha", 8, date(2026, 4, 3), "Fun Corp", "Fun Day", "GNC", None, None, None, None, "Event Completed"),
    ("Noha", 9, date(2026, 4, 4), "Odd Dates Ltd", "Giveaways", "Team-Up", None, None, "sometime soon", None, "Approved"),
]


def workbook(path):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    ws.append(HEADER)
    for r in ROWS:
        ws.append([*r[:10], None, None, r[10], None])
    wb.save(path)
    return str(path)


@pytest.fixture
def real_db(tmp_path):
    url = sqlite_url(tmp_path / "real.db")
    setup_real(url, now=NOW)
    return url


def counts(url):
    engine = make_engine(url)
    with make_sessionmaker(engine)() as db:
        out = {m.__tablename__: db.scalar(select(func.count()).select_from(m))
               for m in (User, Client, Opportunity, ProposalRequest, RequestStatusHistory)}
    engine.dispose()
    return out


def test_rules_for_services_and_dates():
    assert [map_service("grasshoppers", t) for t in ("Beach Activation", "Family Day", "Day Camp", "Sports Day",
                                                     "Bring your child to work (Christmas Carnival)")] == [
        "activation", "family_day", "summer_camp", "kids_activity", "kids_activity"]
    assert [map_service("teamup", t) for t in ("Team Bonding Event", "Client Team Bonding", "Staff Get Together",
                                               "Town Hall", "Giveaways", "Family Day")] == [
        "team_building", "team_building", "corporate_event", "corporate_event", "event_activation", "family_day"]
    brief = date(2026, 2, 3)
    assert (lambda e: (e.precision, e.start, e.end, e.kind))(parse_event("5-7 March", brief)) == (
        "day", date(2026, 3, 5), date(2026, 3, 7), "range")
    assert (lambda e: (e.precision, e.start, e.kind))(parse_event("May", brief)) == ("month", date(2026, 5, 1), "month")
    assert parse_event("TBD", brief).precision == "unset"
    assert parse_event(46060, brief).start == date(2026, 2, 7), "spreadsheet date numbers"
    assert parse_event("sometime soon", brief).kind == "unparsed"


def test_event_names_for_merged_and_other_rows():
    assert event_name("Talabat Ramadan Iftar Riders – Alex", "Iftar") == "Ramadan Iftar Riders – Alex"
    assert event_name("Talabat Top Achievers", "Gala") == "Top Achievers"
    assert event_name("Fade Easter", "Activation") == "Easter"
    assert event_name("Capgemini Architect Summit", "Summit") == "Architect Summit"
    assert event_name("Fade", "Beach Activation") == "Beach Activation", "nothing left: the brief text"
    assert event_name("Blue Bank", "  Halloween   Activation ") == "Halloween Activation", "not merged: the brief text"
    assert event_name("Blue Bank", "") is None
    assert event_name("June by Sodic", "Family Day") == "June by Sodic", "merged, not starting with the name: kept whole"
    assert event_name("TEB (Azha)", "Beach Activation") == "TEB"
    assert event_name("Ramadan Iftar - Onsite", "Iftar") == "Ramadan Iftar - Onsite"
    assert client_name("Ramadan Riders Football Tournament - Alex") == "Talabat"
    assert event_name("Ramadan Riders Football Tournament – Alex", "Team Bonding Event") ==         "Ramadan Riders Football Tournament – Alex"
    assert [client_name(t) for t in ("Ramadan Iftar", "Talabat Ski", "Instashop / Talabat", "TEB (Azha)",
                                     'General Motors (GM) "GlobalStars Agency')] == [
        "Talabat", "Talabat", "Instashop / Talabat", "Azha", "General Motors (GM) – GlobalStars Agency"]
    long = event_name("Blue Bank", "word " * 30)
    assert len(long) == 80 and long.endswith("…")


def test_dry_run_reports_and_changes_nothing(tmp_path, real_db):
    before = counts(real_db)
    text = run(workbook(tmp_path / "t.xlsx"), database_url=real_db, now=NOW)
    assert counts(real_db) == before
    assert "Requests to create: 8" in text
    assert "row #8: Fun Corp (GNC is not one of our brands)" in text
    assert "Nour" in text and "NEW inactive account: Nour (Former team member)" in text
    assert "ACME co. <- Acme Co" in text, "merged spellings are listed (the latest spelling is kept)"
    assert "Totals: Confirmed 3 · In Progress 1 · Lost 1 · Postponed 1 · Shared with Client 2" in text
    assert "Needs review" not in text, "no review queue any more"
    assert "unparsed: row #9: 'sometime soon'" in text
    assert "Event names: 8 of 8 (the brief is kept exactly as in the sheet). Examples:" in text
    assert 'Events page (Won 3, as of 2026-10-22): Done 2 · Upcoming 1 (of which "Date not set" 1)' in text
    assert 'Top line: "2 done this year · 1 upcoming"' in text
    assert "Date not set #9    Odd Dates Ltd · Giveaways" in text
    assert "Dry run: nothing was changed." in text


def test_apply_imports_once_and_a_second_run_creates_nothing(tmp_path, real_db):
    path = workbook(tmp_path / "t.xlsx")
    text = run(path, database_url=real_db, apply=True, now=NOW)
    assert "APPLIED: 8 requests, 6 clients, 1 new inactive accounts." in text
    after = counts(real_db)
    assert run(path, database_url=real_db, apply=True, now=NOW).count("APPLIED: 0 requests, 0 clients") == 1
    assert counts(real_db) == after, "repeatable: nothing duplicated"

    engine = make_engine(real_db)
    with make_sessionmaker(engine)() as db:
        reqs = {r.import_row: r for r in db.scalars(select(ProposalRequest)).all()}
        # The tracker is our live starting point: open rows stay open work.
        assert {n: r.status for n, r in reqs.items()} == {
            1: "accepted", 2: "rejected", 3: "in_progress", 4: "shared_with_client", 5: "shared_with_client",
            6: "postponed", 7: "accepted", 9: "accepted"}
        assert all(r.imported and r.am_price is None and r.participants is None for r in reqs.values())
        steps = {n: [(h.status, h.changed_at.date()) for h in sorted(r.history, key=lambda h: h.seq)] for n, r in reqs.items()}
        assert steps[1] == [("submitted", date(2026, 1, 5)), ("ready_for_bd", date(2026, 1, 10)),
                            ("shared_with_client", date(2026, 1, 10)), ("accepted", date(2026, 2, 1))], "brief, proposal, Actual"
        assert steps[2][-1] == ("rejected", date(2026, 3, 7)), "no Actual: the Expected Operation Date"
        assert steps[3] == [("submitted", date(2026, 3, 1)), ("in_progress", date(2026, 3, 1))]
        assert [s for s, _ in steps[4]] == ["submitted", "ready_for_bd", "shared_with_client"]
        assert steps[5] == [("submitted", date(2026, 3, 3)), ("shared_with_client", date(2026, 3, 3))], "no proposal date"
        assert steps[6][-1] == ("postponed", date(2026, 4, 5)), "never before the step before it"
        assert steps[9] == [("submitted", date(2026, 4, 4)), ("accepted", date(2026, 4, 4))], "no usable date: the brief date"
        last = sorted(reqs[2].history, key=lambda h: h.seq)[-1]
        assert reqs[2].original_status == "Canceled" and last.lost_reason == "not_recorded"
        assert reqs[1].event_status == "confirmed" and reqs[3].event_status is None
        assert (reqs[2].event_date, reqs[2].event_end_date) == (date(2026, 3, 5), date(2026, 3, 7))
        assert (reqs[3].event_date_precision, reqs[3].event_date) == ("unset", None)
        assert reqs[6].follow_up_on == date(2026, 10, 29), "active: follow up in 7 days"
        assert reqs[1].client_id == reqs[2].client_id, "Acme Co and ACME co. are one client"
        h = sorted(reqs[1].history, key=lambda h: h.seq)[-1]
        assert (h.note, h.imported, h.changed_by_id) == ("From the 2026 tracker (row #1)", True, "u-noha")
        nour = db.get(User, reqs[7].bd_owner_id)
        assert (nour.name, nour.active, nour.job_title) == ("Nour", False, "Former team member")
        little_stars = db.get(Client, reqs[7].client_id)
        assert little_stars.owner_id == "u-noha", "a client last briefed by Nour goes to Noha"
        sunrise = db.get(Client, reqs[3].client_id)
        assert sunrise.owner_id == "u-sherine", "the most recent sender owns the client"
        assert not any(r.needs_review for r in reqs.values()), "no review queue"
        assert db.get(Client, reqs[1].client_id).client_type == "corporate", "Team Up clients are Corporate"
        assert sunrise.client_type == "school", '"School" in the name'
        assert db.get(Client, reqs[5].client_id).client_type == "other"
        assert db.get(Opportunity, reqs[2].opportunity_id).stage == "lost"
        assert db.get(Opportunity, reqs[1].opportunity_id).stage == "won"
        assert db.get(Opportunity, reqs[3].opportunity_id).stage == "proposal_requested"
        assert db.get(Opportunity, reqs[4].opportunity_id).stage == "negotiation"
        assert (reqs[1].event_name, reqs[1].requirements_summary) == ("Team Building Event", "Team Building Event"),             "the brief is kept as in the sheet; no \"Event: ...\" line"
        assert db.get(Opportunity, reqs[1].opportunity_id).event_name == "Team Building Event"
    engine.dispose()


def test_the_demo_database_is_never_imported_into(tmp_path, seeded, db_url):
    with pytest.raises(ImportRefused, match="not the real one"):
        run(workbook(tmp_path / "t.xlsx"), database_url=db_url, apply=True, now=NOW)


def test_setup_real_is_idempotent_and_refuses_a_demo_database(tmp_path, real_db, seeded, db_url):
    assert setup_real(real_db, now=NOW) == "The real database is already set up. Nothing was changed."
    from app.seed.guards import SeedRefused
    with pytest.raises(SeedRefused, match="data_kind='demo'"):
        setup_real(db_url, now=NOW)
