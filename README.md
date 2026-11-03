# IEE

Internal sales and operations system for Grasshoppers and Team Up.
- `backend/`: FastAPI, SQLAlchemy and Alembic. See `backend/README.md`.
- `frontend/`: React and Vite. See `frontend/README.md`.
- `contracts/`: the shared rule scenarios, checked by both test suites.

## Start everything (development, Windows)

One-time setup: create the backend environment (see `backend/README.md`, Setup) and run `npm install` in `frontend/`.

Then, from this folder:

```
./start-dev.ps1              # migrate, mark demo + seed (first run only), backend + frontend
./start-dev.ps1 -ResetDemo   # same, but rebuild the demo database from scratch first
```

Open http://127.0.0.1:5173. The script:
1. migrates the database;
2. marks it as a demo database and loads the demo data. This happens on the first run only; later runs keep your changes.
3. starts the backend on http://127.0.0.1:8000 in its own window, with the development identity on;
4. starts the frontend in API mode in the current window.

Or, as two commands in two terminals:

```
# 1. backend (from backend/)
$env:EVENTFLOW_ENV='development'; $env:EVENTFLOW_DEV_IDENTITY='true'
.venv\Scripts\python -m alembic upgrade head
.venv\Scripts\python -m app.seed mark-demo; .venv\Scripts\python -m app.seed demo   # first run only
.venv\Scripts\python -m app.serve

# 2. frontend (from frontend/)
npm run dev -- --host 127.0.0.1
```

## Data source

`VITE_DATA_SOURCE` chooses where the screens get their data:

| Value | Meaning |
|---|---|
| `api` | The default for `npm run dev`. The tracker, request pages, actions and the request form use the backend, so changes survive a reload. |
| `demo` | The in-memory demo store, with no backend needed (`$env:VITE_DATA_SOURCE='demo'; npm run dev`). Changes reset on reload. |

In API mode every page uses live data from the backend, except tasks. Tasks are not built yet: they show sample data, labelled as such, and the Tasks page is a preview.

The **"Development identity — not a login"** switcher chooses which team member and role the requests are sent as. This is not authentication.

## Required before go-live

These are not done yet, on purpose:
- **Real authentication** to replace the development identity (`backend/app/identity.py`).
- **Virus scanning of uploaded proposal files.** Uploads are currently checked for real file type (PDF/PPTX) and size (25 MB) only. *(Decision 6, Phase 4A.)*
- PostgreSQL deployment, with file storage moved to cloud storage behind `backend/app/storage.py`.
