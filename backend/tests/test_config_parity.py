"""
The frontend is the behavioural reference. These tests run the (unchanged) frontend
domain modules and seed with Node and compare them with what the API serves.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from .conftest import NOHA

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None or not FRONTEND.exists(), reason="Node.js and the frontend are required")

DUMP = r"""
const root = process.argv[1];
const load = (p) => import(new URL(p, 'file:///' + root.replace(/\\/g, '/') + '/'));
const { BRANDS } = await load('src/domain/brands.js');
const { BRAND_AM_ROUTING } = await load('src/domain/routing.js');
const { ROLE_CONFIG } = await load('src/domain/roles.js');
const { LOST_REASONS, SHARE_CHANNELS, STATUS_CONFIG, stageList, statusList } = await load('src/domain/status.js');
const { CLIENT_TYPES } = await load('src/domain/catalog.js');
const PF = await load('src/domain/proposalFiles.js');
const { createDemoData } = await load('src/demo/seed.js');
const d = createDemoData();
console.log(JSON.stringify({
  brands: BRANDS.map((b) => ({ id: b.id, name: b.name, services: b.services })),
  routing: BRAND_AM_ROUTING,
  roles: Object.entries(ROLE_CONFIG).map(([id, r]) => ({ id, label: r.label })),
  proposalStatuses: statusList('proposal').map((s) => ({ id: s.id, label: s.label, order: s.order, closed: s.closed, waitingOn: s.waitingOn, deadlinePending: s.deadlinePending, stage: s.stage, subLabel: s.subLabel ?? null })),
  proposalStages: stageList().map((s) => ({ id: s.id, label: s.label, order: s.order, tone: s.tone ?? null })),
  lostReasons: LOST_REASONS,
  shareChannels: SHARE_CHANNELS,
  proposalFiles: { types: PF.PROPOSAL_FILE_TYPES, maxBytes: PF.PROPOSAL_FILE_MAX_BYTES, uploadStatuses: PF.UPLOAD_STATUSES },
  commentMaxLength: PF.COMMENT_MAX_LENGTH,
  opportunityStages: statusList('opportunity').map((s) => ({ id: s.id, label: s.label, order: s.order, closed: s.closed, outcome: s.outcome ?? null })),
  clientTypes: Object.entries(CLIENT_TYPES).map(([id, t]) => ({ id, label: t.label })),
  seed: { users: d.users, clients: d.clients, opportunities: d.opportunities },
}));
"""


@pytest.fixture(scope="module")
def frontend():
    result = subprocess.run([NODE, "--input-type=module", "-e", DUMP, str(FRONTEND)],
                            capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_config_matches_frontend_brands_services_routing_roles_statuses(api, frontend):
    config = api.get("/api/config", headers=NOHA).json()
    assert config["brands"] == frontend["brands"]
    assert config["routing"] == frontend["routing"]
    assert config["roles"] == frontend["roles"]
    assert config["proposalStatuses"] == frontend["proposalStatuses"]
    assert config["proposalStages"] == frontend["proposalStages"]
    assert config["lostReasons"] == frontend["lostReasons"]
    assert config["shareChannels"] == frontend["shareChannels"]
    assert config["proposalFiles"] == frontend["proposalFiles"]
    assert config["commentMaxLength"] == frontend["commentMaxLength"]
    assert config["opportunityStages"] == frontend["opportunityStages"]
    assert config["clientTypes"] == frontend["clientTypes"]
    assert config["businessTimezone"] == "Africa/Cairo" and config["currency"] == "EGP"


def test_seeded_users_match_frontend(api, frontend):
    api_users = {u["id"]: u for u in api.get("/api/users", headers=NOHA).json()["items"]}
    for fu in frontend["seed"]["users"]:
        au = api_users[fu["id"]]
        assert (au["name"], au["initials"], au["avatarTone"], au["brand"], au["roles"]) == (
            fu["name"], fu["initials"], fu["avatarTone"], fu["brand"], fu["roles"]), fu["id"]
    assert len(api_users) == len(frontend["seed"]["users"])


def client_id_map(frontend):
    """Frontend demo ids c-01..c-12 become server ids CL-0001..CL-0012 in the same order."""
    return {c["id"]: f"CL-{i:04d}" for i, c in enumerate(frontend["seed"]["clients"], start=1)}


def test_seeded_clients_match_frontend(api, frontend):
    ids = client_id_map(frontend)
    api_clients = {c["id"]: c for c in api.get("/api/clients", headers=NOHA).json()["items"]}
    for fc in frontend["seed"]["clients"]:
        ac = api_clients[ids[fc["id"]]]
        assert (ac["name"], ac["type"], ac["brands"], ac["city"], ac["owner"], ac["contact"]) == (
            fc["name"], fc["type"], fc["brands"], fc["city"], fc["owner"], fc["contact"]), fc["id"]


def test_seeded_opportunities_match_frontend(api, frontend):
    ids = client_id_map(frontend)
    api_opps = {o["id"]: o for o in api.get("/api/opportunities", headers=NOHA).json()["items"]}
    for fo in frontend["seed"]["opportunities"]:
        ao = api_opps[fo["id"]]
        precision = "month" if len(fo["eventDate"] or "") == 7 else "day"
        assert (ao["clientId"], ao["brand"], ao["service"], ao["owner"], ao["stage"], ao["estimatedValue"],
                ao["participants"], ao["eventDatePrecision"], ao["eventDate"], ao["nextAction"], ao["nextActionDate"]) == (
            ids[fo["clientId"]], fo["brand"], fo["service"], fo["owner"], fo["stage"], fo["estimatedValue"],
            fo["participants"], precision, fo["eventDate"], fo["nextAction"], fo["nextActionDate"]), fo["id"]
        assert ao["lostReason"] == fo.get("lostReason"), fo["id"]
    assert len(api_opps) == len(frontend["seed"]["opportunities"])


REQUEST_DUMP = r"""
const root = process.argv[1];
const load = (p) => import(new URL(p, 'file:///' + root.replace(/\\/g, '/') + '/'));
const { createDemoData } = await load('src/demo/seed.js');
console.log(JSON.stringify(createDemoData().proposalRequests));
"""


@pytest.fixture(scope="module")
def frontend_requests():
    result = subprocess.run([NODE, "--input-type=module", "-e", REQUEST_DUMP, str(FRONTEND)],
                            capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def close_in_time(a: str | None, b: str | None, minutes: int = 10) -> bool:
    """Seed timestamps are 'N days ago at HH:MM'; only ones clamped to 'now - 15 min' depend on run time."""
    if a is None or b is None:
        return a is b
    from datetime import datetime
    ta, tb = (datetime.fromisoformat(x.replace("Z", "+00:00")) for x in (a, b))
    return abs((ta - tb).total_seconds()) <= minutes * 60


def test_seeded_proposal_requests_match_frontend_one_to_one(api, frontend_requests):
    """Decision 5: same IDs, statuses, owners, histories, versions and prices as the frontend demo."""
    ids = {f"c-{i:02d}": f"CL-{i:04d}" for i in range(1, 13)}
    assert len(frontend_requests) == 19
    for fr in frontend_requests:
        d = api.get(f"/api/proposal-requests/{fr['id']}", headers={"X-Dev-User": fr["createdBy"], "X-Dev-Role":
                    "commercial_head" if fr["createdBy"] == "u-noha" else "business_development"}).json()
        same = ("id", "opportunityId", "brand", "service", "bdOwner", "createdBy", "assignedAM", "submittedBy",
                "status", "requiredBy", "eventDate", "eventDatePrecision", "participants", "requirementsSummary",
                "specificRequirements", "amPrice", "version", "priceChange")
        assert {k: d[k] for k in same} == {k: fr.get(k) for k in same}, fr["id"]
        assert d["clientId"] == ids[fr["clientId"]], fr["id"]
        assert close_in_time(d["lastUpdated"], fr["lastUpdated"]) and close_in_time(d["submittedAt"], fr["submittedAt"])
        assert len(d["history"]) == len(fr["statusHistory"]), fr["id"]
        for he, fe in zip(d["history"], fr["statusHistory"]):
            assert (he["status"], he["changedBy"], he["role"], he["note"], he["version"], he["onBehalfOf"]) == (
                fe["status"], fe["changedBy"], fe["role"], fe.get("note"), fe["version"], fe.get("onBehalfOf")), fr["id"]
            assert he["amPrice"] == fe.get("amPrice"), fr["id"]
            assert (he["lostReason"], he["channel"]) == (fe.get("lostReason"), fe.get("channel")), fr["id"]
            assert close_in_time(he["changedAt"], fe["changedAt"]), (fr["id"], he["status"])
        # Demo proposal files: same versions, names, uploader and time (the backend also stores the bytes).
        assert [(f["version"], f["fileType"], f["originalName"], f["uploadedBy"]) for f in d["files"]] == [
            (f["version"], f["fileType"], f["originalName"], f["uploadedBy"]) for f in fr["files"]], fr["id"]
        assert all(close_in_time(a["uploadedAt"], b["uploadedAt"]) for a, b in zip(d["files"], fr["files"]))
    assert sum(len(fr["files"]) for fr in frontend_requests) == 11
    assert [e.get("lostReason") for fr in frontend_requests for e in fr["statusHistory"] if e["status"] == "rejected"] == [
        "price", "competitor"], "decision 3: realistic lost reasons in the demo"
