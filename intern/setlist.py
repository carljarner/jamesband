"""Reading the band's Google Docs (the lyrics import, see lyrics_import.py)
through their public export endpoint (docs.google.com/.../export?format=...)
rather than the Drive API, so no OAuth/service-account credentials are
needed -- this only works as long as the doc's sharing settings allow
viewers to download/copy/print, which is also a requirement for the Drive
API approach.

Lyrics used to come from a "master songbook" doc synced here as a PDF; they
are written in the app now (lyrics.py).
"""

import re

import requests

DOC_ID_RE = re.compile(r"/d/([a-zA-Z0-9_-]+)")
EXPORT_URL = "https://docs.google.com/document/d/{doc_id}/export?format={fmt}"


class SyncError(Exception):
    """Raised when a doc can't be fetched."""


def extract_doc_id(url_or_id: str) -> str:
    url_or_id = url_or_id.strip()
    match = DOC_ID_RE.search(url_or_id)
    if match:
        return match.group(1)
    if "/" in url_or_id or "." in url_or_id:
        raise SyncError("Couldn't find a document ID in that link.")
    return url_or_id


def fetch_doc_export(doc_id: str, fmt: str) -> bytes:
    """The doc exported as `fmt` ("pdf", "html", ...) through its public
    export link. Raises SyncError when Google refuses or the link is wrong."""
    try:
        resp = requests.get(EXPORT_URL.format(doc_id=doc_id, fmt=fmt), timeout=30)
    except requests.RequestException as exc:
        raise SyncError(f"Couldn't reach Google Docs: {exc}") from exc

    if resp.status_code == 403:
        raise SyncError(
            "Google Docs refused the export (403). Make sure the doc's "
            "sharing settings allow viewers to download/copy/print."
        )
    looks_right = resp.content.startswith(b"%PDF") if fmt == "pdf" else b"<html" in resp.content[:2000].lower()
    if resp.status_code != 200 or not looks_right:
        raise SyncError(
            f"Export failed (status {resp.status_code}). Check the link is "
            "correct and set to 'Anyone with the link can view'."
        )
    return resp.content
