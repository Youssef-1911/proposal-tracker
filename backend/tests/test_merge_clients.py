"""
python -m app.merge_clients on a TEMPORARY real-kind database filled from the made-up workbook of
test_import_tracker (never the real file or database): dry run, apply in one transaction, history,
archiving (never deleting), and every refusal.
"""

import pytest
from sqlalchemy import func, select

from app.database import make_engine, make_sessionmaker
from app.import_tracker import run as import_run
from app.merge_clients import MergeRefused, run
from app.models import Client, ClientContact, ClientHistory, Opportunity, ProposalRequest, RequestEvent, User
from app.setup_real import setup_real

from .conftest import sqlite_url
from .test_import_tracker import NOW, workbook


@pytest.fixture
def db_url(tmp_path):
    url = sqlite_url(tmp_path / "merge.db")
    setup_real(url, now=NOW)
    import_run(workbook(tmp_path / "t.xlsx"), database_url=url, apply=True, now=NOW)
    engine = make_engine(url)
    with make_sessionmaker(engine)() as db:  # a contact on one of the clients to merge
        delta = db.scalars(select(Client).where(Client.name == "Delta Ventures")).one()
        db.add(ClientContact(client_id=delta.id, name="Rana", phone="0100 000 0000", is_primary=True,
                             created_at=NOW, updated_at=NOW, row_version=1))
        db.commit()
    engine.dispose()
    return url


def session(url):
    engine = make_engine(url)
    return engine, make_sessionmaker(engine)()


def snapshot(url):
    engine, db = session(url)
    out = {m.__tablename__: db.scalar(select(func.count()).select_from(m))
           for m in (Client, ClientContact, ClientHistory, Opportunity, ProposalRequest, RequestEvent)}
    out["clients"] = sorted((c.id, c.client_type, str(c.archived_at)) for c in db.scalars(select(Client)))
    out["requests"] = sorted((r.id, r.client_id, r.event_name) for r in db.scalars(select(ProposalRequest)))
    db.close()
    engine.dispose()
    return out


NAMES = ["Delta Ventures=Town Hall 2026", "Odd Dates Ltd=Giveaways"]


def test_dry_run_lists_everything_and_changes_nothing(db_url):
    before = snapshot(db_url)
    text = run("acme co.", ["Delta Ventures", "Odd Dates Ltd"], database_url=db_url, event_names=NAMES, now=NOW)
    assert snapshot(db_url) == before
    assert "Merge into: ACME co." in text
    assert "Requests to move: 2" in text and "Opportunities to move: 2" in text
    assert '"Town Hall" -> "Town Hall 2026"' in text
    assert "Contacts to move: 1" in text and "Rana (main contact)" in text
    assert "client entries (stay on the archived clients)" in text
    assert "Dry run: nothing was changed." in text


def test_apply_moves_records_history_and_archives_never_deletes(db_url):
    before = snapshot(db_url)
    text = run("ACME co.", ["Delta Ventures", "Odd Dates Ltd"], database_url=db_url, event_names=NAMES, apply=True, now=NOW)
    assert "APPLIED in one transaction." in text
    after = snapshot(db_url)
    assert after["clients"].__len__() == before["clients"].__len__(), "no client deleted"
    engine, db = session(db_url)
    acme = db.scalars(select(Client).where(Client.name == "ACME co.")).one()
    moved = db.scalars(select(ProposalRequest).where(ProposalRequest.import_row.in_([6, 9]))).all()
    assert {r.client_id for r in moved} == {acme.id}
    assert {r.import_row: r.event_name for r in moved} == {6: "Town Hall 2026", 9: "Giveaways"}
    assert {o.client_id for o in db.scalars(select(Opportunity).where(Opportunity.id.in_([r.opportunity_id for r in moved])))} == {acme.id}
    assert {o.event_name for o in db.scalars(select(Opportunity).where(Opportunity.id.in_([r.opportunity_id for r in moved])))} == {
        "Town Hall 2026", "Giveaways"}
    rana = db.scalars(select(ClientContact).where(ClientContact.name == "Rana")).one()
    assert rana.client_id == acme.id
    events = db.scalars(select(RequestEvent).where(RequestEvent.event == "client_merged")).all()
    assert sorted(e.note for e in events) == [
        "Client changed from Delta Ventures to ACME co. — merged by Noha El Kenawy",
        "Client changed from Odd Dates Ltd to ACME co. — merged by Noha El Kenawy"]
    merged = db.scalars(select(ClientHistory).where(ClientHistory.event == "clients_merged")).one()
    assert merged.client_id == acme.id and [m["name"] for m in merged.details["mergedFrom"]] == ["Delta Ventures", "Odd Dates Ltd"]
    for name in ("Delta Ventures", "Odd Dates Ltd"):
        c = db.scalars(select(Client).where(Client.name == name)).one()
        assert c.archived_at is not None
        assert c.history[-1].event == "archived" and c.history[-1].reason == "Merged into ACME co."
        assert c.history[0].event == "created", "earlier history stays on the archived client"
    db.close()
    engine.dispose()


@pytest.mark.parametrize("target, sources, message", [
    ("ACME co.", ["ACME co."], "cannot be merged into itself"),
    ("ACME co.", ["Blue Bank"], "Add the brand to the client first"),  # a Grasshoppers request into a Team Up client
    ("Nobody Inc", ["Blue Bank"], 'No client "Nobody Inc"'),
    ("ACME co.", ["Delta Ventures", "Delta Ventures"], "listed twice"),
])
def test_refusals_change_nothing(db_url, target, sources, message):
    before = snapshot(db_url)
    with pytest.raises(MergeRefused, match=message):
        run(target, sources, database_url=db_url, apply=True, now=NOW)
    assert snapshot(db_url) == before


def test_refuses_an_archived_client_and_an_owner_who_cannot_own_clients(db_url):
    run("ACME co.", ["Delta Ventures"], database_url=db_url, apply=True, now=NOW)
    with pytest.raises(MergeRefused, match="archived; choose an active client"):
        run("Delta Ventures", ["Odd Dates Ltd"], database_url=db_url, apply=True, now=NOW)
    with pytest.raises(MergeRefused, match="is archived already"):
        run("ACME co.", ["Delta Ventures"], database_url=db_url, apply=True, now=NOW)
    engine, db = session(db_url)
    acme = db.scalars(select(Client).where(Client.name == "ACME co.")).one()
    db.get(User, acme.owner_id).active = False
    db.commit()
    db.close()
    engine.dispose()
    with pytest.raises(MergeRefused, match="can no longer own clients"):
        run("ACME co.", ["Odd Dates Ltd"], database_url=db_url, apply=True, now=NOW)


def test_event_name_rules(db_url):
    with pytest.raises(MergeRefused, match="longer than 80"):
        run("ACME co.", ["Delta Ventures"], database_url=db_url, event_names=["Delta Ventures=" + "x" * 81], now=NOW)
    with pytest.raises(MergeRefused, match="neither a client being merged"):
        run("ACME co.", ["Delta Ventures"], database_url=db_url, event_names=["Blue Bank=Gala"], now=NOW)
    with pytest.raises(MergeRefused, match="needs"):
        run("ACME co.", ["Delta Ventures"], database_url=db_url, event_names=["Delta Ventures"], now=NOW)
