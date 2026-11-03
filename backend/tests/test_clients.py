"""
Client read endpoints. Rewritten for the new schema; covers what the old tests covered
(list, search, validation, not-found, no unintended writes) with stronger assertions.
"""

import re

import pytest

from .conftest import AHMED, MD_AM, MK_AM, MK_BD, NOHA, SHERINE


def items(response):
    assert response.status_code == 200, response.text
    return response.json()["items"]


def test_list_clients_server_generated_ids_and_shape(api):
    body = api.get("/api/clients", headers=NOHA).json()
    assert body["total"] == 12
    ids = [c["id"] for c in body["items"]]
    assert all(re.fullmatch(r"CL-\d{4}", i) for i in ids)
    assert sorted(ids) == [f"CL-{n:04d}" for n in range(1, 13)]
    names = [c["name"] for c in body["items"]]
    assert names == sorted(names), "sorted by name"
    harbor = next(c for c in body["items"] if c["name"] == "Harbor Line Logistics")
    assert harbor == {
        **harbor,
        "type": "corporate", "brands": ["teamup"], "city": "Alexandria", "owner": "u-ahmed",
        "contact": {"name": "Tarek Mansour", "title": "HR Director", "phone": "+20 100 555 0108",
                    "email": "t.mansour@harborline.example"},
        "archivedAt": None, "rowVersion": 1,
    }
    assert harbor["createdAt"].endswith("Z"), "timestamps are UTC"


def test_search_is_case_insensitive(api):
    assert [c["name"] for c in items(api.get("/api/clients", params={"q": "HARBOR"}, headers=NOHA))] == ["Harbor Line Logistics"]
    assert len(items(api.get("/api/clients", params={"q": "school"}, headers=NOHA))) == 5  # "…School" in the name
    assert items(api.get("/api/clients", params={"q": "zzz"}, headers=NOHA)) == []


def test_filters_type_owner_brand(api):
    assert {c["type"] for c in items(api.get("/api/clients", params={"type": "agency"}, headers=NOHA))} == {"agency"}
    assert {c["owner"] for c in items(api.get("/api/clients", params={"owner": "u-sherine"}, headers=NOHA))} == {"u-sherine"}
    both = items(api.get("/api/clients", params={"brand": "teamup"}, headers=NOHA))
    assert all("teamup" in c["brands"] for c in both)
    assert "Medora Pharma" in {c["name"] for c in both}, "multi-brand clients match either brand"


@pytest.mark.parametrize("params,field", [({"type": "company"}, "type"), ({"brand": "acme"}, "brand")])
def test_invalid_filters_return_422_in_the_error_format(api, params, field):
    r = api.get("/api/clients", params=params, headers=NOHA)
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "validation_error" and field in err["fields"]


def test_creatable_clients_follow_the_frontend_rule(api):
    """BD: only clients they own · Commercial Head: all · AM: none (mirrors clientsForCreator)."""
    def creatable(headers):
        return {c["owner"] for c in items(api.get("/api/clients", params={"creatable": "true"}, headers=headers))}, \
            len(items(api.get("/api/clients", params={"creatable": "true"}, headers=headers)))

    assert creatable(AHMED) == ({"u-ahmed"}, 3)
    assert creatable(SHERINE) == ({"u-sherine"}, 3)
    assert creatable(MK_BD) == ({"u-mariam-elkhayat"}, 3)
    assert creatable(NOHA)[1] == 12
    assert creatable(MK_AM) == (set(), 0), "Mariam acting as AM cannot create requests"
    assert creatable(MD_AM) == (set(), 0)


def test_get_client_and_not_found(api):
    assert api.get("/api/clients/CL-0001", headers=AHMED).json()["name"] == "Crescent Valley International School"
    r = api.get("/api/clients/CL-9999", headers=AHMED)
    assert r.status_code == 404
    assert r.json() == {"error": {"code": "not_found", "message": "Client 'CL-9999' not found."}}


@pytest.mark.parametrize("method", ["post", "put", "delete"])
def test_no_put_delete_or_post_on_a_client(api, method):
    """CRM 1 edits a client with PATCH only; nothing replaces (PUT) or deletes it."""
    r = getattr(api, method)("/api/clients/CL-0001", headers=NOHA)
    assert r.status_code == 405
    assert r.json()["error"]["code"] == "method_not_allowed"
    assert api.get("/api/clients/CL-0001", headers=NOHA).json()["rowVersion"] == 1, "unchanged"


def test_archived_clients_are_hidden_unless_requested(api, session):
    from app.database import utcnow
    from app.models import Client
    c = session.get(Client, "CL-0002")
    c.archived_at = utcnow()
    session.commit()
    assert "CL-0002" not in {x["id"] for x in items(api.get("/api/clients", headers=NOHA))}
    assert "CL-0002" in {x["id"] for x in items(api.get("/api/clients", params={"includeArchived": "true"}, headers=NOHA))}
    assert api.get("/api/clients/CL-0002", headers=NOHA).json()["archivedAt"].endswith("Z"), "still readable, never deleted"
