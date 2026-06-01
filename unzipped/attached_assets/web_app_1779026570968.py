"""Cloud/web entrypoint for the Live Soccer Probability Dashboard.

Run locally:
    python web_app.py

On Render/Railway/Fly/other hosts, set environment variables in the host dashboard:
    API_FOOTBALL_KEY, ODDS_API_KEY, FOOTBALL_SEASON, REFRESH_SECONDS, MODE
"""
from __future__ import annotations

import os
import uvicorn

if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("app.main:app", host=host, port=port, reload=False, log_level="info")
