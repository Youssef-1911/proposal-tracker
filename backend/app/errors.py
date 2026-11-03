"""
One error format for every API response:

    {"error": {"code": "...", "message": "...", "fields": {"field": "message"}}}

401 no identity · 403 not allowed (with reason) · 404 not found (also used for anything
the caller may not see) · 409 stale data or not allowed at the current status ·
422 field validation.
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.orm.exc import StaleDataError
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, fields: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.fields = fields or None


def unauthenticated(message: str) -> ApiError:
    return ApiError(401, "unauthenticated", message)


def forbidden(message: str) -> ApiError:
    return ApiError(403, "forbidden", message)


def not_found(message: str = "Not found.") -> ApiError:
    return ApiError(404, "not_found", message)


def conflict(message: str, code: str = "conflict") -> ApiError:
    return ApiError(409, code, message)


STALE_MESSAGE = "This request was changed by someone else. Reload it and try again."


def stale(message: str = STALE_MESSAGE) -> ApiError:
    return ApiError(409, "stale", message)


def validation(message: str, fields: dict) -> ApiError:
    return ApiError(422, "validation_error", message, fields)


def _body(code: str, message: str, fields: dict | None = None) -> dict:
    error = {"code": code, "message": message}
    if fields:
        error["fields"] = fields
    return {"error": error}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return JSONResponse(status_code=exc.status, content=_body(exc.code, exc.message, exc.fields))

    @app.exception_handler(StaleDataError)
    async def _stale(_: Request, exc: StaleDataError):
        # A row_version check failed at write time: someone else saved in between.
        return JSONResponse(status_code=409, content=_body("stale", "This record was changed by someone else. Reload it and try again."))

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        fields = {}
        for err in exc.errors():
            loc = [str(p) for p in err.get("loc", ()) if p not in ("body", "query", "path", "header")]
            fields[".".join(loc) or "request"] = err.get("msg", "Invalid value.")
        return JSONResponse(status_code=422, content=_body("validation_error", "Please fix the highlighted fields.", fields))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, f"http_{exc.status_code}")
        message = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return JSONResponse(status_code=exc.status_code, content=_body(code, message))
