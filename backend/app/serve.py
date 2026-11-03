"""
Run the API:  python -m app.serve

Binds to EVENTFLOW_HOST (default 127.0.0.1). With the development identity enabled,
settings validation refuses any non-loopback host.
"""

import os

import uvicorn

from .settings import load_settings


def main() -> None:
    settings = load_settings()  # raises SettingsError on unsafe configuration
    uvicorn.run("app.main:app", host=settings.host, port=int(os.environ.get("EVENTFLOW_PORT", "8000")))


if __name__ == "__main__":
    main()
