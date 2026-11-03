"""Helpers for the write-endpoint tests (seeded demo database, real Africa/Cairo 'today')."""

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

CAIRO = ZoneInfo("Africa/Cairo")


def today() -> date:
    return datetime.now(timezone.utc).astimezone(CAIRO).date()


def future(days: int) -> str:
    return (today() + timedelta(days=days)).isoformat()


def future_month(months_ahead: int) -> str:
    d = today().replace(day=1)
    month = d.month - 1 + months_ahead
    return f"{d.year + month // 12:04d}-{month % 12 + 1:02d}"


def cl(n: int) -> str:
    """Seeded client id: frontend c-01..c-12 are CL-0001..CL-0012 on the server."""
    return f"CL-{n:04d}"


def row_version(api, rid: str, headers) -> int:
    r = api.get(f"/api/proposal-requests/{rid}", headers=headers)
    return r.json()["rowVersion"] if r.status_code == 200 else 1


def act(api, rid: str, action: str, headers, **inputs):
    """POST an action with the request's current rowVersion as this viewer sees it."""
    body = {"action": action, "expectedRowVersion": row_version(api, rid, headers), **inputs}
    return api.post(f"/api/proposal-requests/{rid}/actions", json=body, headers=headers)


def ok(response):
    assert response.status_code in (200, 201), response.text
    return response.json()


def create(api, headers, submit: bool = False, **fields):
    return api.post("/api/proposal-requests", json={**fields, "submit": submit}, headers=headers)


def edit(api, rid: str, headers, submit: bool = False, version: int | None = None, **fields):
    body = {**fields, "submit": submit,
            "expectedRowVersion": version if version is not None else row_version(api, rid, headers)}
    return api.patch(f"/api/proposal-requests/{rid}", json=body, headers=headers)


def detail(api, rid: str, headers):
    r = api.get(f"/api/proposal-requests/{rid}", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def opportunity(api, opp_id: str, headers):
    return api.get(f"/api/opportunities/{opp_id}", headers=headers).json()


def error(response) -> dict:
    return response.json()["error"]


# ---------- proposal files ----------

def sample_pdf(label: str = "test") -> bytes:
    from app.seed.requests import placeholder_pdf
    return placeholder_pdf(label, 1)


def sample_pptx() -> bytes:
    """A minimal PowerPoint package: the parts the server checks for."""
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Override PartName="/ppt/presentation.xml" ContentType="application/'
                   'vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
        z.writestr("ppt/presentation.xml", "<p:presentation/>")
    return buf.getvalue()


def upload(api, rid: str, headers, data: bytes | None = None, name: str = "Proposal.pdf", version: int | None = None,
           content_type: str = "application/octet-stream"):
    """POST the proposal file (raw body; name in X-File-Name, URL-encoded)."""
    from urllib.parse import quote
    v = version if version is not None else row_version(api, rid, headers)
    return api.post(f"/api/proposal-requests/{rid}/files", params={"expectedRowVersion": v},
                    content=sample_pdf(rid) if data is None else data,
                    headers={**headers, "X-File-Name": quote(name), "Content-Type": content_type})
