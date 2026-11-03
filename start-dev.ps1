# EventFlow development start (Windows PowerShell).
#
#   ./start-dev.ps1                       the REAL data (backend/eventflow-real.db), the default
#   ./start-dev.ps1 -Data demo            the demo data (backend/eventflow.db), for presentations
#   ./start-dev.ps1 -Data present         a fresh COPY of the real data (backend/eventflow-present.db); the
#                                         real file is only read; the header says "Presentation copy"
#   ./start-dev.ps1 -Data test            your persistent TEST copy (backend/eventflow-test.db): made once from the
#                                         real data (read-only), then REUSED so your work stays; "Test copy"
#   ./start-dev.ps1 -Data test -Fresh     replace the test copy with a new one first
#   ./start-dev.ps1 -Data demo -ResetDemo rebuild the demo database from scratch first (deletes all demo data)
#
# Real data: the first run sets the database up (the team's accounts and routing, no clients);
# clients and requests come from the 2026 tracker:  python -m app.import_tracker <file> [--apply]
# The demo seed never runs against the real database, and the two never mix (separate files and
# file folders). Both stay on this laptop: the backend only listens on 127.0.0.1.
#
# Backend:  FastAPI on http://127.0.0.1:8000 (development identity ON, loopback only), in its own window.
# Frontend: Vite on http://127.0.0.1:5173 in this window, in API mode; /api is proxied to the backend.
# Stop: close the backend window, and Ctrl+C here.
param(
    [ValidateSet('real', 'demo', 'present', 'test')][string]$Data = 'real',
    [switch]$ResetDemo,
    [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$python = Join-Path $backend '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { throw "Backend virtual environment not found. See backend/README.md (Setup)." }
if ($ResetDemo -and $Data -ne 'demo') { throw '-ResetDemo only works with -Data demo (the real data is never reset).' }
if ($Fresh -and $Data -ne 'test') { throw '-Fresh only works with -Data test.' }

$env:EVENTFLOW_ENV = 'development'
$env:EVENTFLOW_DEV_IDENTITY = 'true'
$env:EVENTFLOW_PRESENTATION = ''
$env:EVENTFLOW_TEST_COPY = ''
if ($Data -eq 'test') {
    # The persistent test copy (the real file is only read, and only when the copy is first made).
    $env:DATABASE_URL = 'sqlite:///' + ((Join-Path $backend 'eventflow-test.db') -replace '\\', '/')
    $env:EVENTFLOW_FILES_DIR = Join-Path $backend 'storage\proposal-files-test'
    $env:EVENTFLOW_TEST_COPY = 'true'
} elseif ($Data -eq 'present') {
    # A fresh COPY of the real data (the real file is only read); the header says "Presentation copy".
    $env:DATABASE_URL = 'sqlite:///' + ((Join-Path $backend 'eventflow-present.db') -replace '\\', '/')
    $env:EVENTFLOW_FILES_DIR = Join-Path $backend 'storage\proposal-files-present'
    $env:EVENTFLOW_PRESENTATION = 'true'
} elseif ($Data -eq 'real') {
    $env:DATABASE_URL = 'sqlite:///' + ((Join-Path $backend 'eventflow-real.db') -replace '\\', '/')
    $env:EVENTFLOW_FILES_DIR = Join-Path $backend 'storage\proposal-files-real'
} else {
    $env:DATABASE_URL = 'sqlite:///' + ((Join-Path $backend 'eventflow.db') -replace '\\', '/')
    $env:EVENTFLOW_FILES_DIR = Join-Path $backend 'storage\proposal-files'
}
Write-Host "Data: $Data ($($env:DATABASE_URL))"

Push-Location $backend
try {
    if ($Data -eq 'test') {
        Write-Host '1/3 Test copy: reuse it (or make it once from the real data) and migrate it...'
        if ($Fresh) { & $python -m app.test_copy --fresh } else { & $python -m app.test_copy }
        if ($LASTEXITCODE -ne 0) { throw 'Preparing the test copy failed.' }
    } elseif ($Data -eq 'present') {
        Write-Host '1/3 Presentation copy: copy the real data (read-only) and migrate the copy...'
        & $python -m app.present_copy
        if ($LASTEXITCODE -ne 0) { throw 'Making the presentation copy failed.' }
    } elseif ($Data -eq 'real') {
        Write-Host '1/3 Real database: migrate (and set up on the first run)...'
        & $python -m app.setup_real
        if ($LASTEXITCODE -ne 0) { throw 'Real database setup failed.' }
    } else {
        Write-Host '1/3 Migrating the demo database...'
        & $python -m alembic upgrade head
        if ($LASTEXITCODE -ne 0) { throw 'Migration failed.' }
        if ($ResetDemo) {
            Write-Host '    Rebuilding the demo database...'
            & $python -m app.seed reset-demo --yes
            if ($LASTEXITCODE -ne 0) { throw 'reset-demo failed.' }
        } else {
            Write-Host '    Demo data (first run only; later runs keep your changes)...'
            & $python -m app.seed mark-demo 2>&1 | Out-Host   # refuses harmlessly if already marked
            & $python -m app.seed demo 2>&1 | Out-Host        # refuses harmlessly if data is already there
        }
    }
} finally {
    Pop-Location
}

Write-Host '2/3 Starting the backend in a new window (http://127.0.0.1:8000)...'
Start-Process powershell -WorkingDirectory $backend -ArgumentList @(
    '-NoExit', '-Command',
    "`$env:EVENTFLOW_ENV='development'; `$env:EVENTFLOW_DEV_IDENTITY='true'; `$env:DATABASE_URL='$($env:DATABASE_URL)'; `$env:EVENTFLOW_FILES_DIR='$($env:EVENTFLOW_FILES_DIR)'; `$env:EVENTFLOW_PRESENTATION='$($env:EVENTFLOW_PRESENTATION)'; `$env:EVENTFLOW_TEST_COPY='$($env:EVENTFLOW_TEST_COPY)'; & '$python' -m app.serve"
)

Write-Host '3/3 Starting the frontend (http://127.0.0.1:5173, API mode)...'
Push-Location $frontend
try {
    if (-not (Test-Path 'node_modules')) { npm install }
    $env:VITE_DATA_SOURCE = 'api'
    npm run dev  # host and port are set in vite.config.js
} finally {
    Pop-Location
}
