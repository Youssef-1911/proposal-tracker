import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import make_engine, make_sessionmaker
from .errors import install_error_handlers
from .migrations_check import check_schema
from .routers import (
    accounts, analytics, clients, events, meta, notifications, opportunities, proposal_requests, radar, screen, staffing, todos,
)
from .settings import Settings, load_settings
from .storage import FileStorage, LocalFileStorage

log = logging.getLogger("eventflow")


def create_app(settings: Settings | None = None, *, engine=None, check_db_schema: bool = True,
               storage: FileStorage | None = None) -> FastAPI:
    """
    Builds the API. Invalid or unsafe settings (e.g. the development identity outside
    development) raise SettingsError here, so the server refuses to start.
    """
    settings = (settings or load_settings()).validate()
    engine = engine or make_engine(settings.database_url)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if check_db_schema:
            check_schema(engine, settings.database_url)  # refuses to start on an unmigrated DB
        if settings.dev_identity_active:
            log.warning(
                "DEVELOPMENT IDENTITY IS ON: callers identify themselves with X-Dev-User / X-Dev-Role. "
                "This is not authentication. Never expose this server beyond 127.0.0.1."
            )
        yield

    app = FastAPI(title="EventFlow API", version="0.4.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.engine = engine
    app.state.sessionmaker = make_sessionmaker(engine)
    app.state.storage = storage or LocalFileStorage(settings.files_dir)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],  # Vite dev server
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["Content-Type", "X-Dev-User", "X-Dev-Role", "X-File-Name"],
        expose_headers=["Content-Disposition"],
    )
    install_error_handlers(app)
    app.include_router(meta.router)
    app.include_router(staffing.router)
    app.include_router(radar.router)
    app.include_router(screen.router)
    app.include_router(clients.router)
    app.include_router(opportunities.router)
    app.include_router(proposal_requests.router)
    app.include_router(accounts.router)
    app.include_router(analytics.router)
    app.include_router(notifications.router)
    app.include_router(events.router)
    app.include_router(todos.router)
    return app


# Module-level app for `uvicorn app.main:app`. Settings come from the environment.
app = create_app()
