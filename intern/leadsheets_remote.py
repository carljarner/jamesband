"""Reads lead sheets from leadsheets.dk, where new sheets are made. Its API
is read-only and token-protected; see the leadsheets repo's README.

LEADSHEETS_API_TOKEN must be one of leadsheets.dk's API_TOKEN values.
LEADSHEETS_API_URL is only set to point at a local copy while developing.
"""

import os
from urllib.parse import quote

import requests

API_URL = os.environ.get("LEADSHEETS_API_URL", "https://leadsheets.dk").rstrip("/")
API_TOKEN = os.environ.get("LEADSHEETS_API_TOKEN", "").strip()


class RemoteError(Exception):
    pass


class NotFound(RemoteError):
    pass


def _get(path: str):
    if not API_TOKEN:
        raise RemoteError("No LEADSHEETS_API_TOKEN is set, so leadsheets.dk can't be reached.")
    try:
        resp = requests.get(
            f"{API_URL}{path}",
            headers={"Authorization": f"Bearer {API_TOKEN}"},
            timeout=15,
        )
    except requests.RequestException:
        raise RemoteError("Couldn't reach leadsheets.dk. Try again in a moment.")
    if resp.status_code == 401:
        raise RemoteError("leadsheets.dk refused the API token (check LEADSHEETS_API_TOKEN).")
    if resp.status_code == 404:
        raise NotFound("This sheet no longer exists on leadsheets.dk.")
    if not resp.ok:
        raise RemoteError(f"leadsheets.dk answered with an error ({resp.status_code}).")
    try:
        return resp.json()
    except ValueError:
        raise RemoteError("leadsheets.dk sent something that isn't a lead sheet.")


def list_sheets() -> list[dict]:
    """[{id, title, artist, key, updated_at}] for every sheet on leadsheets.dk."""
    sheets = _get("/api/sheets")
    if not isinstance(sheets, list):
        raise RemoteError("leadsheets.dk sent something that isn't a list of lead sheets.")
    return sheets


def get_sheet(sheet_id: str) -> dict:
    sheet = _get(f"/api/sheets/{quote(sheet_id, safe='')}")
    if not isinstance(sheet, dict):
        raise RemoteError("leadsheets.dk sent something that isn't a lead sheet.")
    return sheet
